import { h, icon } from '../lib/dom.js';
import {
  badge,
  banner,
  button,
  checkField,
  emptyState,
  openModal,
  sectionHead,
  selectField,
  table,
  textField,
  toast
} from '../lib/ui.js';
import { currentProject, getState, setView } from '../lib/state.js';
import { chooseExportFolder, revealExport, runExport, runValidation } from '../actions.js';
import { api } from '../lib/api.js';
import { dateTime, fileSize, number, plural, relativeTime } from '../lib/format.js';
import type { ExportOptions, Severity } from '../../shared/types';

export function renderExports(): HTMLElement {
  const s = getState();
  const project = currentProject();

  if (!project) {
    return h(
      'div',
      { class: 'view' },
      emptyState({
        icon: 'projects',
        title: 'Choose a project first',
        body: 'Exports are produced from a project’s collected products.',
        action: { label: 'Go to projects', onClick: () => setView('projects') }
      })
    );
  }

  const productCount = s.stats?.products ?? 0;
  const bySeverity = s.stats?.issuesBySeverity ?? { INFO: 0, WARNING: 0, ERROR: 0, CRITICAL: 0 };
  const blocking = bySeverity.CRITICAL + bySeverity.ERROR;

  return h(
    'div',
    { class: 'view' },
    sectionHead({
      title: 'Exports',
      subtitle: `Import-ready ${project.targetFormat === 'shopify' ? 'Shopify' : 'WooCommerce'} CSV, built from what you collected.`,
      actions: [
        button({
          label: 'Export…',
          icon: 'exports',
          variant: 'primary',
          disabled: productCount === 0,
          onClick: () => openExportDialog()
        })
      ]
    }),

    productCount === 0
      ? h(
          'div',
          { class: 'card' },
          emptyState({
            icon: 'exports',
            title: 'Nothing to export yet',
            body: 'Collect some products first, then come back here to write the import file.',
            action: { label: 'Go to URLs', onClick: () => setView('urls') }
          })
        )
      : h(
          'div',
          null,
          s.issues.length === 0
            ? banner('warn', [
                'Validation has not been run for this project. ',
                h(
                  'button',
                  { class: 'link', on: { click: () => void runValidation() } },
                  'Run it now'
                ),
                ' so problems are caught before you import.'
              ])
            : blocking > 0
              ? banner('warn', [
                  `${plural(blocking, 'finding')} would hold products back. `,
                  h('button', { class: 'link', on: { click: () => setView('validation') } }, 'Review them'),
                  ' or choose to include them when exporting.'
                ])
              : banner('info', ['Validation is clean — every collected product is ready to export.']),

          h(
            'div',
            { class: 'card card__pad', style: 'margin-bottom:20px' },
            h(
              'div',
              { class: 'row', style: 'gap:18px;flex-wrap:wrap' },
              h(
                'div',
                null,
                h('div', { class: 'field__label' }, 'Ready to export'),
                h('div', { style: 'font-size:22px;font-weight:640' }, number(productCount)),
                h('div', { class: 'tiny muted' }, plural(s.stats?.variants ?? 0, 'variant'))
              ),
              h('div', { style: 'width:1px;align-self:stretch;background:var(--line)' }),
              h(
                'div',
                null,
                h('div', { class: 'field__label' }, 'Format'),
                h('div', { style: 'margin-top:4px' }, badge(project.targetFormat === 'shopify' ? 'Shopify' : 'WooCommerce', 'brand'))
              ),
              h('div', { class: 'header__spacer' }),
              button({ label: 'Preview the file', onClick: () => openExportDialog(true) }),
              button({ label: 'Export now', icon: 'exports', variant: 'primary', onClick: () => openExportDialog() })
            )
          ),

          h(
            'section',
            { class: 'section' },
            sectionHead({ title: 'History' }),
            h(
              'div',
              { class: 'card' },
              s.exportHistory.length === 0
                ? h('div', { class: 'empty', style: 'padding:34px' }, h('p', { style: 'margin:0' }, 'No exports yet.'))
                : table({
                    scroll: false,
                    columns: [
                      { header: 'When', className: 'shrink', render: (e) => h('div', null, h('div', null, relativeTime(e.createdAt)), h('div', { class: 'tiny faint' }, dateTime(e.createdAt))) },
                      { header: 'Format', className: 'shrink', render: (e) => badge(e.format === 'shopify' ? 'Shopify' : 'WooCommerce') },
                      { header: 'Products', className: 'shrink num', render: (e) => number(e.productCount) },
                      { header: 'Rows', className: 'shrink num', render: (e) => number(e.rowCount) },
                      {
                        header: 'Status',
                        className: 'shrink',
                        render: (e) =>
                          badge(
                            e.status === 'success' ? 'Complete' : e.status === 'partial' ? `Partial (${e.skippedCount} left out)` : 'Failed',
                            e.status === 'success' ? 'ok' : e.status === 'partial' ? 'warn' : 'err'
                          )
                      },
                      {
                        header: 'File',
                        render: (e) =>
                          h(
                            'div',
                            null,
                            h('div', { class: 'mono tiny ellipsis', style: 'max-width:360px', title: e.filePath }, e.filePath),
                            h(
                              'div',
                              { class: 'tiny muted' },
                              [e.byteSize ? fileSize(e.byteSize) : null, e.message].filter(Boolean).join(' · ')
                            )
                          )
                      },
                      {
                        header: '',
                        className: 'shrink',
                        render: (e) =>
                          h(
                            'div',
                            { class: 'rowactions' },
                            button({ icon: 'folder', size: 'sm', title: 'Show in folder', onClick: () => void revealExport(e.filePath) })
                          )
                      }
                    ],
                    rows: s.exportHistory
                  })
            )
          )
        )
  );
}

/* ------------------------------------------------------------------ */

function openExportDialog(previewOnly = false): void {
  const s = getState();
  const project = currentProject();
  if (!project) return;

  const opts: ExportOptions = {
    projectId: project.id,
    format: project.targetFormat,
    profileId: project.exportProfileId,
    categoryIds: null,
    productIds: null,
    includeWarnings: true,
    includeErrors: false,
    excludeFailed: true,
    outputDir: s.settings?.defaultExportDir ?? null,
    fileName: null
  };

  const previewHost = h('div', { style: 'margin-top:16px' });
  const summaryHost = h('div');
  let folderLabel = h('span', { class: 'mono tiny' }, opts.outputDir ?? 'Documents / Lift Exports');

  const refreshPreview = async (): Promise<void> => {
    previewHost.replaceChildren(h('p', { class: 'tiny muted' }, 'Building preview…'));
    try {
      const preview = await api.exports.preview(opts, 25);
      summaryHost.replaceChildren(
        h(
          'div',
          { class: 'row row--wrap', style: 'gap:8px' },
          badge(`${number(preview.totalRows)} rows`, 'brand'),
          badge(`${preview.headers.length} columns`),
          preview.skipped.length ? badge(`${preview.skipped.length} left out`, 'warn') : badge('nothing left out', 'ok')
        )
      );
      const previewTable =
        preview.totalRows === 0
          ? banner('warn', ['Every product was held back. Adjust the options above or fix the validation findings.'])
          : h(
              'div',
              { class: 'preview' },
              h(
                'table',
                null,
                h('thead', null, h('tr', null, ...preview.headers.map((x) => h('th', { title: x }, x)))),
                h(
                  'tbody',
                  null,
                  ...preview.rows.map((row) => h('tr', null, ...row.map((cell) => h('td', { title: cell }, cell))))
                )
              )
            );

      const skippedList = preview.skipped.length
        ? h(
            'div',
            { style: 'margin-top:12px' },
            h('div', { class: 'field__label' }, `Left out (${preview.skipped.length})`),
            h(
              'ul',
              { class: 'tiny muted', style: 'padding-left:16px;margin:0;line-height:1.7;max-height:120px;overflow:auto' },
              ...preview.skipped.map((sk) => h('li', null, h('strong', null, sk.title ?? 'Untitled'), ` — ${sk.reason}`))
            )
          )
        : null;

      previewHost.replaceChildren(...[previewTable, skippedList].filter((n): n is HTMLElement => n !== null));
    } catch (err) {
      previewHost.replaceChildren(banner('err', [err instanceof Error ? err.message : String(err)]));
    }
  };

  const body = h(
    'div',
    null,
    summaryHost,
    h('div', { class: 'divider' }),
    selectField({
      label: 'Which products',
      value: opts.categoryIds?.[0] ?? '',
      options: [
        { value: '', label: `Everything in this project (${number(s.stats?.products ?? 0)})` },
        ...s.categories.map((c) => ({ value: c.id, label: `${c.name} only (${c.productCount})` }))
      ],
      onChange: (v) => {
        opts.categoryIds = v ? [v] : null;
        void refreshPreview();
      }
    }),
    checkField({
      label: 'Include products with warnings',
      hint: 'They will import, but something about them is worth a second look.',
      checked: opts.includeWarnings,
      onChange: (v) => {
        opts.includeWarnings = v;
        void refreshPreview();
      }
    }),
    checkField({
      label: 'Include products with errors',
      hint: 'Off by default. These rows are likely to import incorrectly.',
      checked: opts.includeErrors,
      onChange: (v) => {
        opts.includeErrors = v;
        void refreshPreview();
      }
    }),
    h(
      'p',
      { class: 'field__hint', style: 'margin-bottom:14px' },
      icon('info', 12),
      ' Products with a critical finding are never exported, whatever these options say.'
    ),
    h('div', { class: 'divider' }),
    textField({
      label: 'File name (optional)',
      placeholder: `${project.targetFormat}-export-<date>.csv`,
      onInput: (v) => (opts.fileName = v || null)
    }),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'field__label' }, 'Save to'),
      h(
        'div',
        { class: 'row' },
        folderLabel,
        h('div', { class: 'header__spacer' }),
        button({
          label: 'Choose folder…',
          icon: 'folder',
          size: 'sm',
          onClick: async () => {
            const dir = await chooseExportFolder();
            if (!dir) return;
            opts.outputDir = dir;
            const next = h('span', { class: 'mono tiny' }, dir);
            folderLabel.replaceWith(next);
            folderLabel = next;
          }
        })
      )
    ),
    h('div', { class: 'divider' }),
    h('div', { class: 'field__label' }, 'Preview of the first rows'),
    previewHost
  );

  void refreshPreview();

  const modal = openModal({
    title: previewOnly ? 'Export preview' : 'Export',
    subtitle: `${project.targetFormat === 'shopify' ? 'Shopify' : 'WooCommerce'} · ${project.exportProfileId}`,
    width: 'xl',
    body,
    footer: [
      button({ label: 'Close', onClick: () => modal.close() }),
      button({
        label: 'Write the file',
        icon: 'exports',
        variant: 'primary',
        onClick: () => {
          modal.close();
          void runExport(opts);
        }
      })
    ]
  });
}

export { toast };
export type { Severity };
