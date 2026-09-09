import { h, icon } from '../lib/dom.js';
import { badge, button, confirmDialog, emptyState, openModal, sectionHead, selectField, table, textArea, textField } from '../lib/ui.js';
import { currentProject, getState, switchProject } from '../lib/state.js';
import { createProject, deleteProject, updateProject } from '../actions.js';
import { dateTime, number, plural, relativeTime } from '../lib/format.js';
import { api } from '../lib/api.js';
import type { TargetFormat } from '../../shared/types';

export function renderProjects(): HTMLElement {
  const s = getState();

  return h(
    'div',
    { class: 'view' },
    sectionHead({
      title: 'Projects',
      subtitle: 'Each project keeps its own categories, URLs, collected products and export format.',
      actions: [button({ label: 'New project', icon: 'plus', variant: 'primary', onClick: openNewProject })]
    }),
    s.projects.length === 0
      ? h(
          'div',
          { class: 'card' },
          emptyState({
            icon: 'projects',
            title: 'No projects yet',
            body: 'Create a project for each store or migration you are working on.',
            action: { label: 'Create a project', icon: 'plus', onClick: openNewProject }
          })
        )
      : h(
          'div',
          { class: 'card' },
          table({
            columns: [
              {
                header: 'Project',
                render: (p) =>
                  h(
                    'div',
                    null,
                    h(
                      'div',
                      { class: 'row', style: 'gap:8px' },
                      h('strong', null, p.name),
                      p.id === s.projectId ? badge('Open', 'brand') : null
                    ),
                    p.description ? h('div', { class: 'tiny muted' }, p.description) : null
                  )
              },
              {
                header: 'Target',
                className: 'shrink',
                render: (p) => badge(p.targetFormat === 'shopify' ? 'Shopify' : 'WooCommerce')
              },
              { header: 'Created', className: 'shrink muted', render: (p) => relativeTime(p.createdAt) },
              {
                header: '',
                className: 'shrink',
                render: (p) =>
                  h(
                    'div',
                    { class: 'rowactions' },
                    p.id === s.projectId
                      ? null
                      : button({ label: 'Open', size: 'sm', onClick: () => void switchProject(p.id) }),
                    button({ icon: 'edit', size: 'sm', title: 'Edit', onClick: () => openEditProject(p.id) }),
                    button({
                      icon: 'trash',
                      size: 'sm',
                      variant: 'danger',
                      title: 'Delete',
                      onClick: () =>
                        confirmDialog({
                          title: `Delete “${p.name}”?`,
                          body:
                            'This removes the project along with its categories, URLs, collected products and validation findings. Files you have already exported are not touched. This cannot be undone.',
                          confirmLabel: 'Delete project',
                          danger: true,
                          onConfirm: () => void deleteProject(p.id)
                        })
                    })
                  )
              }
            ],
            rows: s.projects,
            rowClass: (p) => (p.id === s.projectId ? 'is-selected' : undefined),
            onRowClick: (p) => void switchProject(p.id)
          })
        ),

    currentProject() ? projectDetail() : null
  );
}

function projectDetail(): HTMLElement {
  const s = getState();
  const p = currentProject()!;
  const stats = s.stats;

  return h(
    'section',
    { class: 'section', style: 'margin-top:26px' },
    sectionHead({ title: 'Open project', subtitle: p.name }),
    h(
      'div',
      { class: 'card card__pad' },
      h(
        'div',
        { class: 'grid2' },
        h(
          'div',
          null,
          h('div', { class: 'field__label' }, 'Contents'),
          h(
            'p',
            { class: 'tiny muted', style: 'margin:0 0 12px' },
            `${plural(stats?.categories ?? 0, 'category', 'categories')} · ${plural(stats?.urls ?? 0, 'URL')} · ${plural(
              stats?.products ?? 0,
              'product'
            )} · ${plural(stats?.variants ?? 0, 'variant')}`
          ),
          h('div', { class: 'field__label' }, 'Created'),
          h('p', { class: 'tiny muted', style: 'margin:0' }, dateTime(p.createdAt))
        ),
        h(
          'div',
          null,
          h('div', { class: 'field__label' }, 'Last export'),
          h(
            'p',
            { class: 'tiny muted', style: 'margin:0 0 12px' },
            stats?.lastExport
              ? `${number(stats.lastExport.rowCount)} rows · ${relativeTime(stats.lastExport.createdAt)}`
              : 'never exported'
          ),
          h('div', { class: 'field__label' }, 'Export format'),
          h('p', { class: 'tiny muted', style: 'margin:0' }, p.targetFormat === 'shopify' ? 'Shopify' : 'WooCommerce')
        )
      )
    )
  );
}

/* ------------------------------------------------------------------ */

export function openNewProject(): void {
  let name = '';
  let description = '';
  let targetFormat: TargetFormat = 'shopify';
  let profileId = 'shopify-legacy';

  const profileHost = h('div');

  const renderProfiles = async (): Promise<void> => {
    const profiles = await api.exports.profiles();
    const forFormat = profiles.filter((p) => p.format === targetFormat);
    if (!forFormat.some((p) => p.id === profileId)) profileId = forFormat[0]?.id ?? '';
    profileHost.replaceChildren(
      selectField({
        label: 'Column layout',
        hint: forFormat.find((p) => p.id === profileId)?.description ?? '',
        value: profileId,
        options: forFormat.map((p) => ({ value: p.id, label: p.label })),
        onChange: (v) => {
          profileId = v;
          void renderProfiles();
        }
      })
    );
  };

  const body = h(
    'div',
    null,
    textField({
      label: 'Project name',
      placeholder: 'e.g. Monitors migration',
      onInput: (v) => (name = v)
    }),
    textArea({
      label: 'Notes (optional)',
      placeholder: 'What is this migration for?',
      rows: 3,
      onInput: (v) => (description = v)
    }),
    selectField({
      label: 'Where will these products be imported?',
      hint: 'This decides the shape of the export file. You can change it later.',
      value: targetFormat,
      options: [
        { value: 'shopify', label: 'Shopify' },
        { value: 'woocommerce', label: 'WooCommerce' }
      ],
      onChange: (v) => {
        targetFormat = v as TargetFormat;
        profileId = '';
        void renderProfiles();
      }
    }),
    profileHost
  );

  void renderProfiles();

  const modal = openModal({
    title: 'New project',
    subtitle: 'Give it a name and choose the store it will be imported into.',
    body,
    footer: [
      button({ label: 'Cancel', onClick: () => modal.close() }),
      button({
        label: 'Create project',
        variant: 'primary',
        onClick: () => {
          if (!name.trim()) return;
          modal.close();
          void createProject({ name: name.trim(), description, targetFormat, exportProfileId: profileId });
        }
      })
    ]
  });
}

function openEditProject(id: string): void {
  const project = getState().projects.find((p) => p.id === id);
  if (!project) return;

  let name = project.name;
  let description = project.description;
  let targetFormat = project.targetFormat;
  let profileId = project.exportProfileId;
  const profileHost = h('div');

  const renderProfiles = async (): Promise<void> => {
    const profiles = await api.exports.profiles();
    const forFormat = profiles.filter((p) => p.format === targetFormat);
    if (!forFormat.some((p) => p.id === profileId)) profileId = forFormat[0]?.id ?? '';
    profileHost.replaceChildren(
      selectField({
        label: 'Column layout',
        hint: forFormat.find((p) => p.id === profileId)?.description ?? '',
        value: profileId,
        options: forFormat.map((p) => ({ value: p.id, label: p.label })),
        onChange: (v) => {
          profileId = v;
          void renderProfiles();
        }
      })
    );
  };
  void renderProfiles();

  const modal = openModal({
    title: 'Edit project',
    body: h(
      'div',
      null,
      textField({ label: 'Project name', value: name, onInput: (v) => (name = v) }),
      textArea({ label: 'Notes', value: description, rows: 3, onInput: (v) => (description = v) }),
      selectField({
        label: 'Target store',
        value: targetFormat,
        options: [
          { value: 'shopify', label: 'Shopify' },
          { value: 'woocommerce', label: 'WooCommerce' }
        ],
        onChange: (v) => {
          targetFormat = v as TargetFormat;
          void renderProfiles();
        }
      }),
      profileHost,
      h(
        'p',
        { class: 'field__hint', style: 'margin-top:14px' },
        icon('info', 13),
        ' Changing the target store only affects future exports. Nothing you have already collected is altered.'
      )
    ),
    footer: [
      button({ label: 'Cancel', onClick: () => modal.close() }),
      button({
        label: 'Save',
        variant: 'primary',
        onClick: () => {
          modal.close();
          void updateProject(id, { name: name.trim(), description, targetFormat, exportProfileId: profileId });
        }
      })
    ]
  });
}
