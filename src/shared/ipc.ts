import type { CanonicalProduct } from './canonical';
import type {
  AppSettings,
  Category,
  DashboardStats,
  ExportOptions,
  ExportRecord,
  JobProgressEvent,
  LogEntry,
  Project,
  ScrapeJob,
  TargetFormat,
  UrlEntry,
  ValidationIssue,
  ValidationRunSummary
} from './types';

export const CH = {
  /* projects */
  projectList: 'project:list',
  projectCreate: 'project:create',
  projectUpdate: 'project:update',
  projectDelete: 'project:delete',
  projectGet: 'project:get',

  /* categories */
  categoryList: 'category:list',
  categoryCreate: 'category:create',
  categoryUpdate: 'category:update',
  categoryDelete: 'category:delete',

  /* urls */
  urlList: 'url:list',
  urlAdd: 'url:add',
  urlAddBulk: 'url:addBulk',
  urlUpdate: 'url:update',
  urlDelete: 'url:delete',
  urlDeleteMany: 'url:deleteMany',
  urlMove: 'url:move',
  urlImportFile: 'url:importFile',
  urlResetState: 'url:resetState',

  /* scraping */
  scrapeStart: 'scrape:start',
  scrapePause: 'scrape:pause',
  scrapeResume: 'scrape:resume',
  scrapeCancel: 'scrape:cancel',
  scrapeRetryFailed: 'scrape:retryFailed',
  scrapeRescrape: 'scrape:rescrape',
  scrapeActive: 'scrape:active',
  scrapeJobs: 'scrape:jobs',
  scrapeTestUrl: 'scrape:testUrl',

  /* products */
  productList: 'product:list',
  productGet: 'product:get',
  productDelete: 'product:delete',
  productTrace: 'product:trace',
  productPatch: 'product:patch',

  /* validation */
  validationRun: 'validation:run',
  validationList: 'validation:list',
  validationAck: 'validation:ack',
  validationClear: 'validation:clear',

  /* export */
  exportRun: 'export:run',
  exportPreview: 'export:preview',
  exportHistory: 'export:history',
  exportProfiles: 'export:profiles',
  exportReveal: 'export:reveal',

  /* settings + misc */
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  dashboardStats: 'dashboard:stats',
  logsList: 'logs:list',
  chooseDirectory: 'dialog:chooseDirectory',
  chooseFile: 'dialog:chooseFile',
  appInfo: 'app:info',
  openExternal: 'app:openExternal',

  /* events (main -> renderer) */
  evtProgress: 'evt:progress',
  evtLog: 'evt:log',
  evtDataChanged: 'evt:dataChanged'
} as const;

export interface ProductListQuery {
  projectId: string;
  categoryId?: string | null;
  search?: string;
  kind?: string;
  onlyNeedingReview?: boolean;
  limit?: number;
  offset?: number;
}

export interface ProductListResult {
  items: ProductSummary[];
  total: number;
}

export interface ProductSummary {
  id: string;
  title: string | null;
  sourceUrl: string;
  sourcePlatform: string;
  kind: string;
  categoryPath: string | null;
  price: number | null;
  currency: string | null;
  variantCount: number;
  imageCount: number;
  stockStatus: string;
  worstSeverity: string | null;
  issueCount: number;
  scrapedAt: string;
  featuredImageUrl: string | null;
}

export interface ExportPreview {
  headers: string[];
  rows: string[][];
  totalRows: number;
  skipped: Array<{ productId: string; title: string | null; reason: string }>;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  dataDir: string;
}

export interface TotoApi {
  projects: {
    list(): Promise<Project[]>;
    get(id: string): Promise<Project | null>;
    create(input: { name: string; description?: string; targetFormat: TargetFormat; exportProfileId?: string }): Promise<Project>;
    update(id: string, patch: Partial<Project>): Promise<Project>;
    remove(id: string): Promise<void>;
  };
  categories: {
    list(projectId: string): Promise<Array<Category & { urlCount: number; productCount: number }>>;
    create(input: { projectId: string; name: string; path?: string; googleProductCategory?: string | null }): Promise<Category>;
    update(id: string, patch: Partial<Category>): Promise<Category>;
    remove(id: string, opts?: { deleteUrls?: boolean }): Promise<void>;
  };
  urls: {
    list(projectId: string, categoryId?: string | null): Promise<UrlEntry[]>;
    add(input: { projectId: string; categoryId: string | null; url: string }): Promise<{ added: UrlEntry | null; duplicate: boolean; invalid: boolean; reason?: string }>;
    addBulk(input: { projectId: string; categoryId: string | null; text: string }): Promise<{ added: number; duplicates: number; invalid: string[] }>;
    update(id: string, patch: Partial<UrlEntry>): Promise<UrlEntry>;
    remove(id: string): Promise<void>;
    removeMany(ids: string[]): Promise<void>;
    move(ids: string[], categoryId: string | null): Promise<void>;
    importFile(projectId: string, categoryId: string | null): Promise<{ added: number; duplicates: number; invalid: string[]; cancelled?: boolean }>;
    resetState(ids: string[]): Promise<void>;
  };
  scrape: {
    start(input: { projectId: string; categoryIds?: string[]; urlIds?: string[]; label?: string }): Promise<ScrapeJob>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    cancel(): Promise<void>;
    retryFailed(projectId: string): Promise<ScrapeJob | null>;
    rescrape(productIds: string[]): Promise<ScrapeJob | null>;
    active(): Promise<JobProgressEvent | null>;
    jobs(projectId: string): Promise<ScrapeJob[]>;
    testUrl(url: string): Promise<{ platform: string; reachable: boolean; status: number | null; detail: string }>;
  };
  products: {
    list(q: ProductListQuery): Promise<ProductListResult>;
    get(id: string): Promise<CanonicalProduct | null>;
    remove(ids: string[]): Promise<void>;
    trace(id: string): Promise<Array<{ field: string; value: unknown; source: string; confidence: string; note?: string }>>;
    patch(id: string, patch: Record<string, unknown>): Promise<CanonicalProduct>;
  };
  validation: {
    run(projectId: string): Promise<ValidationRunSummary>;
    list(projectId: string, opts?: { severity?: string; productId?: string }): Promise<ValidationIssue[]>;
    acknowledge(ids: string[], value: boolean): Promise<void>;
    clear(projectId: string): Promise<void>;
  };
  exports: {
    run(opts: ExportOptions): Promise<ExportRecord>;
    preview(opts: ExportOptions, limit?: number): Promise<ExportPreview>;
    history(projectId: string): Promise<ExportRecord[]>;
    profiles(): Promise<Array<{ id: string; format: TargetFormat; label: string; description: string; columns: string[] }>>;
    reveal(filePath: string): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
  dashboard: { stats(projectId: string | null): Promise<DashboardStats> };
  logs: { list(opts?: { limit?: number; level?: string }): Promise<LogEntry[]> };
  system: {
    chooseDirectory(): Promise<string | null>;
    info(): Promise<AppInfo>;
    openExternal(url: string): Promise<void>;
  };
  on(channel: 'progress', cb: (e: JobProgressEvent) => void): () => void;
  on(channel: 'log', cb: (e: LogEntry) => void): () => void;
  on(channel: 'dataChanged', cb: (e: { scope: string; projectId?: string }) => void): () => void;
}
