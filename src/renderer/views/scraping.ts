import { h, icon } from '../lib/dom.js';
import { badge, banner, button, emptyState, progressBar, sectionHead, table } from '../lib/ui.js';
import { currentProject, getState, setView } from '../lib/state.js';
import { cancelScrape, pauseScrape, resumeScrape, retryFailed, startScrape } from '../actions.js';
import { api } from '../lib/api.js';
import { dateTime, duration, hostOf, number, pathOf, plural, relativeTime, urlStateLabel } from '../lib/format.js';
import type { LogEntry, ScrapeJob } from '../../shared/types';

let jobs: ScrapeJob[] = [];
let logs: LogEntry[] = [];
let logsRequested = false;

export function renderScraping(): HTMLElement {
  const s = getState();
  const project = currentProject();

  if (!project) {
    return h(
      'div',
      { class: 'view' },
      emptyState({
        icon: 'projects',
        title: 'Choose a project first',
        body: 'Collection runs against the URLs in a project.',
        action: { label: 'Go to projects', onClick: () => setView('projects') }
      })
    );
  }

  void loadJobs();
  if (s.settings?.advancedMode && !logsRequested) void loadLogs();

  const p = s.progress;
  const pending = s.urls.filter((u) => u.state === 'pending').length;
  const failed = s.urls.filter((u) => u.state === 'failed').length;
  const active = s.urls.filter((u) => u.state === 'processing' || u.state === 'retrying');

  return h(
    'div',
    { class: 'view' },
    sectionHead({
      title: 'Collection',
      subtitle: 'Accuracy first — a product that needs its variants inspected simply takes a little longer.',
      actions: [
        failed ? button({ label: `Retry ${failed} failed`, icon: 'retry', onClick: () => void retryFailed() }) : null,
        pending
          ? button({ label: `Collect ${plural(pending, 'URL')}`, icon: 'play', variant: 'primary', onClick: () => void startScrape({}) })
          : null
      ]
    }),

    p && (p.state === 'running' || p.state === 'paused' || p.state === 'queued')
      ? activePanel()
      : h(
          'div',
          { class: 'card' },
          emptyState({
            icon: 'scraping',
            title: pending ? 'Nothing running' : 'All caught up',
            body: pending
              ? `${plural(pending, 'URL')} in this project has not been collected yet.`
              : 'Every URL in this project has been processed. Add more URLs, or move on to validation.',
            action: pending
              ? { label: 'Start collecting', icon: 'play', onClick: () => void startScrape({}) }
              : { label: 'Run validation', onClick: () => setView('validation') }
          })
        ),

    active.length
      ? h(
          'section',
          { class: 'section' },
          sectionHead({ title: 'In flight' }),
          h(
            'div',
            { class: 'card' },
            table({
              scroll: false,
              columns: [
                { header: 'Address', render: (u) => h('span', { class: 'mono ellipsis' }, `${hostOf(u.url)}${pathOf(u.url)}`) },
                { header: 'State', className: 'shrink', render: (u) => badge(urlStateLabel(u.state), 'info', true) }
              ],
              rows: active
            })
          )
        )
      : null,

    h(
      'section',
      { class: 'section' },
      sectionHead({ title: 'Runs', subtitle: 'Every collection run in this project.' }),
      h(
        'div',
        { class: 'card' },
        jobs.length === 0
          ? h('div', { class: 'empty', style: 'padding:34px' }, h('p', { style: 'margin:0' }, 'No runs yet.'))
          : table({
              scroll: false,
              columns: [
                { header: 'Scope', render: (j) => h('strong', null, j.label) },
                {
                  header: 'Result',
                  className: 'shrink',
                  render: (j) =>
                    h(
                      'div',
                      { class: 'row', style: 'gap:5px' },
                      j.completed ? badge(`${j.completed} done`, 'ok') : null,
                      j.warned ? badge(`${j.warned} to check`, 'warn') : null,
                      j.failed ? badge(`${j.failed} failed`, 'err') : null,
                      j.skipped ? badge(`${j.skipped} skipped`) : null
                    )
                },
                {
                  header: 'State',
                  className: 'shrink',
                  render: (j) =>
                    badge(
                      j.state === 'completed' ? 'Finished' : j.state === 'cancelled' ? 'Stopped' : j.state === 'paused' ? 'Paused' : j.state === 'failed' ? 'Failed' : 'Running',
                      j.state === 'completed' ? 'ok' : j.state === 'failed' ? 'err' : j.state === 'paused' ? 'warn' : 'neutral'
                    )
                },
                { header: 'Started', className: 'shrink muted tiny', render: (j) => relativeTime(j.startedAt ?? j.createdAt) },
                {
                  header: 'Took',
                  className: 'shrink muted tiny',
                  render: (j) =>
                    j.startedAt && j.finishedAt
                      ? duration(new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime())
                      : '—'
                },
                {
                  header: '',
                  className: 'shrink',
                  render: (j) =>
                    j.state === 'paused'
                      ? h(
                          'div',
                          { class: 'rowactions' },
                          button({ label: 'Resume', icon: 'play', size: 'sm', onClick: () => void resumeScrape() })
                        )
                      : null
                }
              ],
              rows: jobs
            })
      )
    ),

    s.settings?.advancedMode ? advancedLogs() : advancedHint()
  );
}

/* ------------------------------------------------------------------ */

function activePanel(): HTMLElement {
  const p = getState().progress!;
  const total = p.total || 1;
  const finished = p.completed + p.failed;
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
          h('div', { class: 'live__title' }, paused ? 'Paused' : 'Collecting'),
          h('div', { class: 'live__sub' }, p.message ?? `${number(total - finished)} still to go`)
        ),
        h('div', { class: 'live__count' }, number(finished), h('small', null, ` / ${number(p.total)}`))
      ),
      progressBar(finished / total),
      p.currentUrl
        ? h(
            'div',
            { class: 'live__current' },
            icon('urls', 14),
            h(
              'div',
              { class: 'ellipsis', style: 'min-width:0' },
              p.currentTitle ? h('strong', null, p.currentTitle) : hostOf(p.currentUrl),
              h('span', { class: 'faint' }, ` · ${pathOf(p.currentUrl)}`)
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
        h(
          'span',
          { class: 'tiny muted' },
          'Pausing finishes the product in flight first, so nothing is stored half-read.'
        )
      )
    )
  );
}

function advancedHint(): HTMLElement {
  return h(
    'section',
    { class: 'section' },
    banner('info', [
      'Turn on ',
      h('strong', null, 'Advanced mode'),
      ' in Settings to see the technical log and the extraction layers used for each product.'
    ])
  );
}

function advancedLogs(): HTMLElement {
  return h(
    'section',
    { class: 'section' },
    sectionHead({
      title: 'Technical log',
      subtitle: 'Advanced mode',
      actions: [button({ label: 'Refresh', icon: 'retry', size: 'sm', onClick: () => void loadLogs(true) })]
    }),
    h(
      'div',
      { class: 'logs' },
      ...(logs.length
        ? logs.map((l) =>
            h(
              'div',
              { class: 'logline' },
              h('time', null, new Date(l.ts).toLocaleTimeString()),
              h('span', { class: `lvl lvl-${l.level}` }, l.level),
              h('span', null, `[${l.scope}] ${l.message}`)
            )
          )
        : [h('div', { class: 'faint' }, 'Nothing logged yet.')])
    )
  );
}

/* ------------------------------------------------------------------ */

let jobsLoading = false;
async function loadJobs(): Promise<void> {
  const projectId = getState().projectId;
  if (!projectId || jobsLoading) return;
  jobsLoading = true;
  try {
    const next = await api.scrape.jobs(projectId);
    const changed = next.length !== jobs.length || next.some((j, i) => j.state !== jobs[i]?.state);
    jobs = next;
    if (changed) {
      const { notify } = await import('../lib/state.js');
      notify();
    }
  } catch {
    /* the panel simply shows nothing */
  } finally {
    jobsLoading = false;
  }
}

async function loadLogs(force = false): Promise<void> {
  if (logsRequested && !force) return;
  logsRequested = true;
  try {
    logs = await api.logs.list({ limit: 250 });
    const { notify } = await import('../lib/state.js');
    notify();
  } catch {
    /* ignore */
  }
}

export function resetScrapingCaches(): void {
  jobs = [];
  logs = [];
  logsRequested = false;
}

export { dateTime };
