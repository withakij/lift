import type { CanonicalProduct, ExtractionSource } from './canonical';

/* ------------------------------------------------------------------ */
/* Projects / categories / URLs                                        */
/* ------------------------------------------------------------------ */

export type TargetFormat = 'shopify' | 'woocommerce';

export interface Project {
  id: string;
  name: string;
  description: string;
  targetFormat: TargetFormat;
  /** Adapter profile id, e.g. "shopify-legacy" | "shopify-2024" | "woocommerce-default". */
  exportProfileId: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface Category {
  id: string;
  projectId: string;
  name: string;
  /** Full path used on export, e.g. "Electronics > Monitors". */
  path: string;
  /** Optional Google product category, only if the OPERATOR typed one. */
  googleProductCategory: string | null;
  createdAt: string;
  updatedAt: string;
  position: number;
}

export type UrlState =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'warning'
  | 'failed'
  | 'retrying'
  | 'skipped'
  | 'paused';

export interface UrlEntry {
  id: string;
  projectId: string;
  categoryId: string | null;
  url: string;
  /** Normalised for duplicate detection (lowercased host, no tracking params). */
  normalizedUrl: string;
  state: UrlState;
  attempts: number;
  lastError: string | null;
  lastErrorCode: string | null;
  productId: string | null;
  note: string | null;
  addedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

/* ------------------------------------------------------------------ */
/* Scrape jobs                                                         */
/* ------------------------------------------------------------------ */

export type JobState = 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface ScrapeJob {
  id: string;
  projectId: string;
  /** Empty array = the whole project. */
  categoryIds: string[];
  urlIds: string[];
  state: JobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  completed: number;
  failed: number;
  warned: number;
  skipped: number;
  currentUrl: string | null;
  currentStage: string | null;
  label: string;
}

export interface JobProgressEvent {
  jobId: string;
  projectId: string;
  state: JobState;
  total: number;
  completed: number;
  failed: number;
  warned: number;
  skipped: number;
  currentUrl: string | null;
  currentTitle: string | null;
  currentStage: string | null;
  message?: string;
}

export interface LogEntry {
  id: string;
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  projectId?: string;
  urlId?: string;
  detail?: string;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type Severity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export const SEVERITY_ORDER: Record<Severity, number> = {
  INFO: 0,
  WARNING: 1,
  ERROR: 2,
  CRITICAL: 3
};

export interface ValidationIssue {
  id: string;
  projectId: string;
  productId: string | null;
  variantId: string | null;
  ruleId: string;
  severity: Severity;
  /** Plain-English, operator-facing. */
  message: string;
  /** What to do about it. */
  hint: string | null;
  field: string | null;
  observed: string | null;
  createdAt: string;
  acknowledged: boolean;
}

export interface ValidationRunSummary {
  projectId: string;
  ranAt: string;
  productCount: number;
  issueCount: number;
  bySeverity: Record<Severity, number>;
  blockingExport: number;
}

/* ------------------------------------------------------------------ */
/* Exports                                                             */
/* ------------------------------------------------------------------ */

export interface ExportOptions {
  projectId: string;
  format: TargetFormat;
  profileId: string;
  /** null = every category */
  categoryIds: string[] | null;
  /** null = every product in scope */
  productIds: string[] | null;
  includeWarnings: boolean;
  includeErrors: boolean;
  excludeFailed: boolean;
  outputDir: string | null;
  fileName: string | null;
}

export interface ExportRecord {
  id: string;
  projectId: string;
  format: TargetFormat;
  profileId: string;
  createdAt: string;
  productCount: number;
  rowCount: number;
  skippedCount: number;
  status: 'success' | 'partial' | 'failed';
  filePath: string;
  /** Size of the file as it was found on disk after writing. */
  byteSize?: number;
  message: string | null;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface AppSettings {
  /** Milliseconds between two requests to the SAME host. */
  perHostDelayMs: number;
  /** Simultaneous URLs in flight across all hosts. */
  concurrency: number;
  /** Simultaneous requests to a single host. */
  perHostConcurrency: number;
  requestTimeoutMs: number;
  renderTimeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  userAgent: string;
  respectRobotsTxt: boolean;
  /** never | auto | always */
  browserRenderMode: 'never' | 'auto' | 'always';
  /** Click through variant selectors in the browser when data is still missing. */
  enableVariantInteraction: boolean;
  downloadImages: boolean;
  validateImageUrls: boolean;
  imageValidationConcurrency: number;
  advancedMode: boolean;
  defaultExportDir: string | null;
  theme: 'dark' | 'light';
  /** Keep raw HTML snippets for debugging. Costs disk. */
  keepDebugSnippets: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  perHostDelayMs: 1200,
  concurrency: 3,
  perHostConcurrency: 1,
  requestTimeoutMs: 30000,
  renderTimeoutMs: 45000,
  maxRetries: 2,
  retryBackoffMs: 4000,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Lift/1.0',
  respectRobotsTxt: true,
  browserRenderMode: 'auto',
  enableVariantInteraction: true,
  downloadImages: false,
  validateImageUrls: true,
  imageValidationConcurrency: 4,
  advancedMode: false,
  defaultExportDir: null,
  theme: 'dark',
  keepDebugSnippets: true
};

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export interface DashboardStats {
  projects: number;
  categories: number;
  urls: number;
  urlsByState: Record<UrlState, number>;
  products: number;
  variants: number;
  productsNeedingReview: number;
  issuesBySeverity: Record<Severity, number>;
  lastExport: ExportRecord | null;
  activeJob: JobProgressEvent | null;
}

/* ------------------------------------------------------------------ */
/* Scrape result envelope                                              */
/* ------------------------------------------------------------------ */

export interface ScrapeOutcome {
  ok: boolean;
  url: string;
  product: CanonicalProduct | null;
  /** Operator-facing failure reason. */
  error: string | null;
  errorCode: string | null;
  /** Warnings raised during extraction, distinct from validation issues. */
  warnings: string[];
  layers: Array<{ layer: string; ran: boolean; produced: number; ms: number; note?: string }>;
  durationMs: number;
}

export interface FieldTrace {
  field: string;
  value: unknown;
  source: ExtractionSource;
  confidence: string;
  note?: string;
}
