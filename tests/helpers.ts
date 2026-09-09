import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { FetchLike, FetchOptions, FetchResult } from '../src/main/scraper/fetcher';
import { ScrapeEngine } from '../src/main/scraper/engine';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/shared/types';

// Resolved from the project root so this works whether the tests run from
// source or from the compiled output in dist/test.
export const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

export function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

export interface StubRoute {
  body: string;
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
}

/**
 * Offline fetcher: serves a fixed map of URLs and refuses everything else with
 * a 404, so a test can prove an extractor did not reach for the network.
 */
export class StubFetcher implements FetchLike {
  readonly requested: string[] = [];

  constructor(private routes: Record<string, StubRoute>) {}

  async get(url: string, _opts: FetchOptions): Promise<FetchResult> {
    this.requested.push(url);
    const route = this.routes[url];
    if (!route) {
      return {
        ok: false, status: 404, url, finalUrl: url, body: '', contentType: 'text/plain',
        headers: {}, fromCache: false, ms: 1
      };
    }
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      url,
      finalUrl: url,
      body: route.body,
      contentType: route.contentType ?? 'text/html',
      headers: route.headers ?? {},
      fromCache: false,
      ms: 1
    };
  }

  async probe(url: string): Promise<{ ok: boolean; status: number; contentType: string }> {
    const route = this.routes[url];
    return route
      ? { ok: true, status: 200, contentType: 'image/jpeg' }
      : { ok: false, status: 404, contentType: '' };
  }

  async isAllowed(): Promise<{ allowed: boolean; reason?: string }> {
    return { allowed: true };
  }

  clearCache(): void {
    /* nothing cached */
  }
}

export function testSettings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    perHostDelayMs: 0,
    requestTimeoutMs: 5000,
    maxRetries: 0,
    retryBackoffMs: 0,
    respectRobotsTxt: false,
    browserRenderMode: 'never',
    validateImageUrls: false,
    enableVariantInteraction: false,
    keepDebugSnippets: false,
    ...patch
  };
}

export function engineWith(routes: Record<string, StubRoute>, patch: Partial<AppSettings> = {}) {
  const fetcher = new StubFetcher(routes);
  const settings = testSettings(patch);
  return { engine: new ScrapeEngine(fetcher, settings), fetcher, settings };
}

export function variantByOptions<T extends { options: Array<{ name: string; value: string }> }>(
  variants: T[],
  ...values: string[]
): T | undefined {
  return variants.find((v) => values.every((val) => v.options.some((o) => o.value.toLowerCase() === val.toLowerCase())));
}
