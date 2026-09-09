import { h, icon } from '../lib/dom.js';
import {
  badge,
  banner,
  button,
  confirmDialog,
  emptyState,
  openModal,
  sectionHead,
  selectField,
  table,
  textArea,
  textField,
  toast
} from '../lib/ui.js';
import { currentProject, getState, notify, setView, urlsInScope } from '../lib/state.js';
import {
  addUrls,
  editUrl,
  importUrlFile,
  moveUrls,
  removeUrls,
  resetUrls,
  startScrape,
  testUrl
} from '../actions.js';
import { duration, hostOf, pathOf, plural, relativeTime, urlStateLabel } from '../lib/format.js';
import type { UrlEntry } from '../../shared/types';

const STATE_TONES: Record<string, 'ok' | 'warn' | 'err' | 'info' | 'neutral'> = {
  completed: 'ok',
  warning: 'warn',
  failed: 'err',
  processing: 'info',
  retrying: 'info',
  pending: 'neutral',
  skipped: 'neutral',
  paused: 'neutral'
};

export function renderUrls(): HTMLElement {
  const s = getState();
  const project = currentProject();

  if (!project) {
    return h(
      'div',
      { class: 'view' },
      emptyState({
        icon: 'projects',
        title: 'Choose a project first',
        body: 'URLs belong to a project.',
        action: { label: 'Go to projects', onClick: () => setView('projects') }
      })
    );
  }

  const rows = urlsInScope();
  const selection = s.selection.urls;
  const anySelected = selection.size > 0;

  const categoryOptions = [
    { value: '', label: 'All categories' },
    ...s.categories.map((c) => ({ value: c.id, label: `${c.name} (${c.urlCount})` })),
    { value: '__none__', label: 'No category' }
  ];

  const stateOptions = [
    { value: '', label: 'Any state' },
    ...(['pending', 'completed', 'warning', 'failed', 'processing', 'skipped'] as const).map((v) => ({
      value: v,
      label: urlStateLabel(v)
    }))
  ];

  return h(
    'div',
    { class: 'view view--wide' },
    sectionHead({
      title: 'Product URLs',
      subtitle: 'Only these addresses are visited. Nothing else on the site is crawled.',
      actions: [
        button({ label: 'Import from a file', icon: 'upload', onClick: () => void importUrlFile(s.filters.categoryId) }),
        button({ label: 'Add URLs', icon: 'plus', variant: 'primary', onClick: () => openAddUrls() })
      ]
    }),

    h(
      'div',
      { class: 'row row--wrap', style: 'margin-bottom:14px' },
      h(
        'div',
        { style: 'width:220px' },
        selectField({
          label: '',
          value: s.filters.categoryId ?? '',
          options: categoryOptions,
          onChange: (v) => {
            s.filters.categoryId = v === '' ? null : v === '__none__' ? '__none__' : v;
            if (v === '__none__') s.filters.categoryId = '__none__';
            notify();
          }
        })
      ),
      h(
        'div',
        { style: 'width:170px' },
        selectField({
          label: '',
          value: s.filters.urlState ?? '',
          options: stateOptions,
          onChange: (v) => {
            s.filters.urlState = v || null;
            notify();
          }
        })
      ),
      h('div', { class: 'header__spacer' }),
      anySelected
        ? h(
            'div',
            { class: 'row' },
            h('span', { class: 'tiny muted' }, `${plural(selection.size, 'selected')}`),
            button({
              label: 'Collect these',
              icon: 'play',
              size: 'sm',
              variant: 'primary',
              onClick: () => void startScrape({ urlIds: [...selection] })
            }),
            button({ label: 'Move', size: 'sm', onClick: () => openMove([...selection]) }),
            button({ label: 'Reset', icon: 'retry', size: 'sm', onClick: () => void resetUrls([...selection]) }),
            button({
              icon: 'trash',
              size: 'sm',
              variant: 'danger',
              title: 'Remove selected',
              onClick: () =>
                confirmDialog({
                  title: `Remove ${plural(selection.size, 'URL')}?`,
                  body: 'The addresses are removed from this project. Products already collected from them are kept.',
                  confirmLabel: 'Remove',
                  danger: true,
                  onConfirm: () => void removeUrls([...selection])
                })
            })
          )
        : rows.length
          ? button({
              label: `Collect ${plural(rows.filter((r) => r.state !== 'completed').length, 'URL')}`,
              icon: 'play',
              onClick: () =>
                void startScrape(
                  s.filters.categoryId && s.filters.categoryId !== '__none__'
                    ? { categoryIds: [s.filters.categoryId] }
                    : { urlIds: rows.map((r) => r.id) }
                )
            })
          : null
    ),

    rows.length === 0
      ? h(
          'div',
          { class: 'card' },
          emptyState({
            icon: 'urls',
            title: s.urls.length ? 'Nothing matches these filters' : 'No URLs yet',
            body: s.urls.length
              ? 'Try a different category or state.'
              : 'Paste the product page addresses you want to collect. One per line is fine, and a whole list pasted at once works too.',
            action: s.urls.length ? undefined : { label: 'Add URLs', icon: 'plus', onClick: () => openAddUrls() }
          })
        )
      : h(
          'div',
          { class: 'card' },
          table({
            columns: [
              {
                header: '',
                className: 'shrink',
                render: (u) =>
                  h('input', {
                    type: 'checkbox',
                    checked: selection.has(u.id),
                    on: {
                      change: (e: Event) => {
                        const checked = (e.target as HTMLInputElement).checked;
                        if (checked) selection.add(u.id);
                        else selection.delete(u.id);
                        notify();
                      }
                    }
                  })
              },
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
                header: 'Category',
                className: 'shrink',
                render: (u) => {
                  const c = s.categories.find((x) => x.id === u.categoryId);
                  return c ? badge(c.name) : h('span', { class: 'faint tiny' }, 'none');
                }
              },
              {
                header: 'State',
                className: 'shrink',
                render: (u) =>
                  h(
                    'div',
                    { class: 'col', style: 'gap:3px' },
                    badge(urlStateLabel(u.state), STATE_TONES[u.state] ?? 'neutral', true),
                    u.attempts > 1 ? h('span', { class: 'faint tiny' }, `${u.attempts} attempts`) : null
                  )
              },
              {
                header: 'Notes',
                render: (u) =>
                  u.lastError
                    ? h('span', { class: 'tiny', style: 'color:var(--err)' }, u.lastError)
                    : u.note
                      ? h('span', { class: 'tiny muted', title: u.note }, u.note.slice(0, 90))
                      : null
              },
              { header: 'Took', className: 'shrink muted tiny', render: (u) => duration(u.durationMs) },
              { header: 'Updated', className: 'shrink muted tiny', render: (u) => relativeTime(u.finishedAt ?? u.addedAt) },
              {
                header: '',
                className: 'shrink',
                render: (u) =>
                  h(
                    'div',
                    { class: 'rowactions' },
                    button({
                      icon: 'play',
                      size: 'sm',
                      title: 'Collect this one',
                      onClick: () => void startScrape({ urlIds: [u.id] })
                    }),
                    button({ icon: 'edit', size: 'sm', title: 'Edit address', onClick: () => openEditUrl(u) }),
                    button({
                      icon: 'trash',
                      size: 'sm',
                      title: 'Remove',
                      onClick: () => void removeUrls([u.id])
                    })
                  )
              }
            ],
            rows,
            rowClass: (u) => (selection.has(u.id) ? 'is-selected' : undefined)
          })
        )
  );
}

/* ------------------------------------------------------------------ */

export function openAddUrls(): void {
  const s = getState();
  let text = '';
  let categoryId: string | null =
    s.filters.categoryId && s.filters.categoryId !== '__none__' ? s.filters.categoryId : s.categories[0]?.id ?? null;

  const countEl = h('span', { class: 'tiny muted' }, 'Nothing pasted yet');

  const body = h(
    'div',
    null,
    s.categories.length === 0
      ? banner('warn', [
          'You have no categories yet. URLs added now will export without a category — ',
          h(
            'button',
            {
              class: 'link',
              on: {
                click: () => {
                  setView('categories');
                }
              }
            },
            'create one first'
          ),
          ' if you want the category filled in automatically.'
        ])
      : selectField({
          label: 'Add them to',
          hint: 'Every product collected from these URLs gets this category in the export.',
          value: categoryId ?? '',
          options: [
            ...s.categories.map((c) => ({ value: c.id, label: c.name })),
            { value: '', label: 'No category' }
          ],
          onChange: (v) => (categoryId = v || null)
        }),
    textArea({
      label: 'Product page addresses',
      placeholder: 'https://example.com/products/monitor-1\nhttps://example.com/products/monitor-2',
      rows: 10,
      onInput: (v) => {
        text = v;
        const n = v.split(/[\r\n,;\t]+/).map((x) => x.trim()).filter(Boolean).length;
        countEl.textContent = n ? `${plural(n, 'line')} ready` : 'Nothing pasted yet';
      }
    }),
    h(
      'p',
      { class: 'field__hint' },
      'One per line. Commas, tabs and semicolons work too. Duplicates already in this project are skipped automatically.'
    )
  );

  const modal = openModal({
    title: 'Add product URLs',
    subtitle: 'Paste as many as you like — one, twenty, or several hundred.',
    width: 'wide',
    body,
    footer: [
      countEl,
      h('div', { class: 'spacer' }),
      button({ label: 'Cancel', onClick: () => modal.close() }),
      button({
        label: 'Add URLs',
        variant: 'primary',
        onClick: () => {
          if (!text.trim()) return;
          modal.close();
          void addUrls(text, categoryId);
        }
      })
    ]
  });
}

function openEditUrl(u: UrlEntry): void {
  let url = u.url;
  const resultHost = h('div', { style: 'margin-top:10px' });

  const check = async (): Promise<void> => {
    resultHost.replaceChildren(h('span', { class: 'tiny muted' }, 'Checking…'));
    const r = await testUrl(url);
    if (!r) {
      resultHost.replaceChildren();
      return;
    }
    resultHost.replaceChildren(
      banner(r.reachable ? 'info' : 'warn', [
        r.reachable ? h('strong', null, 'Reachable. ') : h('strong', null, 'Could not read that page. '),
        r.detail
      ])
    );
  };

  const modal = openModal({
    title: 'Edit address',
    body: h(
      'div',
      null,
      textField({
        label: 'Product page address',
        value: url,
        onInput: (v) => (url = v)
      }),
      button({ label: 'Test this address', icon: 'search', size: 'sm', onClick: () => void check() }),
      resultHost,
      h(
        'p',
        { class: 'field__hint', style: 'margin-top:12px' },
        'Saving a changed address puts it back in the queue so it is collected again.'
      )
    ),
    footer: [
      button({ label: 'Cancel', onClick: () => modal.close() }),
      button({
        label: 'Save',
        variant: 'primary',
        onClick: () => {
          if (!url.trim() || url === u.url) {
            modal.close();
            return;
          }
          modal.close();
          void editUrl(u.id, url.trim());
        }
      })
    ]
  });
}

function openMove(ids: string[]): void {
  const s = getState();
  if (s.categories.length === 0) {
    toast('Create a category first.', 'warn');
    return;
  }
  let categoryId: string | null = s.categories[0].id;
  const modal = openModal({
    title: `Move ${plural(ids.length, 'URL')}`,
    body: selectField({
      label: 'Move to',
      value: categoryId ?? '',
      options: [...s.categories.map((c) => ({ value: c.id, label: c.name })), { value: '', label: 'No category' }],
      onChange: (v) => (categoryId = v || null)
    }),
    footer: [
      button({ label: 'Cancel', onClick: () => modal.close() }),
      button({
        label: 'Move',
        variant: 'primary',
        onClick: () => {
          modal.close();
          void moveUrls(ids, categoryId);
        }
      })
    ]
  });
}

export { icon };
