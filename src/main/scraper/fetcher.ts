/**
 * Polite HTTP layer.
 *
 * - one in-flight request per host by default, with a configurable gap between
 *   consecutive requests to the same host
 * - global concurrency ceiling across all hosts
 * - exponential backoff, and Retry-After is honoured on 429/503
 * - robots.txt is fetched once per origin and cached
 *
 * This module deliberately contains NO mechanism for defeating logins,
 * paywalls, CAPTCHAs or other access controls. A page that refuses us is
 * reported as a failure, not worked around.
 */
import { hostOf, originOf } from '../util/url';
import { log } from '../util/logger';

export interface FetchOptions {
  timeoutMs: number;
  userAgent: string;
  accept?: string;
  referer?: string;
  /** Skip the polite delay — used for same-page sub-resources like product.js. */
  fastLane?: boolean;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string;
  finalUrl: string;
  body: string;
  contentType: string;
  headers: Record<string, string>;
  fromCache: boolean;
  ms: number;
}

class HostLane {
  private active = 0;
  private lastStart = 0;
  private queue: Array<() => void> = [];

  constructor(public perHostConcurrency: number, public delayMs: number) {}

  async acquire(): Promise<void> {
    if (this.active >= this.perHostConcurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    const wait = this.lastStart + this.delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastStart = Date.now();
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The surface the extraction layers depend on. */
export interface FetchLike {
  get(url: string, opts: FetchOptions): Promise<FetchResult>;
  probe(url: string, opts: FetchOptions): Promise<{ ok: boolean; status: number; contentType: string }>;
  isAllowed(url: string, userAgent: string): Promise<{ allowed: boolean; reason?: string }>;
  clearCache(): void;
}

export class Fetcher implements FetchLike {
  private lanes = new Map<string, HostLane>();
  private globalActive = 0;
  private globalQueue: Array<() => void> = [];
  private robotsCache = new Map<string, RobotsRules | null>();
  private pageCache = new Map<string, FetchResult>();

  constructor(
    private cfg: {
      concurrency: number;
      perHostConcurrency: number;
      perHostDelayMs: number;
      respectRobotsTxt: boolean;
      maxRetries: number;
      retryBackoffMs: number;
    }
  ) {}

  updateConfig(cfg: Partial<Fetcher['cfg']>): void {
    this.cfg = { ...this.cfg, ...cfg };
    for (const lane of this.lanes.values()) {
      lane.perHostConcurrency = this.cfg.perHostConcurrency;
      lane.delayMs = this.cfg.perHostDelayMs;
    }
  }

  clearCache(): void {
    this.pageCache.clear();
  }

  private lane(host: string): HostLane {
    let l = this.lanes.get(host);
    if (!l) {
      l = new HostLane(this.cfg.perHostConcurrency, this.cfg.perHostDelayMs);
      this.lanes.set(host, l);
    }
    return l;
  }

  private async acquireGlobal(): Promise<void> {
    if (this.globalActive >= this.cfg.concurrency) {
      await new Promise<void>((resolve) => this.globalQueue.push(resolve));
    }
    this.globalActive++;
  }

  private releaseGlobal(): void {
    this.globalActive = Math.max(0, this.globalActive - 1);
    const next = this.globalQueue.shift();
    if (next) next();
  }

  /** Returns true when robots.txt permits this path for our user agent. */
  async isAllowed(url: string, userAgent: string): Promise<{ allowed: boolean; reason?: string }> {
    if (!this.cfg.respectRobotsTxt) return { allowed: true };
    const origin = originOf(url);
    if (!origin) return { allowed: true };
    let rules = this.robotsCache.get(origin);
    if (rules === undefined) {
      rules = await this.loadRobots(origin, userAgent);
      this.robotsCache.set(origin, rules);
    }
    if (!rules) return { allowed: true };
    const p = new URL(url).pathname + new URL(url).search;
    const allowed = rules.isAllowed(p);
    return allowed ? { allowed: true } : { allowed: false, reason: `${origin}/robots.txt disallows ${p}` };
  }

  private async loadRobots(origin: string, userAgent: string): Promise<RobotsRules | null> {
    try {
      const res = await this.raw(`${origin}/robots.txt`, { timeoutMs: 12000, userAgent, accept: 'text/plain' });
      if (!res.ok || !res.body) return null;
      return parseRobots(res.body, userAgent);
    } catch {
      return null;
    }
  }

  /** Full polite fetch with retries. */
  async get(url: string, opts: FetchOptions): Promise<FetchResult> {
    const cached = this.pageCache.get(url);
    if (cached) return { ...cached, fromCache: true };

    const host = hostOf(url);
    await this.acquireGlobal();
    const lane = this.lane(host);
    try {
      if (!opts.fastLane) await lane.acquire();
      let attempt = 0;
      let lastErr: unknown = null;
      for (;;) {
        try {
          const res = await this.raw(url, opts);
          if (res.status === 429 || res.status === 503) {
            const ra = Number(res.headers['retry-after']);
            const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60000) : this.cfg.retryBackoffMs * 2 ** attempt;
            if (attempt < this.cfg.maxRetries) {
              log.warn('fetch', `Host asked us to slow down (${res.status}); waiting ${Math.round(waitMs / 1000)}s`, url);
              await sleep(waitMs);
              attempt++;
              continue;
            }
          }
          if (res.status >= 200 && res.status < 400 && res.body) this.pageCache.set(url, res);
          return res;
        } catch (err) {
          lastErr = err;
          if (attempt >= this.cfg.maxRetries) break;
          const waitMs = this.cfg.retryBackoffMs * 2 ** attempt;
          log.warn('fetch', `Request failed, retrying in ${Math.round(waitMs / 1000)}s`, String(err));
          await sleep(waitMs);
          attempt++;
        }
      }
      throw lastErr;
    } finally {
      if (!opts.fastLane) lane.release();
      this.releaseGlobal();
    }
  }

  /** Single request, no queueing, no retries. */
  async raw(url: string, opts: FetchOptions): Promise<FetchResult> {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          'User-Agent': opts.userAgent,
          Accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          ...(opts.referer ? { Referer: opts.referer } : {})
        }
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      const contentType = headers['content-type'] ?? '';
      const isText = /text|json|xml|javascript/i.test(contentType) || contentType === '';
      const body = isText ? await res.text() : '';
      return {
        ok: res.ok,
        status: res.status,
        url,
        finalUrl: res.url || url,
        body,
        contentType,
        headers,
        fromCache: false,
        ms: Date.now() - started
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** HEAD (falling back to a ranged GET) used to verify image URLs resolve. */
  async probe(url: string, opts: FetchOptions): Promise<{ ok: boolean; status: number; contentType: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(opts.timeoutMs, 15000));
    try {
      let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': opts.userAgent } });
      if (res.status === 405 || res.status === 403) {
        res = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: ctrl.signal,
          headers: { 'User-Agent': opts.userAgent, Range: 'bytes=0-127' }
        });
      }
      return { ok: res.ok || res.status === 206, status: res.status, contentType: res.headers.get('content-type') ?? '' };
    } catch {
      return { ok: false, status: 0, contentType: '' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ------------------------------------------------------------------ */
/* robots.txt                                                          */
/* ------------------------------------------------------------------ */

export class RobotsRules {
  constructor(private allow: string[], private disallow: string[]) {}

  isAllowed(pathAndQuery: string): boolean {
    const a = longestMatch(this.allow, pathAndQuery);
    const d = longestMatch(this.disallow, pathAndQuery);
    if (d === null) return true;
    if (a === null) return false;
    return a.length >= d.length;
  }
}

function longestMatch(patterns: string[], target: string): string | null {
  let best: string | null = null;
  for (const p of patterns) {
    if (matchesRobotPattern(p, target) && (best === null || p.length > best.length)) best = p;
  }
  return best;
}

function matchesRobotPattern(pattern: string, target: string): boolean {
  if (pattern === '') return false;
  const anchoredEnd = pattern.endsWith('$');
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;
  const parts = body.split('*');
  let idx = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '') continue;
    const at = i === 0 ? (target.startsWith(part) ? 0 : -1) : target.indexOf(part, idx);
    if (at < 0) return false;
    idx = at + part.length;
  }
  if (anchoredEnd) return idx === target.length;
  return true;
}

export function parseRobots(text: string, userAgent: string): RobotsRules {
  const uaToken = userAgent.toLowerCase();
  const groups: Array<{ agents: string[]; allow: string[]; disallow: string[] }> = [];
  let current: { agents: string[]; allow: string[]; disallow: string[] } | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const key = line.slice(0, ci).trim().toLowerCase();
    const value = line.slice(ci + 1).trim();

    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      if (!current) {
        current = { agents: ['*'], allow: [], disallow: [] };
        groups.push(current);
      }
      lastWasAgent = false;
      if (key === 'allow') current.allow.push(value);
      else current.disallow.push(value);
    }
  }

  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && uaToken.includes(a)));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const chosen = specific.length ? specific : wildcard;
  const allow: string[] = [];
  const disallow: string[] = [];
  for (const g of chosen) {
    allow.push(...g.allow);
    disallow.push(...g.disallow.filter((d) => d !== ''));
  }
  return new RobotsRules(allow, disallow);
}
