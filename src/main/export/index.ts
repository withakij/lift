import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { CanonicalProduct } from '../../shared/canonical';
import type { ExportOptions, ExportRecord, Severity, ValidationIssue } from '../../shared/types';
import type { ExportPreview } from '../../shared/ipc';
import { newId, nowIso } from '../db/store';
import { toCsv } from './csv';
import { shopifyLegacyProfile, shopifyModernProfile } from './shopify';
import { generatedKeys, wooProfile } from './woocommerce';
import type { ExportColumn, ExportProfile } from './types';

export const PROFILES: ExportProfile[] = [shopifyLegacyProfile, shopifyModernProfile, wooProfile];

export function findProfile(id: string): ExportProfile | undefined {
  return PROFILES.find((p) => p.id === id);
}

export function profileFor(format: string, preferred?: string): ExportProfile {
  if (preferred) {
    const exact = findProfile(preferred);
    if (exact) return exact;
  }
  const byFormat = PROFILES.find((p) => p.format === format);
  if (!byFormat) throw new Error(`No export profile is registered for "${format}".`);
  return byFormat;
}

export interface BuildResult {
  headers: string[];
  rows: string[][];
  included: CanonicalProduct[];
  skipped: Array<{ productId: string; title: string | null; reason: string }>;
  notes: string[];
}

const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, WARNING: 1, ERROR: 2, CRITICAL: 3 };

/**
 * Builds the table for an export. Products are filtered first, so the header
 * set (which can depend on the data, e.g. WooCommerce attribute columns) is
 * computed from exactly the rows that will be written.
 */
export function buildExport(
  products: CanonicalProduct[],
  issues: ValidationIssue[],
  opts: ExportOptions
): BuildResult {
  const profile = profileFor(opts.format, opts.profileId);
  generatedKeys.clear();

  const worst = new Map<string, Severity>();
  for (const i of issues) {
    if (!i.productId || i.acknowledged) continue;
    const cur = worst.get(i.productId);
    if (!cur || SEVERITY_RANK[i.severity] > SEVERITY_RANK[cur]) worst.set(i.productId, i.severity);
  }

  const skipped: BuildResult['skipped'] = [];
  const included: CanonicalProduct[] = [];

  for (const p of products) {
    if (opts.categoryIds && opts.categoryIds.length && !opts.categoryIds.includes(p.categoryId ?? '')) continue;
    if (opts.productIds && opts.productIds.length && !opts.productIds.includes(p.id)) continue;

    const severity = worst.get(p.id);
    if (severity === 'CRITICAL') {
      skipped.push({ productId: p.id, title: p.title, reason: 'A critical data-integrity problem was found. Fix or acknowledge it first.' });
      continue;
    }
    if (severity === 'ERROR' && !opts.includeErrors) {
      skipped.push({ productId: p.id, title: p.title, reason: 'Has errors. Enable "include products with errors" to export it anyway.' });
      continue;
    }
    if (severity === 'WARNING' && !opts.includeWarnings) {
      skipped.push({ productId: p.id, title: p.title, reason: 'Has warnings. Enable "include products with warnings" to export it.' });
      continue;
    }
    included.push(p);
  }

  const columns: ExportColumn[] = [...profile.columns, ...(profile.dynamicColumns?.(included) ?? [])];
  const headers = columns.map((c) => c.header);

  const rows: string[][] = [];
  for (const p of included) {
    for (const ctx of profile.buildRows(p, included)) {
      rows.push(columns.map((c) => safeGet(c, ctx)));
    }
  }

  const notes: string[] = [];
  if (generatedKeys.size) {
    notes.push(
      `${generatedKeys.size} product${generatedKeys.size === 1 ? '' : 's'} had no SKU on the source page, so an import grouping key was written into the SKU column to link variations to their parent. Replace or clear these in WooCommerce if you use your own SKUs.`
    );
  }
  const withoutCategory = included.filter((p) => !p.categoryPath).length;
  if (withoutCategory) {
    notes.push(`${withoutCategory} product${withoutCategory === 1 ? '' : 's'} exported without a category value.`);
  }

  return { headers, rows, included, skipped, notes };
}

function safeGet(column: ExportColumn, ctx: Parameters<ExportColumn['get']>[0]): string {
  try {
    const v = column.get(ctx);
    return v === null || v === undefined ? '' : String(v);
  } catch {
    return '';
  }
}

export function previewExport(
  products: CanonicalProduct[],
  issues: ValidationIssue[],
  opts: ExportOptions,
  limit = 50
): ExportPreview {
  const built = buildExport(products, issues, opts);
  return {
    headers: built.headers,
    rows: built.rows.slice(0, limit),
    totalRows: built.rows.length,
    skipped: built.skipped
  };
}

/** Windows refuses these as file names, whatever extension follows. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Turns whatever the operator typed into a name every filesystem will accept,
 * so the file that is written is always the file the app says it wrote.
 * Windows silently strips trailing dots and spaces, which would otherwise leave
 * the recorded path pointing at a file that does not exist.
 */
export function safeFileName(input: string | null | undefined, fallback: string): string {
  let base = (input ?? '').replace(/\.csv$/i, '');
  base = base.replace(/[/\\:*?"<>|]/g, '-').replace(/[\u0000-\u001f\u007f]/g, '');
  base = base.replace(/[. ]+$/g, '').trim();
  if (!base) base = fallback;
  if (RESERVED_NAMES.test(base)) base = `${base}-export`;
  // Leave room for the de-duplicating " (2)" suffix inside the 255-byte limit
  // every mainstream filesystem enforces.
  if (base.length > 120) base = base.slice(0, 120).trimEnd();
  return `${base}.csv`;
}

/** A path that is not in use, so an earlier export is never overwritten. */
async function freePath(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(dir, n === 1 ? fileName : `${stem} (${n})${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

export async function runExport(
  products: CanonicalProduct[],
  issues: ValidationIssue[],
  opts: ExportOptions,
  defaultDir: string
): Promise<{ record: ExportRecord; csv: string; notes: string[] }> {
  const built = buildExport(products, issues, opts);

  // Writing a file with nothing but headers would look like a successful
  // export until it was opened, so refuse and say why instead.
  if (built.included.length === 0) {
    const reasons = built.skipped.length
      ? ` Every product was held back: ${summariseSkipReasons(built.skipped)}.`
      : '';
    throw new Error(`There is nothing to export.${reasons}`);
  }

  const csv = toCsv(built.headers, built.rows);
  const dir = opts.outputDir ?? defaultDir;
  await fs.mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePath = await freePath(dir, safeFileName(opts.fileName, `${opts.format}-export-${stamp}`));
  await fs.writeFile(filePath, csv, 'utf8');

  // Confirm what actually landed on disk. Anti-virus and sync clients on
  // Windows have been known to remove a file between writing and reading it.
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size === 0) {
    throw new Error(
      `The file could not be saved to ${filePath}. Check that the folder exists, that there is space, and that no security software is blocking it.`
    );
  }

  const record: ExportRecord = {
    id: newId('exp_'),
    projectId: opts.projectId,
    format: opts.format,
    profileId: profileFor(opts.format, opts.profileId).id,
    createdAt: nowIso(),
    productCount: built.included.length,
    rowCount: built.rows.length,
    skippedCount: built.skipped.length,
    status: built.skipped.length ? 'partial' : 'success',
    filePath,
    byteSize: stat.size,
    message: [...built.notes, built.skipped.length ? `${built.skipped.length} product(s) were left out.` : '']
      .filter(Boolean)
      .join(' ') || null
  };

  return { record, csv, notes: built.notes };
}

function summariseSkipReasons(skipped: BuildResult['skipped']): string {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, n]) => `${n} × ${reason.replace(/\.$/, '')}`).join('; ');
}

export { toCsv, parseCsv } from './csv';
export type { ExportProfile, ExportColumn, RowContext } from './types';
