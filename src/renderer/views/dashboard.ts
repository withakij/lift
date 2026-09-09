import { h, icon } from '../lib/dom.js';
import { badge, banner, button, emptyState, progressBar, sectionHead, segmentBar, stat, table } from '../lib/ui.js';
import { currentProject, getState, setView, type ViewId } from '../lib/state.js';
import { dateTime, hostOf, number, pathOf, plural, relativeTime, urlStateLabel } from '../lib/format.js';
import { startScrape, pauseScrape, resumeScrape, cancelScrape, retryFailed } from '../actions.js';
import { openNewProject } from './projects.js';

export function renderDashboard(): HTMLElement {
  const s = getState();
  const project = currentProject();

  if (!project) {
    return h(
      'div',
      { class: 'view' },
      emptyState({
        icon: 'projects',
        title: 'Start with a project',
        body:
          'A project holds your categories, the product URLs you want to collect, and the export format they will be written in. Create one to begin.',
        action: { label: 'Create a project', icon: 'plus', onClick: openNewProject }
      })
    );
  }

  const stats = s.stats;
  const urls = stats?.urlsByState;
  const done = (urls?.completed ?? 0) + (urls?.warning ?? 0);
  const totalUrls = stats?.urls ?? 0;

  return h(
    'div',
    { class: 'view' },

    liveOrIdlePanel(),

    h(
      'section',
      { class: 'section' },
      sectionHead({ title: 'Where this project stands' }),
      h(
        'div',
        { class: 'stats' },
        stat({
          label: 'Categories',
          value: number(stats?.categories ?? 0),
          meta: 'grouping your URLs',
          onClick: () => setView('categories')
        }),
        stat({
          label: 'Product URLs',
          value: number(totalUrls),
          meta: totalUrls ? `${number(done)} collected` : 'none added yet',
          onClick: () => setView('urls')
        }),
        stat({
          label: 'Products',
          value: number(stats?.products ?? 0),
          meta: `${plural(stats?.variants ?? 0, 'variant')}`,
          tone: 'accent',
          onClick: () => setView('products')
        }),
        stat({
          label: 'Failed',
          value: number(urls?.failed ?? 0),
          meta: urls?.failed ? 'can be retried' : 'nothing failed',
          tone: urls?.failed ? 'alert' : 'default',
          onClick: () => setView('urls')
        }),
        stat({
          label: 'Need review',
          value: number(stats?.productsNeedingReview ?? 0),
          meta: 'flagged by validation',
          tone: stats?.productsNeedingReview ? 'alert' : 'good',
          onClick: () => setView('validation')
        })
      )
    ),

    totalUrls > 0
      ? h(
          'section',
          { class: 'section' },
          sectionHead({
            title: 'Collection progress',
            actions: [button({ label: 'Manage URLs', size: 'sm', onClick: () => setView('urls') })]
          }),
          h(
            'div',
            { class: 'card card__pad' },
            segmentBar([
              { value: urls?.completed ?? 0, color: 'var(--ok)', title: 'Collected' },
              { value: urls?.warning ?? 0, color: 'var(--warn)', title: 'Collected with warnings' },
              { value: urls?.failed ?? 0, color: 'var(--err)', title: 'Failed' },
              { value: urls?.processing ?? 0, color: 'var(--accent)', title: 'In progress' },
              { value: urls?.pending ?? 0, color: 'var(--surface-hover)', title: 'Waiting' }
            ]),
            h(
              'div',
              { class: 'row row--wrap', style: 'margin-top:12px;gap:16px' },
              ...(
                [
                  ['completed', 'ok'],
                  ['warning', 'warn'],
                  ['failed', 'err'],
                  ['processing', 'info'],
                  ['pending', 'neutral'],
                  ['skipped', 'neutral']
                ] as const
              )
                .filter(([k]) => (urls?.[k] ?? 0) > 0)
                .map(([k, tone]) =>
                  h('div', { class: 'row', style: 'gap:6px' }, badge(`${urlStateLabel(k)} · ${urls?.[k] ?? 0}`, tone, true))
                )
            )
          )
        )
      : null,

    workflowStrip(),

    h(
      'div',
      { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start' },
      recentActivity(),
      exportSummary()
    )
  );
}

/* ------------------------------------------------------------------ */

function liveOrIdlePanel(): HTMLElement {
  const s = getState();
  const p = s.progress;
  const running = p && (p.state === 'running' || p.state === 'paused' || p.state === 'queued');

  if (!running) {
    const pending = s.urls.filter((u) => u.state === 'pending' || u.state === 'failed').length;
    return h(
      'section',
      { class: 'section' },
      h(
        'div',
        { class: 'live' },
        h(
          'div',
          { class: 'live__top' },
          h('div', { class: 'brand__mark', style: 'width:30px;height:30px;border-radius:9px;font-size:12px' }, 'T'),
          h(
            'div',
            null,
            h('div', { class: 'live__title' }, pending ? 'Ready to collect' : 'Nothing waiting'),
            h(
              'div',
              { class: 'live__sub' },
              pending
                ? `${plural(pending, 'URL')} ready to be collected.`
                : 'Every URL in this project has been processed.'
            )
          ),
          h('div', { class: 'header__spacer' }),
          pending
            ? button({ label: 'Start collecting', icon: 'play', variant: 'primary', onClick: () => void startScrape({}) })
            : button({ label: 'Add URLs', icon: 'plus', onClick: () => setView('urls') })
        )
      )
    );
  }

  const total = p.total || 1;
  const fraction = (p.completed + p.failed) / total;
  const paused = p.state === 'paused';

  return h(
    'section',
    { class: 'section' },
    h(
      'div',
      { class: 'live' },
      h(
        'div',
        { class: 'live__top' },
        paused ? icon('pause', 18) : h('i', { class: 'pulse' }),
        h(
          'div',
          null,
          h('div', { class: 'live__title' }, paused ? 'Collection paused' : 'Collecting products'),
          h('div', { class: 'live__sub' }, p.message ?? 'Working through the queue')
        ),
        h(
          'div',
          { class: 'live__count' },
          `${number(p.completed + p.failed)}`,
          h('small', null, ` / ${number(p.total)}`)
        )
      ),
      progressBar(fraction),
      p.currentUrl
        ? h(
            'div',
            { class: 'live__current' },
            icon('urls', 14),
            h(
              'div',
              { class: 'ellipsis', style: 'min-width:0' },
              p.currentTitle ? h('strong', null, p.currentTitle) : hostOf(p.currentUrl),
              p.currentTitle ? h('span', { class: 'faint' }, ` · ${hostOf(p.currentUrl)}`) : null
            ),
            p.currentStage ? h('span', { class: 'live__stage' }, p.currentStage) : null
          )
        : null,
      h(
        'div',
        { class: 'row', style: 'margin-top:14px;position:relative' },
        paused
          ? button({ label: 'Resume', icon: 'play', variant: 'primary', size: 'sm', onClick: () => void resumeScrape() })
          : button({ label: 'Pause', icon: 'pause', size: 'sm', onClick: () => void pauseScrape() }),
        button({ label: 'Stop', icon: 'stop', size: 'sm', onClick: () => void cancelScrape() }),
        h('div', { class: 'header__spacer' }),
        p.failed > 0 ? badge(`${p.failed} failed`, 'err') : null,
        p.warned > 0 ? badge(`${p.warned} to check`, 'warn') : null
      )
    )
  );
}

/* ------------------------------------------------------------------ */

interface Step {
  label: string;
  meta: string;
  done: boolean;
  view: ViewId;
}

function workflowStrip(): HTMLElement {
  const s = getState();
  const project = currentProject();
  const stats = s.stats;
  const collected = (stats?.urlsByState.completed ?? 0) + (stats?.urlsByState.warning ?? 0);

  const steps: Step[] = [
    {
      label: 'Project',
      meta: project ? project.name : 'not created',
      done: !!project,
      view: 'projects'
    },
    {
      label: 'Categories',
      meta: stats?.categories ? plural(stats.categories, 'category', 'categories') : 'none yet',
      done: (stats?.categories ?? 0) > 0,
      view: 'categories'
    },
    {
      label: 'URLs',
      meta: stats?.urls ? plural(stats.urls, 'URL') : 'none added',
      done: (stats?.urls ?? 0) > 0,
      view: 'urls'
    },
    {
      label: 'Collect',
      meta: collected ? `${number(collected)} collected` : 'not started',
      done: collected > 0,
      view: 'scraping'
    },
    {
      label: 'Validate',
      meta: s.issues.length ? plural(s.issues.length, 'finding') : 'not run',
      done: s.issues.length > 0,
      view: 'validation'
    },
    {
      label: 'Export',
      meta: stats?.lastExport ? relativeTime(stats.lastExport.createdAt) : 'not exported',
      done: !!stats?.lastExport,
      view: 'exports'
    }
  ];

  const activeIndex = steps.findIndex((st) => !st.done);

  return h(
    'section',
    { class: 'section' },
    sectionHead({ title: 'Your workflow', subtitle: 'Add URLs, collect, check the findings, export.' }),
    h(
      'div',
      { class: 'flow' },
      ...steps.map((st, i) =>
        h(
          'button',
          {
            class: `flow__step${st.done ? ' is-done' : ''}${i === activeIndex ? ' is-active' : ''}`,
            type: 'button',
            on: { click: () => setView(st.view) }
          },
          h('div', { class: 'flow__n' }, h('i', null, st.done ? '✓' : String(i + 1)), `Step ${i + 1}`),
          h('div', { class: 'flow__label' }, st.label),
          h('div', { class: 'flow__meta' }, st.meta)
        )
      )
    )
  );
}

/* ------------------------------------------------------------------ */

function recentActivity(): HTMLElement {
  const s = getState();
  const recent = [...s.urls]
    .filter((u) => u.finishedAt)
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
    .slice(0, 8);

  const failed = s.urls.filter((u) => u.state === 'failed');

  return h(
    'section',
    { class: 'section' },
    sectionHead({
      title: 'Recent activity',
      actions: [
        failed.length
          ? button({ label: `Retry ${failed.length} failed`, icon: 'retry', size: 'sm', onClick: () => void retryFailed() })
          : null
      ]
    }),
    h(
      'div',
      { class: 'card' },
      recent.length === 0
        ? h('div', { class: 'empty', style: 'padding:34px 20px' }, h('p', { style: 'margin:0' }, 'Nothing collected yet.'))
        : table({
            scroll: false,
            columns: [
              {
                header: 'Address',
                render: (u) =>
                  h(
                    'div',
                    { class: 'urlcell' },
                    h('div', { class: 'urlcell__host' }, hostOf(u.url)),
                    h('span', { class: 'urlcell__path', title: u.url }, pathOf(u.url))
                  )
              },
              {
                header: 'Result',
                className: 'shrink',
                render: (u) =>
                  u.state === 'failed'
                    ? badge('Failed', 'err', true)
                    : u.state === 'warning'
                      ? badge('Check it', 'warn', true)
                      : badge('Collected', 'ok', true)
              },
              { header: 'When', className: 'shrink muted', render: (u) => relativeTime(u.finishedAt) }
            ],
            rows: recent,
            onRowClick: () => setView('urls')
          })
    )
  );
}

function exportSummary(): HTMLElement {
  const s = getState();
  const last = s.stats?.lastExport;
  const project = currentProject();

  return h(
    'section',
    { class: 'section' },
    sectionHead({
      title: 'Export',
      actions: [button({ label: 'Open exports', size: 'sm', onClick: () => setView('exports') })]
    }),
    h(
      'div',
      { class: 'card card__pad' },
      h(
        'div',
        { class: 'row', style: 'margin-bottom:14px' },
        badge(project?.targetFormat === 'shopify' ? 'Shopify' : 'WooCommerce', 'brand'),
        h('span', { class: 'muted tiny' }, 'is the target format for this project')
      ),
      last
        ? h(
            'div',
            null,
            h('div', { class: 'row', style: 'gap:8px;margin-bottom:8px' }, icon('exports', 15), h('strong', null, `${number(last.rowCount)} rows`), badge(last.status === 'success' ? 'Complete' : last.status === 'partial' ? 'Partial' : 'Failed', last.status === 'success' ? 'ok' : last.status === 'partial' ? 'warn' : 'err')),
            h('div', { class: 'tiny muted' }, `${number(last.productCount)} products · ${dateTime(last.createdAt)}`),
            h('div', { class: 'mono faint', style: 'margin-top:6px;word-break:break-all' }, last.filePath),
            last.message ? banner('info', [last.message]) : null
          )
        : h('p', { class: 'muted tiny', style: 'margin:0' }, 'Nothing has been exported from this project yet.')
    )
  );
}
