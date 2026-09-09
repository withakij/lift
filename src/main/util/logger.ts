import { EventEmitter } from 'node:events';
import type { LogEntry } from '../../shared/types';
import { newId, nowIso } from '../db/store';

type Level = LogEntry['level'];

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger extends EventEmitter {
  private minLevel: Level = 'info';
  private sink: ((e: LogEntry) => void) | null = null;

  setLevel(l: Level): void {
    this.minLevel = l;
  }

  setSink(fn: (e: LogEntry) => void): void {
    this.sink = fn;
  }

  private emitEntry(level: Level, scope: string, message: string, detail?: unknown, ctx?: { projectId?: string; urlId?: string }): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;
    const entry: LogEntry = {
      id: newId('log_'),
      ts: nowIso(),
      level,
      scope,
      message,
      projectId: ctx?.projectId,
      urlId: ctx?.urlId,
      detail: detail === undefined ? undefined : typeof detail === 'string' ? detail : safeStringify(detail)
    };
    if (process.env.LIFT_DEV) {
      const tag = `[${level.toUpperCase()}][${scope}]`;
      if (level === 'error') console.error(tag, message, entry.detail ?? '');
      else console.log(tag, message, entry.detail ?? '');
    }
    this.sink?.(entry);
    this.emit('entry', entry);
  }

  debug(scope: string, message: string, detail?: unknown, ctx?: { projectId?: string; urlId?: string }): void {
    this.emitEntry('debug', scope, message, detail, ctx);
  }
  info(scope: string, message: string, detail?: unknown, ctx?: { projectId?: string; urlId?: string }): void {
    this.emitEntry('info', scope, message, detail, ctx);
  }
  warn(scope: string, message: string, detail?: unknown, ctx?: { projectId?: string; urlId?: string }): void {
    this.emitEntry('warn', scope, message, detail, ctx);
  }
  error(scope: string, message: string, detail?: unknown, ctx?: { projectId?: string; urlId?: string }): void {
    this.emitEntry('error', scope, message, detail, ctx);
  }
}

function safeStringify(v: unknown): string {
  try {
    if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? ''}`;
    return JSON.stringify(v, null, 2).slice(0, 8000);
  } catch {
    return String(v);
  }
}

export const log = new Logger();

/**
 * Turns any thrown value into a sentence an operator can act on.
 * Technical text stays in `detail`, never in the message shown by default.
 */
export function humanizeError(err: unknown): { code: string; message: string; detail: string } {
  const detail = safeStringify(err);
  const raw = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code ?? '';

  const map: Array<[RegExp | string, string, string]> = [
    ['ENOTFOUND', 'DNS_FAILED', 'That domain could not be found. Check the address for typos.'],
    ['ECONNREFUSED', 'CONN_REFUSED', 'The website refused the connection.'],
    ['ECONNRESET', 'CONN_RESET', 'The connection was closed by the website before the page finished loading.'],
    ['ETIMEDOUT', 'TIMEOUT', 'The website did not respond in time.'],
    ['UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT', 'The website did not respond in time.'],
    ['UND_ERR_HEADERS_TIMEOUT', 'TIMEOUT', 'The website started responding but never sent the page.'],
    ['CERT_HAS_EXPIRED', 'TLS_ERROR', "The website's security certificate has expired."],
    [/abort/i, 'TIMEOUT', 'The request was cancelled because it took too long.'],
    [/HTTP 404/i, 'NOT_FOUND', 'That page does not exist (404). The product may have been removed.'],
    [/HTTP 401|HTTP 403/i, 'BLOCKED', 'The website refused access to this page. It may require a login or be blocking automated visits.'],
    [/HTTP 429/i, 'RATE_LIMITED', 'The website is rate-limiting requests. Increase the delay in Settings and retry.'],
    [/HTTP 5\d\d/i, 'SERVER_ERROR', 'The website returned a server error. It may be temporarily down.'],
    [/no product/i, 'NO_PRODUCT', 'No product could be found on this page.'],
    [/render/i, 'RENDER_FAILED', 'The page could not be rendered fully. Some data may be loaded by JavaScript that did not run.']
  ];

  for (const [match, c, msg] of map) {
    const hay = `${code} ${raw}`;
    if (typeof match === 'string' ? hay.includes(match) : match.test(hay)) {
      return { code: c, message: msg, detail };
    }
  }
  return { code: 'UNKNOWN', message: `Could not process this page: ${raw}`, detail };
}
