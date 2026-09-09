import * as path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Collection, DocStore, newId, nowIso, setStoreErrorHandler } from './store';
import { normalizeUrl } from '../util/url';
import type { CanonicalProduct } from '../../shared/canonical';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type Category,
  type ExportRecord,
  type LogEntry,
  type Project,
  type ScrapeJob,
  type Severity,
  type TargetFormat,
  type UrlEntry,
  type UrlState,
  type ValidationIssue
} from '../../shared/types';

export interface ProductIndexEntry {
  [k: string]: unknown;
  id: string;
  projectId: string;
  categoryId: string | null;
  categoryPath: string | null;
  normalizedUrl: string;
  sourceUrl: string;
  sourcePlatform: string;
  kind: string;
  title: string | null;
  handle: string | null;
  price: number | null;
  currency: string | null;
  variantCount: number;
  imageCount: number;
  stockStatus: string;
  featuredImageUrl: string | null;
  scrapedAt: string;
  skus: string[];
}

function summariseProduct(p: CanonicalProduct): ProductIndexEntry {
  const skus = [p.sku, ...p.variants.map((v) => v.sku)].filter((s): s is string => !!s && s.trim() !== '');
  return {
    id: p.id,
    projectId: p.projectId,
    categoryId: p.categoryId,
    categoryPath: p.categoryPath,
    normalizedUrl: normalizeUrl(p.sourceUrl),
    sourceUrl: p.sourceUrl,
    sourcePlatform: p.sourcePlatform,
    kind: p.kind,
    title: p.title,
    handle: p.handle,
    price: p.price,
    currency: p.currency,
    variantCount: p.variants.length,
    imageCount: p.images.length,
    stockStatus: p.stockStatus,
    featuredImageUrl: p.featuredImageUrl,
    scrapedAt: p.scrapedAt,
    skus
  };
}

export class Database {
  readonly projects: Collection<Project>;
  readonly categories: Collection<Category>;
  readonly urls: Collection<UrlEntry>;
  readonly jobs: Collection<ScrapeJob>;
  readonly issues: Collection<ValidationIssue>;
  readonly exportsLog: Collection<ExportRecord>;
  readonly logs: Collection<LogEntry>;
  readonly products: DocStore<CanonicalProduct, ProductIndexEntry>;

  private settingsFile: string;
  private settings: AppSettings;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.projects = new Collection<Project>(path.join(dataDir, 'projects.json'));
    this.categories = new Collection<Category>(path.join(dataDir, 'categories.json'));
    this.urls = new Collection<UrlEntry>(path.join(dataDir, 'urls.json'));
    this.jobs = new Collection<ScrapeJob>(path.join(dataDir, 'jobs.json'));
    this.issues = new Collection<ValidationIssue>(path.join(dataDir, 'issues.json'));
    this.exportsLog = new Collection<ExportRecord>(path.join(dataDir, 'exports.json'));
    this.logs = new Collection<LogEntry>(path.join(dataDir, 'logs.json'), 1500);
    this.products = new DocStore<CanonicalProduct, ProductIndexEntry>(
      path.join(dataDir, 'products'),
      summariseProduct
    );

    this.settingsFile = path.join(dataDir, 'settings.json');
    this.settings = { ...DEFAULT_SETTINGS };
    if (existsSync(this.settingsFile)) {
      try {
        const stored = JSON.parse(readFileSync(this.settingsFile, 'utf8')) as Partial<AppSettings>;
        this.settings = { ...DEFAULT_SETTINGS, ...stored };
      } catch {
        /* fall back to defaults */
      }
    }
  }

  /* ---------------- settings ---------------- */

  getSettings(): AppSettings {
    return { ...this.settings };
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...patch };
    writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2), 'utf8');
    return this.getSettings();
  }

  /* ---------------- projects ---------------- */

  createProject(input: { name: string; description?: string; targetFormat: TargetFormat; exportProfileId?: string }): Project {
    const p: Project = {
      id: newId('prj_'),
      name: input.name.trim() || 'Untitled project',
      description: input.description?.trim() ?? '',
      targetFormat: input.targetFormat,
      exportProfileId:
        input.exportProfileId ?? (input.targetFormat === 'shopify' ? 'shopify-legacy' : 'woocommerce-default'),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      archived: false
    };
    return this.projects.insert(p);
  }

  deleteProject(id: string): void {
    this.categories.removeWhere((c) => c.projectId === id);
    this.urls.removeWhere((u) => u.projectId === id);
    this.jobs.removeWhere((j) => j.projectId === id);
    this.issues.removeWhere((i) => i.projectId === id);
    this.exportsLog.removeWhere((e) => e.projectId === id);
    this.products.removeWhere((p) => p.projectId === id);
    this.projects.remove(id);
  }

  /* ---------------- categories ---------------- */

  createCategory(input: { projectId: string; name: string; path?: string; googleProductCategory?: string | null }): Category {
    const name = input.name.trim();
    const existing = this.categories.first((c) => c.projectId === input.projectId && c.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const siblings = this.categories.find((c) => c.projectId === input.projectId);
    const c: Category = {
      id: newId('cat_'),
      projectId: input.projectId,
      name,
      path: (input.path ?? name).trim(),
      googleProductCategory: input.googleProductCategory ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      position: siblings.length
    };
    return this.categories.insert(c);
  }

  deleteCategory(id: string, deleteUrls: boolean): void {
    if (deleteUrls) {
      const urlIds = this.urls.find((u) => u.categoryId === id).map((u) => u.id);
      this.urls.removeWhere((u) => urlIds.includes(u.id));
      this.products.removeWhere((p) => p.categoryId === id);
    } else {
      for (const u of this.urls.find((x) => x.categoryId === id)) {
        this.urls.update(u.id, { categoryId: null });
      }
      for (const e of this.products.indexAll().filter((p) => p.categoryId === id)) {
        const doc = this.products.get(e.id);
        if (doc) {
          doc.categoryId = null;
          doc.categoryPath = null;
          this.products.put(doc);
        }
      }
    }
    this.categories.remove(id);
  }

  /* ---------------- urls ---------------- */

  addUrl(projectId: string, categoryId: string | null, rawUrl: string, coerced: string): { entry: UrlEntry | null; duplicate: boolean } {
    const normalized = normalizeUrl(coerced);
    const dupe = this.urls.first((u) => u.projectId === projectId && u.normalizedUrl === normalized);
    if (dupe) return { entry: dupe, duplicate: true };
    const entry: UrlEntry = {
      id: newId('url_'),
      projectId,
      categoryId,
      url: coerced,
      normalizedUrl: normalized,
      state: 'pending',
      attempts: 0,
      lastError: null,
      lastErrorCode: null,
      productId: null,
      note: null,
      addedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      durationMs: null
    };
    void rawUrl;
    return { entry: this.urls.insert(entry), duplicate: false };
  }

  setUrlState(id: string, state: UrlState, patch: Partial<UrlEntry> = {}): void {
    if (!this.urls.get(id)) return;
    this.urls.update(id, { state, ...patch });
  }

  /* ---------------- products ---------------- */

  saveProduct(p: CanonicalProduct): void {
    this.products.put(p);
  }

  findProductByUrl(projectId: string, url: string): ProductIndexEntry | undefined {
    const n = normalizeUrl(url);
    return this.products.indexAll().find((e) => e.projectId === projectId && e.normalizedUrl === n);
  }

  /* ---------------- validation ---------------- */

  replaceIssues(projectId: string, issues: ValidationIssue[]): void {
    this.issues.removeWhere((i) => i.projectId === projectId);
    this.issues.insertMany(issues);
  }

  worstSeverityFor(productId: string): Severity | null {
    let worst: Severity | null = null;
    const rank: Record<Severity, number> = { INFO: 0, WARNING: 1, ERROR: 2, CRITICAL: 3 };
    for (const i of this.issues.all()) {
      if (i.productId !== productId) continue;
      if (worst === null || rank[i.severity] > rank[worst]) worst = i.severity;
    }
    return worst;
  }

  /* ---------------- lifecycle ---------------- */

  /** Cancels pending saves. Call after flushAllSync() when shutting down. */
  close(): void {
    this.projects.close();
    this.categories.close();
    this.urls.close();
    this.jobs.close();
    this.issues.close();
    this.exportsLog.close();
    this.logs.close();
    this.products.close();
  }

  flushAllSync(): void {
    this.projects.flushSync();
    this.categories.flushSync();
    this.urls.flushSync();
    this.jobs.flushSync();
    this.issues.flushSync();
    this.exportsLog.flushSync();
    this.logs.trimTo(3000);
    this.logs.flushSync();
    this.products.flushSync();
  }
}

let instance: Database | null = null;

export function initDb(dataDir: string): Database {
  instance = new Database(dataDir);
  return instance;
}

export function db(): Database {
  if (!instance) throw new Error('Database has not been initialised');
  return instance;
}
