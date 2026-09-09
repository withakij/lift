/**
 * Scrape queue.
 *
 * Guarantees:
 *  - one URL failing never stops the run
 *  - progress is written to disk as each URL finishes, so closing the app mid
 *    run loses at most the URL currently in flight
 *  - a job left `running` by a crash is reopened as `paused` on next launch and
 *    can be resumed without re-scraping anything already completed
 *  - pause takes effect between URLs; in-flight work is allowed to finish so a
 *    half-parsed product is never stored
 */
import { EventEmitter } from 'node:events';
import type { Database } from '../db';
import { newId, nowIso } from '../db/store';
import type { JobProgressEvent, JobState, ScrapeJob, UrlEntry } from '../../shared/types';
import type { ScrapeEngine } from '../scraper/engine';
import { log } from '../util/logger';

export interface QueueDeps {
  db: Database;
  engine: ScrapeEngine;
}

export class ScrapeQueue extends EventEmitter {
  private current: ScrapeJob | null = null;
  private paused = false;
  private cancelled = false;
  private running = false;
  private currentTitle: string | null = null;
  private currentStage: string | null = null;

  constructor(private deps: QueueDeps) {
    super();
  }

  /** Reopens anything a crash left mid-flight. Called once at startup. */
  recover(): void {
    for (const job of this.deps.db.jobs.all()) {
      if (job.state === 'running') {
        this.deps.db.jobs.update(job.id, { state: 'paused', currentUrl: null, currentStage: null });
        log.info('queue', `Job "${job.label}" was interrupted and has been paused; it can be resumed.`);
      }
    }
    for (const url of this.deps.db.urls.all()) {
      if (url.state === 'processing' || url.state === 'retrying') {
        this.deps.db.setUrlState(url.id, 'pending', { startedAt: null });
      }
    }
  }

  isBusy(): boolean {
    return this.running;
  }

  activeProgress(): JobProgressEvent | null {
    if (!this.current) return null;
    return this.snapshot(this.current);
  }

  private snapshot(job: ScrapeJob): JobProgressEvent {
    return {
      jobId: job.id,
      projectId: job.projectId,
      state: this.paused && job.state === 'running' ? 'paused' : job.state,
      total: job.total,
      completed: job.completed,
      failed: job.failed,
      warned: job.warned,
      skipped: job.skipped,
      currentUrl: job.currentUrl,
      currentTitle: this.currentTitle,
      currentStage: this.currentStage
    };
  }

  private emitProgress(job: ScrapeJob, message?: string): void {
    const snap = this.snapshot(job);
    if (message) snap.message = message;
    this.emit('progress', snap);
  }

  /* ---------------- control ---------------- */

  createJob(input: { projectId: string; categoryIds?: string[]; urlIds?: string[]; label?: string }): ScrapeJob {
    const db = this.deps.db;
    let targets: UrlEntry[];
    if (input.urlIds?.length) {
      targets = input.urlIds.map((id) => db.urls.get(id)).filter((u): u is UrlEntry => !!u);
    } else if (input.categoryIds?.length) {
      targets = db.urls.find((u) => u.projectId === input.projectId && u.categoryId !== null && input.categoryIds!.includes(u.categoryId));
    } else {
      targets = db.urls.find((u) => u.projectId === input.projectId);
    }

    const pending = targets.filter((u) => u.state !== 'completed');
    for (const u of pending) db.setUrlState(u.id, 'pending', { lastError: null, lastErrorCode: null });

    const job: ScrapeJob = {
      id: newId('job_'),
      projectId: input.projectId,
      categoryIds: input.categoryIds ?? [],
      urlIds: pending.map((u) => u.id),
      state: 'queued',
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      total: pending.length,
      completed: 0,
      failed: 0,
      warned: 0,
      skipped: targets.length - pending.length,
      currentUrl: null,
      currentStage: null,
      label: input.label ?? labelFor(db, input)
    };
    db.jobs.insert(job);
    return job;
  }

  async start(job: ScrapeJob): Promise<void> {
    if (this.running) throw new Error('A scrape is already running. Pause or cancel it first.');
    this.current = job;
    this.paused = false;
    this.cancelled = false;
    this.running = true;
    this.deps.db.jobs.update(job.id, { state: 'running', startedAt: job.startedAt ?? nowIso() });
    job.state = 'running';
    this.emitProgress(job, `Starting ${job.total} URL${job.total === 1 ? '' : 's'}`);
    void this.loop(job);
  }

  pause(): void {
    if (!this.running) return;
    this.paused = true;
    if (this.current) {
      this.deps.db.jobs.update(this.current.id, { state: 'paused' });
      this.emitProgress(this.current, 'Pausing after the current product finishes…');
    }
  }

  async resume(): Promise<void> {
    if (this.running) {
      this.paused = false;
      if (this.current) {
        this.current.state = 'running';
        this.deps.db.jobs.update(this.current.id, { state: 'running' });
        this.emitProgress(this.current, 'Resumed');
      }
      return;
    }
    const paused = [...this.deps.db.jobs.all()].reverse().find((j) => j.state === 'paused');
    if (!paused) return;
    // Rebuild the remaining work from URL state, not from the old list, so
    // anything completed in between is not repeated.
    paused.urlIds = paused.urlIds.filter((id) => {
      const u = this.deps.db.urls.get(id);
      return u && u.state !== 'completed';
    });
    await this.start(paused);
  }

  cancel(): void {
    this.cancelled = true;
    this.paused = false;
    if (this.current) {
      this.deps.db.jobs.update(this.current.id, { state: 'cancelled', finishedAt: nowIso() });
      this.emitProgress(this.current, 'Cancelling…');
    }
  }

  /* ---------------- the loop ---------------- */

  private async loop(job: ScrapeJob): Promise<void> {
    const db = this.deps.db;
    const settings = db.getSettings();

    try {
      for (const urlId of [...job.urlIds]) {
        if (this.cancelled) break;
        while (this.paused && !this.cancelled) await delay(300);
        if (this.cancelled) break;

        const entry = db.urls.get(urlId);
        if (!entry) continue;
        if (entry.state === 'completed') {
          job.skipped++;
          continue;
        }

        const category = entry.categoryId ? db.categories.get(entry.categoryId) : undefined;
        const startedAt = Date.now();
        db.setUrlState(entry.id, 'processing', { startedAt: nowIso(), attempts: entry.attempts + 1 });
        job.currentUrl = entry.url;
        this.currentTitle = null;
        this.currentStage = 'Starting';
        db.jobs.update(job.id, { currentUrl: entry.url });
        this.emitProgress(job);

        const existing = db.findProductByUrl(job.projectId, entry.url);
        const outcome = await this.deps.engine.scrape({
          url: entry.url,
          projectId: job.projectId,
          categoryId: entry.categoryId,
          categoryPath: category?.path ?? category?.name ?? null,
          existingProductId: existing?.id ?? entry.productId ?? null,
          onStage: (s) => {
            this.currentStage = s;
            db.jobs.update(job.id, { currentStage: s });
            this.emitProgress(job);
          }
        });

        const durationMs = Date.now() - startedAt;

        if (outcome.ok && outcome.product) {
          this.currentTitle = outcome.product.title;
          db.saveProduct(outcome.product);
          const state = outcome.warnings.length ? 'warning' : 'completed';
          db.setUrlState(entry.id, state, {
            productId: outcome.product.id,
            finishedAt: nowIso(),
            durationMs,
            lastError: null,
            lastErrorCode: null,
            note: outcome.warnings.length ? outcome.warnings.join(' · ') : null
          });
          job.completed++;
          if (outcome.warnings.length) job.warned++;
          log.info('queue', `Scraped: ${outcome.product.title ?? entry.url}`, undefined, { projectId: job.projectId, urlId: entry.id });
        } else {
          const canRetry = entry.attempts < settings.maxRetries && isRetryable(outcome.errorCode);
          if (canRetry) {
            db.setUrlState(entry.id, 'retrying', { lastError: outcome.error, lastErrorCode: outcome.errorCode, durationMs });
            this.emitProgress(job, `Retrying ${entry.url}`);
            await delay(settings.retryBackoffMs * entry.attempts);
            job.urlIds.push(entry.id);
          } else {
            db.setUrlState(entry.id, 'failed', {
              lastError: outcome.error,
              lastErrorCode: outcome.errorCode,
              finishedAt: nowIso(),
              durationMs
            });
            job.failed++;
            log.warn('queue', `Could not scrape ${entry.url}: ${outcome.error}`, undefined, {
              projectId: job.projectId,
              urlId: entry.id
            });
          }
        }

        db.jobs.update(job.id, {
          completed: job.completed,
          failed: job.failed,
          warned: job.warned,
          skipped: job.skipped,
          urlIds: job.urlIds
        });
        this.emitProgress(job);
        db.products.flushSync();
        db.urls.flushSync();
        db.jobs.flushSync();
      }
    } catch (err) {
      log.error('queue', 'The scrape run stopped unexpectedly', err);
      db.jobs.update(job.id, { state: 'failed', finishedAt: nowIso() });
      job.state = 'failed';
    } finally {
      const finalState: JobState = this.cancelled ? 'cancelled' : this.paused ? 'paused' : job.state === 'failed' ? 'failed' : 'completed';
      job.state = finalState;
      job.currentUrl = null;
      this.currentStage = null;
      db.jobs.update(job.id, {
        state: finalState,
        finishedAt: finalState === 'paused' ? null : nowIso(),
        currentUrl: null,
        currentStage: null
      });
      db.flushAllSync();
      // Only now is the queue genuinely idle: everything is on disk. Flipping
      // this earlier would let a caller act on "finished" while a write is
      // still in flight.
      this.running = false;
      this.emitProgress(job, summaryMessage(job, finalState));
      this.emit('finished', this.snapshot(job));
      if (finalState !== 'paused') this.current = null;
    }
  }
}

function summaryMessage(job: ScrapeJob, state: JobState): string {
  if (state === 'cancelled') return `Cancelled after ${job.completed} of ${job.total}.`;
  if (state === 'paused') return `Paused at ${job.completed} of ${job.total}.`;
  const bits = [`${job.completed} scraped`];
  if (job.warned) bits.push(`${job.warned} with warnings`);
  if (job.failed) bits.push(`${job.failed} failed`);
  if (job.skipped) bits.push(`${job.skipped} already done`);
  return `Finished — ${bits.join(', ')}.`;
}

function isRetryable(code: string | null): boolean {
  if (!code) return true;
  return ['TIMEOUT', 'CONN_RESET', 'CONN_REFUSED', 'SERVER_ERROR', 'RATE_LIMITED', 'RENDER_FAILED', 'UNKNOWN'].includes(code);
}

function labelFor(db: Database, input: { projectId: string; categoryIds?: string[]; urlIds?: string[] }): string {
  if (input.urlIds?.length) return `${input.urlIds.length} selected URL${input.urlIds.length === 1 ? '' : 's'}`;
  if (input.categoryIds?.length) {
    const names = input.categoryIds.map((id) => db.categories.get(id)?.name).filter(Boolean);
    return names.length ? names.join(', ') : 'Selected categories';
  }
  return db.projects.get(input.projectId)?.name ?? 'Whole project';
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
