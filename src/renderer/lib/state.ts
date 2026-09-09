import type { CanonicalProduct } from '../../shared/canonical';
import type {
  AppSettings,
  Category,
  DashboardStats,
  ExportRecord,
  JobProgressEvent,
  Project,
  UrlEntry,
  ValidationIssue
} from '../../shared/types';
import type { ProductSummary } from '../../shared/ipc';
import { api } from './api.js';

export type ViewId =
  | 'dashboard'
  | 'projects'
  | 'categories'
  | 'urls'
  | 'scraping'
  | 'products'
  | 'validation'
  | 'exports'
  | 'settings';

export interface AppState {
  ready: boolean;
  view: ViewId;
  projects: Project[];
  projectId: string | null;
  categories: Array<Category & { urlCount: number; productCount: number }>;
  urls: UrlEntry[];
  products: ProductSummary[];
  productTotal: number;
  issues: ValidationIssue[];
  exportHistory: ExportRecord[];
  settings: AppSettings | null;
  stats: DashboardStats | null;
  progress: JobProgressEvent | null;
  /** Filters that persist while the operator moves between views. */
  filters: {
    categoryId: string | null;
    urlState: string | null;
    productSearch: string;
    productKind: string | null;
    onlyReview: boolean;
    severity: string | null;
  };
  selection: {
    urls: Set<string>;
    products: Set<string>;
  };
}

const state: AppState = {
  ready: false,
  view: 'dashboard',
  projects: [],
  projectId: null,
  categories: [],
  urls: [],
  products: [],
  productTotal: 0,
  issues: [],
  exportHistory: [],
  settings: null,
  stats: null,
  progress: null,
  filters: {
    categoryId: null,
    urlState: null,
    productSearch: '',
    productKind: null,
    onlyReview: false,
    severity: null
  },
  selection: { urls: new Set(), products: new Set() }
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function getState(): AppState {
  return state;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let scheduled = false;
export function notify(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    for (const fn of listeners) fn();
  });
}

export function patch(changes: Partial<AppState>): void {
  Object.assign(state, changes);
  notify();
}

export function setView(view: ViewId): void {
  if (state.view === view) return;
  state.view = view;
  state.selection.urls.clear();
  state.selection.products.clear();
  notify();
  void refreshForView();
}

export function currentProject(): Project | null {
  return state.projects.find((p) => p.id === state.projectId) ?? null;
}

export function currentCategory(): Category | null {
  const id = state.filters.categoryId;
  return id ? state.categories.find((c) => c.id === id) ?? null : null;
}

const LAST_PROJECT_KEY = 'lift.lastProject';
const LAST_VIEW_KEY = 'lift.lastView';

export function rememberSession(): void {
  try {
    if (state.projectId) localStorage.setItem(LAST_PROJECT_KEY, state.projectId);
    localStorage.setItem(LAST_VIEW_KEY, state.view);
  } catch {
    /* storage may be unavailable; the app still works */
  }
}

function recallProject(projects: Project[]): string | null {
  try {
    const id = localStorage.getItem(LAST_PROJECT_KEY);
    if (id && projects.some((p) => p.id === id)) return id;
  } catch {
    /* ignore */
  }
  return projects[0]?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

export async function loadProjects(): Promise<void> {
  const projects = await api.projects.list();
  state.projects = projects;
  if (!state.projectId || !projects.some((p) => p.id === state.projectId)) {
    state.projectId = recallProject(projects);
  }
  notify();
}

export async function loadProjectData(): Promise<void> {
  const id = state.projectId;
  if (!id) {
    state.categories = [];
    state.urls = [];
    state.products = [];
    state.issues = [];
    state.exportHistory = [];
    state.stats = null;
    notify();
    return;
  }
  const [categories, urls, stats] = await Promise.all([
    api.categories.list(id),
    api.urls.list(id),
    api.dashboard.stats(id)
  ]);
  state.categories = categories;
  state.urls = urls;
  state.stats = stats;
  if (
    state.filters.categoryId &&
    state.filters.categoryId !== '__none__' &&
    !categories.some((c) => c.id === state.filters.categoryId)
  ) {
    state.filters.categoryId = null;
  }
  notify();
}

export async function loadProducts(): Promise<void> {
  const id = state.projectId;
  if (!id) return;
  const res = await api.products.list({
    projectId: id,
    categoryId: state.filters.categoryId === '__none__' ? null : state.filters.categoryId,
    search: state.filters.productSearch || undefined,
    kind: state.filters.productKind ?? undefined,
    onlyNeedingReview: state.filters.onlyReview,
    limit: 500
  });
  state.products = res.items;
  state.productTotal = res.total;
  notify();
}

export async function loadIssues(): Promise<void> {
  const id = state.projectId;
  if (!id) return;
  state.issues = await api.validation.list(id, state.filters.severity ? { severity: state.filters.severity } : undefined);
  notify();
}

export async function loadExports(): Promise<void> {
  const id = state.projectId;
  if (!id) return;
  state.exportHistory = await api.exports.history(id);
  notify();
}

export async function loadSettings(): Promise<void> {
  state.settings = await api.settings.get();
  notify();
}

/** Reloads only what the visible view needs. */
export async function refreshForView(): Promise<void> {
  const view = state.view;
  if (view === 'products') await loadProducts();
  else if (view === 'validation') {
    // Findings are grouped by product, so the summaries are needed to name them.
    await Promise.all([loadIssues(), loadProducts()]);
  }
  else if (view === 'exports') await loadExports();
  else if (view === 'settings') await loadSettings();
  else if (view === 'dashboard' || view === 'scraping') await loadProjectData();
  else await loadProjectData();
  rememberSession();
}

export async function switchProject(id: string | null): Promise<void> {
  state.projectId = id;
  state.filters.categoryId = null;
  state.selection.urls.clear();
  state.selection.products.clear();
  notify();
  await loadProjectData();
  await refreshForView();
}

export async function refreshAll(): Promise<void> {
  await loadProjects();
  await loadProjectData();
  await refreshForView();
}

export function recallView(): ViewId {
  try {
    const v = localStorage.getItem(LAST_VIEW_KEY) as ViewId | null;
    const valid: ViewId[] = ['dashboard', 'projects', 'categories', 'urls', 'scraping', 'products', 'validation', 'exports', 'settings'];
    if (v && valid.includes(v)) return v;
  } catch {
    /* ignore */
  }
  return 'dashboard';
}

/* ------------------------------------------------------------------ */
/* Derived helpers used by several views                               */
/* ------------------------------------------------------------------ */

/** `__none__` is the filter for URLs that belong to no category. */
export function urlsInScope(): UrlEntry[] {
  const { categoryId, urlState } = state.filters;
  return state.urls.filter((u) => {
    const categoryMatches =
      categoryId === null || (categoryId === '__none__' ? u.categoryId === null : u.categoryId === categoryId);
    return categoryMatches && (urlState === null || u.state === urlState);
  });
}

export function issuesForProduct(productId: string): ValidationIssue[] {
  return state.issues.filter((i) => i.productId === productId);
}

export async function loadProduct(id: string): Promise<CanonicalProduct | null> {
  return api.products.get(id);
}

export function isScraping(): boolean {
  const p = state.progress;
  return !!p && (p.state === 'running' || p.state === 'queued');
}
