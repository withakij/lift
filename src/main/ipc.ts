import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { CH, type AppInfo, type ProductListQuery, type ProductListResult, type ProductSummary } from '../shared/ipc';
import type {
  AppSettings,
  Category,
  DashboardStats,
  ExportOptions,
  Project,
  Severity,
  UrlEntry,
  UrlState
} from '../shared/types';
import type { CanonicalProduct } from '../shared/canonical';
import { db } from './db';
import { newId, nowIso } from './db/store';
import { coerceUrl, isProbablyUrl, normalizeUrl } from './util/url';
import { log } from './util/logger';
import type { ScrapeQueue } from './queue';
import type { ScrapeEngine } from './scraper/engine';
import { validateProducts } from './validation/engine';
import { PROFILES, previewExport, profileFor, runExport } from './export';
import { detectPlatform } from './scraper/detect';
import { load } from './dom';
import type { Fetcher } from './scraper/fetcher';

interface Wiring {
  queue: ScrapeQueue;
  engine: ScrapeEngine;
  fetcher: Fetcher;
  mainWindow: () => BrowserWindow | null;
  dataDir: string;
}

/** Wraps a handler so a thrown error reaches the UI as readable text. */
function handle<T extends unknown[], R>(channel: string, fn: (...args: T) => R | Promise<R>): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return await fn(...(args as T));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('ipc', `${channel} failed: ${message}`, err);
      throw new Error(message);
    }
  });
}

function broadcast(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

export function registerIpc(w: Wiring): void {
  const D = db;

  const changed = (scope: string, projectId?: string) =>
    broadcast(w.mainWindow(), CH.evtDataChanged, { scope, projectId });

  /* ---------------- projects ---------------- */

  handle(CH.projectList, () => D().projects.all().filter((p) => !p.archived));
  handle(CH.projectGet, (id: string) => D().projects.get(id) ?? null);
  handle(CH.projectCreate, (input: { name: string; description?: string; targetFormat: 'shopify' | 'woocommerce'; exportProfileId?: string }) => {
    const p = D().createProject(input);
    changed('projects');
    return p;
  });
  handle(CH.projectUpdate, (id: string, patch: Partial<Project>) => {
    const p = D().projects.update(id, { ...patch, updatedAt: nowIso() });
    changed('projects', id);
    return p;
  });
  handle(CH.projectDelete, (id: string) => {
    D().deleteProject(id);
    changed('projects');
  });

  /* ---------------- categories ---------------- */

  handle(CH.categoryList, (projectId: string) => {
    const d = D();
    return d.categories
      .find((c) => c.projectId === projectId)
      .sort((a, b) => a.position - b.position)
      .map((c) => ({
        ...c,
        urlCount: d.urls.count((u) => u.categoryId === c.id),
        productCount: d.products.count((p) => p.categoryId === c.id)
      }));
  });
  handle(CH.categoryCreate, (input: { projectId: string; name: string; path?: string; googleProductCategory?: string | null }) => {
    const c = D().createCategory(input);
    changed('categories', input.projectId);
    return c;
  });
  handle(CH.categoryUpdate, (id: string, patch: Partial<Category>) => {
    const d = D();
    const c = d.categories.update(id, { ...patch, updatedAt: nowIso() });
    // Renaming a category must flow through to already-scraped products.
    if (patch.name !== undefined || patch.path !== undefined) {
      for (const entry of d.products.indexAll().filter((p) => p.categoryId === id)) {
        const doc = d.products.get(entry.id);
        if (!doc) continue;
        doc.categoryPath = c.path || c.name;
        d.products.put(doc);
      }
    }
    changed('categories', c.projectId);
    return c;
  });
  handle(CH.categoryDelete, (id: string, opts?: { deleteUrls?: boolean }) => {
    const c = D().categories.get(id);
    D().deleteCategory(id, opts?.deleteUrls ?? false);
    changed('categories', c?.projectId);
  });

  /* ---------------- urls ---------------- */

  handle(CH.urlList, (projectId: string, categoryId?: string | null) => {
    const all = D().urls.find((u) => u.projectId === projectId);
    if (categoryId === undefined) return all;
    return all.filter((u) => u.categoryId === categoryId);
  });

  handle(CH.urlAdd, (input: { projectId: string; categoryId: string | null; url: string }) => {
    const coerced = coerceUrl(input.url);
    if (!coerced) return { added: null, duplicate: false, invalid: true, reason: 'That does not look like a web address.' };
    const { entry, duplicate } = D().addUrl(input.projectId, input.categoryId, input.url, coerced);
    changed('urls', input.projectId);
    return { added: duplicate ? null : entry, duplicate, invalid: false };
  });

  handle(CH.urlAddBulk, (input: { projectId: string; categoryId: string | null; text: string }) => {
    const lines = input.text
      .split(/[\r\n,;\t]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    let added = 0;
    let duplicates = 0;
    const invalid: string[] = [];
    for (const line of lines) {
      const coerced = coerceUrl(line);
      if (!coerced) {
        invalid.push(line);
        continue;
      }
      const r = D().addUrl(input.projectId, input.categoryId, line, coerced);
      if (r.duplicate) duplicates++;
      else added++;
    }
    changed('urls', input.projectId);
    return { added, duplicates, invalid };
  });

  handle(CH.urlUpdate, (id: string, patch: Partial<UrlEntry>) => {
    const next = { ...patch };
    if (patch.url) {
      const coerced = coerceUrl(patch.url);
      if (!coerced) throw new Error('That does not look like a web address.');
      next.url = coerced;
      next.normalizedUrl = normalizeUrl(coerced);
      next.state = 'pending';
    }
    const u = D().urls.update(id, next);
    changed('urls', u.projectId);
    return u;
  });

  handle(CH.urlDelete, (id: string) => {
    const u = D().urls.get(id);
    D().urls.remove(id);
    changed('urls', u?.projectId);
  });

  handle(CH.urlDeleteMany, (ids: string[]) => {
    const first = D().urls.get(ids[0]);
    D().urls.removeWhere((u) => ids.includes(u.id));
    changed('urls', first?.projectId);
  });

  handle(CH.urlMove, (ids: string[], categoryId: string | null) => {
    const d = D();
    for (const id of ids) if (d.urls.get(id)) d.urls.update(id, { categoryId });
    changed('urls', d.urls.get(ids[0])?.projectId);
  });

  handle(CH.urlResetState, (ids: string[]) => {
    const d = D();
    for (const id of ids) {
      d.setUrlState(id, 'pending', { lastError: null, lastErrorCode: null, attempts: 0, finishedAt: null });
    }
    changed('urls');
  });

  handle(CH.urlImportFile, async (projectId: string, categoryId: string | null) => {
    const win = w.mainWindow();
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Choose a file containing product URLs',
      properties: ['openFile'],
      filters: [
        { name: 'Text and CSV', extensions: ['txt', 'csv', 'tsv', 'list'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) return { added: 0, duplicates: 0, invalid: [], cancelled: true };
    const text = await fs.readFile(result.filePaths[0], 'utf8');
    const tokens = text
      .split(/[\r\n,;\t"']+/)
      .map((s) => s.trim())
      .filter((s) => isProbablyUrl(s) || /^[\w.-]+\.[a-z]{2,}\//i.test(s));
    let added = 0;
    let duplicates = 0;
    const invalid: string[] = [];
    for (const t of tokens) {
      const coerced = coerceUrl(t);
      if (!coerced) {
        invalid.push(t);
        continue;
      }
      const r = D().addUrl(projectId, categoryId, t, coerced);
      if (r.duplicate) duplicates++;
      else added++;
    }
    changed('urls', projectId);
    return { added, duplicates, invalid };
  });

  /* ---------------- scraping ---------------- */

  handle(CH.scrapeStart, async (input: { projectId: string; categoryIds?: string[]; urlIds?: string[]; label?: string }) => {
    w.engine.updateSettings(D().getSettings());
    const job = w.queue.createJob(input);
    if (job.total === 0) throw new Error('There is nothing to scrape — every URL in this selection is already done.');
    await w.queue.start(job);
    changed('jobs', input.projectId);
    return job;
  });
  handle(CH.scrapePause, () => w.queue.pause());
  handle(CH.scrapeResume, () => w.queue.resume());
  handle(CH.scrapeCancel, () => w.queue.cancel());
  handle(CH.scrapeActive, () => w.queue.activeProgress());
  handle(CH.scrapeJobs, (projectId: string) =>
    D().jobs.find((j) => j.projectId === projectId).slice(-30).reverse()
  );

  handle(CH.scrapeRetryFailed, async (projectId: string) => {
    const failed = D().urls.find((u) => u.projectId === projectId && (u.state === 'failed' || u.state === 'retrying'));
    if (!failed.length) return null;
    for (const u of failed) D().setUrlState(u.id, 'pending', { attempts: 0, lastError: null, lastErrorCode: null });
    const job = w.queue.createJob({ projectId, urlIds: failed.map((u) => u.id), label: `Retrying ${failed.length} failed URL(s)` });
    await w.queue.start(job);
    return job;
  });

  handle(CH.scrapeRescrape, async (productIds: string[]) => {
    const d = D();
    const urls: string[] = [];
    let projectId = '';
    for (const pid of productIds) {
      const idx = d.products.indexOf(pid);
      if (!idx) continue;
      projectId = idx.projectId;
      const entry = d.urls.first((u) => u.projectId === idx.projectId && u.normalizedUrl === idx.normalizedUrl);
      if (entry) {
        d.setUrlState(entry.id, 'pending', { attempts: 0, lastError: null, lastErrorCode: null });
        urls.push(entry.id);
      }
    }
    if (!urls.length) return null;
    const job = w.queue.createJob({ projectId, urlIds: urls, label: `Re-scraping ${urls.length} product(s)` });
    await w.queue.start(job);
    return job;
  });

  handle(CH.scrapeTestUrl, async (url: string) => {
    const coerced = coerceUrl(url);
    if (!coerced) return { platform: 'unknown', reachable: false, status: null, detail: 'That does not look like a web address.' };
    const settings = D().getSettings();
    try {
      const res = await w.fetcher.get(coerced, { timeoutMs: settings.requestTimeoutMs, userAgent: settings.userAgent });
      const $ = load(res.body);
      const det = detectPlatform($, res.body, res.headers);
      return {
        platform: det.platform,
        reachable: res.status < 400,
        status: res.status,
        detail:
          res.status >= 400
            ? `The site responded with HTTP ${res.status}.`
            : det.platform === 'unknown'
              ? 'The page loaded, but the store platform could not be identified. Generic extraction will be used.'
              : `Detected ${det.platform} (${det.signals.slice(0, 3).join(', ')}).`
      };
    } catch (err) {
      return { platform: 'unknown', reachable: false, status: null, detail: err instanceof Error ? err.message : String(err) };
    }
  });

  /* ---------------- products ---------------- */

  handle(CH.productList, (q: ProductListQuery): ProductListResult => {
    const d = D();
    const worst = new Map<string, { severity: Severity; count: number }>();
    for (const i of d.issues.all()) {
      if (i.projectId !== q.projectId || !i.productId) continue;
      const cur = worst.get(i.productId) ?? { severity: 'INFO' as Severity, count: 0 };
      const rank: Record<Severity, number> = { INFO: 0, WARNING: 1, ERROR: 2, CRITICAL: 3 };
      worst.set(i.productId, {
        severity: rank[i.severity] > rank[cur.severity] ? i.severity : cur.severity,
        count: cur.count + 1
      });
    }

    let items = d.products.indexAll().filter((p) => p.projectId === q.projectId);
    if (q.categoryId !== undefined && q.categoryId !== null) items = items.filter((p) => p.categoryId === q.categoryId);
    if (q.kind) items = items.filter((p) => p.kind === q.kind);
    if (q.search) {
      const needle = q.search.toLowerCase();
      items = items.filter(
        (p) =>
          (p.title ?? '').toLowerCase().includes(needle) ||
          p.sourceUrl.toLowerCase().includes(needle) ||
          (p.skus ?? []).some((s) => s.toLowerCase().includes(needle))
      );
    }
    if (q.onlyNeedingReview) {
      items = items.filter((p) => {
        const wsev = worst.get(p.id)?.severity;
        return wsev === 'WARNING' || wsev === 'ERROR' || wsev === 'CRITICAL';
      });
    }

    items = [...items].sort((a, b) => (b.scrapedAt ?? '').localeCompare(a.scrapedAt ?? ''));
    const total = items.length;
    const offset = q.offset ?? 0;
    const limit = q.limit ?? 100;
    const page = items.slice(offset, offset + limit);

    const summaries: ProductSummary[] = page.map((p) => ({
      id: p.id,
      title: p.title,
      sourceUrl: p.sourceUrl,
      sourcePlatform: p.sourcePlatform,
      kind: p.kind,
      categoryPath: p.categoryPath,
      price: p.price,
      currency: p.currency,
      variantCount: p.variantCount,
      imageCount: p.imageCount,
      stockStatus: p.stockStatus,
      worstSeverity: worst.get(p.id)?.severity ?? null,
      issueCount: worst.get(p.id)?.count ?? 0,
      scrapedAt: p.scrapedAt,
      featuredImageUrl: p.featuredImageUrl
    }));
    return { items: summaries, total };
  });

  handle(CH.productGet, (id: string) => D().products.get(id));

  handle(CH.productDelete, (ids: string[]) => {
    const d = D();
    for (const id of ids) {
      const idx = d.products.indexOf(id);
      if (idx) {
        const entry = d.urls.first((u) => u.normalizedUrl === idx.normalizedUrl && u.projectId === idx.projectId);
        if (entry) d.setUrlState(entry.id, 'pending', { productId: null });
      }
      d.products.remove(id);
      d.issues.removeWhere((i) => i.productId === id);
    }
    changed('products');
  });

  handle(CH.productTrace, (id: string) => {
    const p = D().products.get(id);
    if (!p) return [];
    return Object.entries(p.provenance)
      .map(([field, prov]) => ({
        field,
        value: readPath(p, field),
        source: prov.source,
        confidence: prov.confidence,
        note: prov.conflict
          ? `${prov.note ? prov.note + ' — ' : ''}conflicts with ${String(prov.conflict.otherValue)} from ${prov.conflict.otherSource}`
          : prov.note
      }))
      .sort((a, b) => a.field.localeCompare(b.field));
  });

  handle(CH.productPatch, (id: string, patch: Record<string, unknown>) => {
    const d = D();
    const p = d.products.get(id);
    if (!p) throw new Error('That product no longer exists.');
    for (const [key, value] of Object.entries(patch)) {
      writePath(p, key, value);
      p.provenance[key] = { source: 'user', confidence: 'high', note: 'edited in the application' };
    }
    d.products.put(p);
    changed('products', p.projectId);
    return p;
  });

  /* ---------------- validation ---------------- */

  handle(CH.validationRun, (projectId: string) => {
    const d = D();
    const project = d.projects.get(projectId);
    if (!project) throw new Error('That project no longer exists.');
    const products = d.products.loadMany(
      d.products.indexAll().filter((p) => p.projectId === projectId).map((p) => p.id)
    );
    const { issues, summary } = validateProducts(projectId, products, project.targetFormat);
    d.replaceIssues(projectId, issues);
    d.issues.flushSync();
    changed('validation', projectId);
    return summary;
  });

  handle(CH.validationList, (projectId: string, opts?: { severity?: string; productId?: string }) => {
    let list = D().issues.find((i) => i.projectId === projectId);
    if (opts?.severity) list = list.filter((i) => i.severity === opts.severity);
    if (opts?.productId) list = list.filter((i) => i.productId === opts.productId);
    const rank: Record<Severity, number> = { CRITICAL: 0, ERROR: 1, WARNING: 2, INFO: 3 };
    return list.sort((a, b) => rank[a.severity] - rank[b.severity]);
  });

  handle(CH.validationAck, (ids: string[], value: boolean) => {
    const d = D();
    for (const id of ids) if (d.issues.get(id)) d.issues.update(id, { acknowledged: value });
    changed('validation');
  });

  handle(CH.validationClear, (projectId: string) => {
    D().issues.removeWhere((i) => i.projectId === projectId);
    changed('validation', projectId);
  });

  /* ---------------- exports ---------------- */

  handle(CH.exportProfiles, () =>
    PROFILES.map((p) => ({
      id: p.id,
      format: p.format,
      label: p.label,
      description: p.description,
      columns: p.columns.map((c) => c.header)
    }))
  );

  handle(CH.exportPreview, (opts: ExportOptions, limit?: number) => {
    const d = D();
    const products = loadProjectProducts(opts.projectId);
    return previewExport(products, d.issues.find((i) => i.projectId === opts.projectId), opts, limit ?? 30);
  });

  handle(CH.exportRun, async (opts: ExportOptions) => {
    const d = D();
    const products = loadProjectProducts(opts.projectId);
    if (!products.length) throw new Error('There are no scraped products in this project yet.');
    const defaultDir = d.getSettings().defaultExportDir ?? path.join(app.getPath('documents'), 'Lift Exports');
    const { record } = await runExport(products, d.issues.find((i) => i.projectId === opts.projectId), opts, defaultDir);
    d.exportsLog.insert(record);
    d.exportsLog.flushSync();
    changed('exports', opts.projectId);
    log.info('export', `Wrote ${record.rowCount} rows to ${record.filePath}`);
    return record;
  });

  handle(CH.exportHistory, (projectId: string) =>
    D().exportsLog.find((e) => e.projectId === projectId).slice(-50).reverse()
  );

  handle(CH.exportReveal, (filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  /* ---------------- settings, dashboard, system ---------------- */

  handle(CH.settingsGet, () => D().getSettings());
  handle(CH.settingsSet, (patch: Partial<AppSettings>) => {
    const s = D().setSettings(patch);
    w.engine.updateSettings(s);
    log.setLevel(s.advancedMode ? 'debug' : 'info');
    changed('settings');
    return s;
  });

  handle(CH.dashboardStats, (projectId: string | null): DashboardStats => {
    const d = D();
    const urls = projectId ? d.urls.find((u) => u.projectId === projectId) : d.urls.all();
    const urlsByState = {
      pending: 0, processing: 0, completed: 0, warning: 0, failed: 0, retrying: 0, skipped: 0, paused: 0
    } as Record<UrlState, number>;
    for (const u of urls) urlsByState[u.state]++;

    const productIdx = projectId ? d.products.indexAll().filter((p) => p.projectId === projectId) : d.products.indexAll();
    const issues = projectId ? d.issues.find((i) => i.projectId === projectId) : d.issues.all();
    const issuesBySeverity: Record<Severity, number> = { INFO: 0, WARNING: 0, ERROR: 0, CRITICAL: 0 };
    const needing = new Set<string>();
    for (const i of issues) {
      issuesBySeverity[i.severity]++;
      if (i.productId && i.severity !== 'INFO') needing.add(i.productId);
    }

    const exportsList = projectId ? d.exportsLog.find((e) => e.projectId === projectId) : d.exportsLog.all();

    return {
      projects: d.projects.count((p) => !p.archived),
      categories: projectId ? d.categories.count((c) => c.projectId === projectId) : d.categories.count(),
      urls: urls.length,
      urlsByState,
      products: productIdx.length,
      variants: productIdx.reduce((n, p) => n + (p.variantCount ?? 0), 0),
      productsNeedingReview: needing.size,
      issuesBySeverity,
      lastExport: exportsList.length ? exportsList[exportsList.length - 1] : null,
      activeJob: w.queue.activeProgress()
    };
  });

  handle(CH.logsList, (opts?: { limit?: number; level?: string }) => {
    let list = D().logs.all();
    if (opts?.level) list = list.filter((l) => l.level === opts.level);
    return list.slice(-(opts?.limit ?? 400)).reverse();
  });

  handle(CH.chooseDirectory, async () => {
    const win = w.mainWindow();
    const r = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Choose where exports should be saved',
      properties: ['openDirectory', 'createDirectory']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  handle(CH.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: process.platform,
    dataDir: w.dataDir
  }));

  handle(CH.openExternal, async (url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only web addresses can be opened.');
    await shell.openExternal(url);
  });

  /* ---------------- events ---------------- */

  w.queue.on('progress', (e) => broadcast(w.mainWindow(), CH.evtProgress, e));
  log.on('entry', (e) => broadcast(w.mainWindow(), CH.evtLog, e));
}

function loadProjectProducts(projectId: string): CanonicalProduct[] {
  const d = db();
  return d.products.loadMany(d.products.indexAll().filter((p) => p.projectId === projectId).map((p) => p.id));
}

function readPath(obj: unknown, path: string): unknown {
  const variantMatch = path.match(/^variants\[([^\]]+)\]\.(.+)$/);
  if (variantMatch) {
    const p = obj as CanonicalProduct;
    const v = p.variants.find((x) => x.id === variantMatch[1]);
    return v ? (v as unknown as Record<string, unknown>)[variantMatch[2]] : undefined;
  }
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function writePath(obj: CanonicalProduct, path: string, value: unknown): void {
  const variantMatch = path.match(/^variants\[([^\]]+)\]\.(.+)$/);
  if (variantMatch) {
    const v = obj.variants.find((x) => x.id === variantMatch[1]);
    if (v) (v as unknown as Record<string, unknown>)[variantMatch[2]] = value;
    return;
  }
  const parts = path.split('.');
  let cur = obj as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (typeof next !== 'object' || next === null) return;
    cur = next as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

export { newId };
