import { h, icon, mount, type IconName } from './lib/dom.js';
import { badge, banner, button, emptyState, toast } from './lib/ui.js';
import { api, hasBridge } from './lib/api.js';
import {
  currentProject,
  getState,
  loadProjectData,
  loadProjects,
  loadSettings,
  notify,
  patch,
  recallView,
  refreshForView,
  setView,
  subscribe,
  switchProject,
  type ViewId
} from './lib/state.js';
import { renderDashboard } from './views/dashboard.js';
import { openNewProject, renderProjects } from './views/projects.js';
import { renderCategories } from './views/categories.js';
import { renderUrls } from './views/urls.js';
import { renderScraping } from './views/scraping.js';
import { renderProducts } from './views/products.js';
import { renderValidation } from './views/validation.js';
import { renderExports } from './views/exports.js';
import { renderSettings } from './views/settings.js';
import { plural } from './lib/format.js';

interface NavEntry {
  id: ViewId;
  label: string;
  icon: IconName;
  group: string;
  count?: () => number | null;
  alert?: () => boolean;
}

const NAV: NavEntry[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', group: 'Overview' },
  { id: 'projects', label: 'Projects', icon: 'projects', group: 'Overview', count: () => getState().projects.length },
  {
    id: 'categories',
    label: 'Categories',
    icon: 'categories',
    group: 'Set up',
    count: () => getState().categories.length
  },
  { id: 'urls', label: 'URLs', icon: 'urls', group: 'Set up', count: () => getState().urls.length },
  { id: 'scraping', label: 'Collection', icon: 'scraping', group: 'Work' },
  {
    id: 'products',
    label: 'Products',
    icon: 'products',
    group: 'Work',
    count: () => getState().stats?.products ?? 0
  },
  {
    id: 'validation',
    label: 'Validation',
    icon: 'validation',
    group: 'Work',
    count: () => {
      const s = getState().stats?.issuesBySeverity;
      if (!s) return null;
      const n = s.CRITICAL + s.ERROR + s.WARNING;
      return n || null;
    },
    alert: () => {
      const s = getState().stats?.issuesBySeverity;
      return !!s && s.CRITICAL + s.ERROR > 0;
    }
  },
  { id: 'exports', label: 'Exports', icon: 'exports', group: 'Work' },
  { id: 'settings', label: 'Settings', icon: 'settings', group: 'App' }
];

const VIEW_TITLES: Record<ViewId, { title: string; subtitle: string }> = {
  dashboard: { title: 'Dashboard', subtitle: 'Where this project stands right now' },
  projects: { title: 'Projects', subtitle: 'One per store or migration' },
  categories: { title: 'Categories', subtitle: 'Group your URLs — the category carries through to the export' },
  urls: { title: 'Product URLs', subtitle: 'Only the addresses you list are visited' },
  scraping: { title: 'Collection', subtitle: 'Accuracy before speed' },
  products: { title: 'Products', subtitle: 'Everything collected, with its variants' },
  validation: { title: 'Validation', subtitle: 'Problems caught before you import' },
  exports: { title: 'Exports', subtitle: 'Import-ready files' },
  settings: { title: 'Settings', subtitle: 'How the app behaves' }
};

/* ------------------------------------------------------------------ */

const root = document.getElementById('app');
if (!root) throw new Error('The application root element is missing.');

const navHost = h('nav', { class: 'nav' });
const headerHost = h('header', { class: 'header' });
const mainHost = h('main', { class: 'main' });

const shell = h(
  'div',
  { class: 'app' },
  h(
    'div',
    { class: 'brand' },
    h('div', { class: 'brand__mark' }, 'T'),
    h(
      'div',
      { class: 'brand__text' },
      h('div', { class: 'brand__name' }, 'ToTo Company'),
      h('div', { class: 'brand__by' }, 'Made by ', h('b', null, 'Rahul Raj'))
    )
  ),
  headerHost,
  navHost,
  mainHost
);

mount(root, shell);

/* ------------------------------------------------------------------ */

function renderNav(): void {
  const s = getState();
  const groups: string[] = [];
  for (const n of NAV) if (!groups.includes(n.group)) groups.push(n.group);

  const children: Node[] = [];
  for (const group of groups) {
    children.push(h('div', { class: 'nav__group' }, group));
    for (const entry of NAV.filter((n) => n.group === group)) {
      const count = entry.count?.();
      children.push(
        h(
          'button',
          {
            class: `nav__item${s.view === entry.id ? ' is-active' : ''}`,
            type: 'button',
            on: { click: () => setView(entry.id) }
          },
          icon(entry.icon, 16),
          h('span', null, entry.label),
          count ? h('span', { class: `nav__count${entry.alert?.() ? ' is-alert' : ''}` }, String(count)) : null
        )
      );
    }
  }

  children.push(
    h(
      'div',
      { class: 'nav__footer' },
      h('div', null, 'ToTo Company'),
      h('div', { class: 'faint' }, 'Made by Rahul Raj'),
      s.progress && (s.progress.state === 'running' || s.progress.state === 'paused')
        ? h(
            'div',
            { class: 'row', style: 'gap:6px;margin-top:8px' },
            h('i', { class: 'pulse' }),
            h('span', { class: 'tiny' }, `${s.progress.completed}/${s.progress.total}`)
          )
        : null
    )
  );

  mount(navHost, ...children);
}

function renderHeader(): void {
  const s = getState();
  const project = currentProject();
  const meta = VIEW_TITLES[s.view];

  mount(
    headerHost,
    h('div', { class: 'header__title' }, h('h1', null, meta.title), h('p', null, meta.subtitle)),
    h('div', { class: 'header__spacer' }),
    s.progress && (s.progress.state === 'running' || s.progress.state === 'paused')
      ? h(
          'button',
          {
            class: 'projectpick__btn',
            type: 'button',
            title: 'Go to the collection view',
            on: { click: () => setView('scraping') }
          },
          s.progress.state === 'paused' ? icon('pause', 15) : h('i', { class: 'pulse' }),
          h(
            'div',
            { class: 'projectpick__label' },
            h('small', null, s.progress.state === 'paused' ? 'Paused' : 'Collecting'),
            h('span', null, `${s.progress.completed + s.progress.failed} / ${s.progress.total}`)
          )
        )
      : null,
    projectPicker(project?.name ?? null)
  );
}

function projectPicker(name: string | null): HTMLElement {
  const s = getState();
  return h(
    'div',
    { class: 'projectpick' },
    h(
      'button',
      {
        class: 'projectpick__btn',
        type: 'button',
        on: {
          click: (e: MouseEvent) => {
            e.stopPropagation();
            openProjectMenu(e.currentTarget as HTMLElement);
          }
        }
      },
      icon('projects', 15),
      h(
        'div',
        { class: 'projectpick__label' },
        h('small', null, 'Project'),
        h('span', null, name ?? 'None selected')
      ),
      icon('chevronDown', 14),
      s.projects.length > 1 ? null : null
    )
  );
}

function openProjectMenu(anchor: HTMLElement): void {
  const s = getState();
  const rect = anchor.getBoundingClientRect();

  const menu = h(
    'div',
    {
      class: 'card',
      style: `position:fixed;top:${rect.bottom + 6}px;right:${window.innerWidth - rect.right}px;min-width:${Math.max(
        260,
        rect.width
      )}px;z-index:150;box-shadow:var(--shadow-lg);padding:6px`
    },
    ...(s.projects.length
      ? s.projects.map((p) =>
          h(
            'button',
            {
              class: `nav__item${p.id === s.projectId ? ' is-active' : ''}`,
              type: 'button',
              on: {
                click: () => {
                  close();
                  void switchProject(p.id);
                }
              }
            },
            icon('folder', 15),
            h('span', null, p.name),
            badge(p.targetFormat === 'shopify' ? 'Shopify' : 'Woo')
          )
        )
      : [h('div', { class: 'tiny muted', style: 'padding:10px' }, 'No projects yet.')]),
    h('div', { style: 'height:1px;background:var(--line-soft);margin:6px 4px' }),
    h(
      'button',
      {
        class: 'nav__item',
        type: 'button',
        on: {
          click: () => {
            close();
            openNewProject();
          }
        }
      },
      icon('plus', 15),
      h('span', null, 'New project…')
    )
  );

  const close = (): void => {
    menu.remove();
    document.removeEventListener('click', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDoc = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('click', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

function renderMain(): void {
  const s = getState();

  if (!s.ready) {
    mount(mainHost, h('div', { class: 'view' }, h('p', { class: 'muted' }, 'Starting up…')));
    return;
  }

  if (s.projects.length === 0 && s.view !== 'projects' && s.view !== 'settings') {
    mount(
      mainHost,
      h(
        'div',
        { class: 'view' },
        h(
          'div',
          { style: 'max-width:620px;margin:40px auto 0' },
          h(
            'div',
            { class: 'card card__pad', style: 'text-align:center' },
            h('div', { class: 'brand__mark', style: 'width:52px;height:52px;border-radius:15px;font-size:21px;margin:0 auto 16px' }, 'T'),
            h('h2', { style: 'margin:0 0 6px;font-size:19px;letter-spacing:-0.02em' }, 'Welcome to ToTo Company'),
            h(
              'p',
              { class: 'muted', style: 'margin:0 auto 20px;max-width:440px;line-height:1.65' },
              'Collect product data from the exact pages you list, check it, and turn it into an import-ready file for Shopify or WooCommerce.'
            ),
            button({ label: 'Create your first project', icon: 'plus', variant: 'primary', onClick: openNewProject }),
            h(
              'div',
              { class: 'tiny faint', style: 'margin-top:22px' },
              'Add URLs → choose a category → collect → validate → export → import.'
            )
          )
        )
      )
    );
    return;
  }

  switch (s.view) {
    case 'dashboard':
      mount(mainHost, renderDashboard());
      break;
    case 'projects':
      mount(mainHost, renderProjects());
      break;
    case 'categories':
      mount(mainHost, renderCategories());
      break;
    case 'urls':
      mount(mainHost, renderUrls());
      break;
    case 'scraping':
      mount(mainHost, renderScraping());
      break;
    case 'products':
      mount(mainHost, renderProducts());
      break;
    case 'validation':
      mount(mainHost, renderValidation());
      break;
    case 'exports':
      mount(mainHost, renderExports());
      break;
    case 'settings':
      mount(mainHost, renderSettings());
      break;
  }
}

/** A full re-render; cheap at this size and keeps the data flow one-directional. */
function render(): void {
  renderNav();
  renderHeader();
  renderMain();
}

subscribe(render);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot(): Promise<void> {
  if (!hasBridge()) {
    mount(
      mainHost,
      h(
        'div',
        { class: 'view' },
        emptyState({
          icon: 'error',
          title: 'The application could not start',
          body:
            'The interface is not connected to the application core. Reopening ToTo Company usually resolves this; if it persists, reinstall the app.'
        })
      )
    );
    return;
  }

  if (navigator.userAgent.includes('Mac')) document.body.classList.add('mac');

  try {
    await loadSettings();
    const settings = getState().settings;
    if (settings) document.documentElement.setAttribute('data-theme', settings.theme);

    await loadProjects();
    getState().view = recallView();
    await loadProjectData();
    patch({ ready: true });
    await refreshForView();

    const active = await api.scrape.active();
    if (active) patch({ progress: active });
  } catch (err) {
    toast(`Could not load your data: ${err instanceof Error ? err.message : String(err)}`, 'err', 10000);
    patch({ ready: true });
  }

  api.on('progress', (e) => {
    const previous = getState().progress;
    patch({ progress: e });
    const finished = e.state === 'completed' || e.state === 'cancelled' || e.state === 'failed';
    if (finished && previous && previous.state !== e.state) {
      void loadProjectData();
      void refreshForView();
      if (e.message) toast(e.message, e.failed > 0 ? 'warn' : 'ok', 7000);
    }
  });

  api.on('dataChanged', () => {
    // The main process changed something behind our back (a queue write, a
    // recovered job). Refresh the counts that every view depends on.
    void loadProjectData();
  });

  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const map: Record<string, ViewId> = {
      '1': 'dashboard',
      '2': 'projects',
      '3': 'categories',
      '4': 'urls',
      '5': 'scraping',
      '6': 'products',
      '7': 'validation',
      '8': 'exports',
      '9': 'settings'
    };
    const target = map[e.key];
    if (target) {
      e.preventDefault();
      setView(target);
    }
  });

  notify();
}

void boot();

export { plural, banner };
