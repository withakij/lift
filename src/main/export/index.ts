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

export async function runExport(
  products: CanonicalProduct[],
  issues: ValidationIssue[],
  opts: ExportOptions,
  defaultDir: string
): Promise<{ record: ExportRecord; csv: string; notes: string[] }> {
  const built = buildExport(products, issues, opts);
  const csv = toCsv(built.headers, built.rows);

  const dir = opts.outputDir ?? defaultDir;
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = opts.fileName?.replace(/[/\\:*?"<>|]/g, '-') ?? `${opts.format}-export-${stamp}.csv`;
  const filePath = path.join(dir, base.endsWith('.csv') ? base : `${base}.csv`);
  await fs.writeFile(filePath, csv, 'utf8');

  const record: ExportRecord = {
    id: newId('exp_'),
    projectId: opts.projectId,
    format: opts.format,
    profileId: profileFor(opts.format, opts.profileId).id,
    createdAt: nowIso(),
    productCount: built.included.length,
    rowCount: built.rows.length,
    skippedCount: built.skipped.length,
    status: built.included.length === 0 ? 'failed' : built.skipped.length ? 'partial' : 'success',
    filePath,
    message: [...built.notes, built.skipped.length ? `${built.skipped.length} product(s) were left out.` : '']
      .filter(Boolean)
      .join(' ') || null
  };

  return { record, csv, notes: built.notes };
}

export { toCsv, parseCsv } from './csv';
export type { ExportProfile, ExportColumn, RowContext } from './types';
