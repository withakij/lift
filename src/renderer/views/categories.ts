import { h, icon } from '../lib/dom.js';
import { badge, button, confirmDialog, emptyState, openModal, sectionHead, textField } from '../lib/ui.js';
import { currentProject, getState, notify, setView } from '../lib/state.js';
import { createCategory, deleteCategory, renameCategory, startScrape } from '../actions.js';
import { plural } from '../lib/format.js';

export function renderCategories(): HTMLElement {
  const s = getState();
  const project = currentProject();

  if (!project) {
    return h(
      'div',
      { class: 'view' },
      emptyState({
        icon: 'projects',
        title: 'Choose a project first',
        body: 'Categories belong to a project. Create or open one to continue.',
        action: { label: 'Go to projects', onClick: () => setView('projects') }
      })
    );
  }

  const selected = new Set<string>();

  const uncategorised = s.urls.filter((u) => u.categoryId === null);

  return h(
    'div',
    { class: 'view' },
    sectionHead({
      title: 'Categories',
      subtitle:
        'The category you put a URL in becomes the product’s category in the export — you will not have to set it again after importing.',
      actions: [
        s.categories.length
          ? button({
              label: 'Collect everything',
              icon: 'play',
              onClick: () => void startScrape({})
            })
          : null,
        button({ label: 'New category', icon: 'plus', variant: 'primary', onClick: () => openCategoryDialog() })
      ]
    }),

    s.categories.length === 0
      ? h(
          'div',
          { class: 'card' },
          emptyState({
            icon: 'categories',
            title: 'No categories yet',
            body:
              'Create one category per product group — Monitors, Keyboards, Wallets. Then add the product URLs that belong to it.',
            action: { label: 'Create a category', icon: 'plus', onClick: () => openCategoryDialog() }
          })
        )
      : h(
          'div',
          { class: 'cats' },
          ...s.categories.map((c) => categoryCard(c, selected)),
          uncategorised.length ? uncategorisedCard(uncategorised.length) : null
        )
  );
}

type CategoryRow = ReturnType<typeof getState>['categories'][number];

function categoryCard(c: CategoryRow, selected: Set<string>): HTMLElement {
  const s = getState();
  const isFilter = s.filters.categoryId === c.id;
  const pendingCount = s.urls.filter((u) => u.categoryId === c.id && u.state !== 'completed' && u.state !== 'warning').length;

  return h(
    'div',
    { class: `cat${isFilter ? ' is-selected' : ''}` },
    h(
      'div',
      { class: 'cat__top' },
      h('div', { style: 'color:var(--brand);margin-top:1px' }, icon('folder', 17)),
      h(
        'div',
        { style: 'min-width:0;flex:1' },
        h('div', { class: 'cat__name ellipsis', title: c.name }, c.name),
        c.path !== c.name ? h('div', { class: 'cat__path ellipsis', title: c.path }, c.path) : null
      ),
      isFilter ? badge('Filtering', 'brand') : null
    ),
    h(
      'div',
      { class: 'cat__stats' },
      h('span', null, h('b', null, String(c.urlCount)), ' URLs'),
      h('span', null, h('b', null, String(c.productCount)), ' products'),
      pendingCount ? h('span', { class: 'muted' }, `${pendingCount} waiting`) : null
    ),
    h(
      'div',
      { class: 'cat__foot' },
      button({
        label: 'View URLs',
        size: 'sm',
        onClick: () => {
          s.filters.categoryId = c.id;
          notify();
          setView('urls');
        }
      }),
      button({
        icon: 'play',
        size: 'sm',
        title: c.urlCount ? `Collect the ${c.urlCount} URLs in ${c.name}` : 'No URLs in this category yet',
        disabled: c.urlCount === 0,
        onClick: () => void startScrape({ categoryIds: [c.id] })
      }),
      h('div', { class: 'header__spacer' }),
      button({ icon: 'edit', size: 'sm', title: 'Rename', onClick: () => openCategoryDialog(c) }),
      button({
        icon: 'trash',
        size: 'sm',
        title: 'Delete',
        onClick: () => openDeleteCategory(c)
      })
    )
  );
}

function uncategorisedCard(count: number): HTMLElement {
  const s = getState();
  return h(
    'div',
    { class: 'cat', style: 'border-style:dashed' },
    h(
      'div',
      { class: 'cat__top' },
      h('div', { class: 'faint', style: 'margin-top:1px' }, icon('folder', 17)),
      h(
        'div',
        { style: 'min-width:0;flex:1' },
        h('div', { class: 'cat__name' }, 'No category'),
        h('div', { class: 'cat__path' }, 'These will export without a category value')
      )
    ),
    h('div', { class: 'cat__stats' }, h('span', null, h('b', null, String(count)), ' URLs')),
    h(
      'div',
      { class: 'cat__foot' },
      button({
        label: 'View URLs',
        size: 'sm',
        onClick: () => {
          s.filters.categoryId = null;
          s.filters.urlState = null;
          notify();
          setView('urls');
        }
      })
    )
  );
}

/* ------------------------------------------------------------------ */

export function openCategoryDialog(existing?: CategoryRow): void {
  let name = existing?.name ?? '';
  let path = existing?.path ?? '';
  let pathTouched = !!existing && existing.path !== existing.name;

  let pathInput!: HTMLInputElement;

  const body = h(
    'div',
    null,
    textField({
      label: 'Category name',
      placeholder: 'e.g. Monitors',
      value: name,
      onInput: (v) => {
        name = v;
        if (!pathTouched) {
          path = v;
          pathInput.value = v;
        }
      }
    }),
    textField({
      label: 'Category path for the export',
      hint:
        'What the target store should receive. Use “ > ” for a hierarchy, e.g. Electronics > Displays > Monitors. Leave it matching the name if you do not need a hierarchy.',
      value: path,
      ref: (el) => (pathInput = el),
      onInput: (v) => {
        path = v;
        pathTouched = true;
      }
    })
  );

  const modal = openModal({
    title: existing ? 'Rename category' : 'New category',
    subtitle: existing
      ? 'Products already collected in this category will be updated to match.'
      : 'Everything collected under this category gets its category value automatically.',
    body,
    footer: [
      button({ label: 'Cancel', onClick: () => modal.close() }),
      button({
        label: existing ? 'Save' : 'Create category',
        variant: 'primary',
        onClick: () => {
          if (!name.trim()) return;
          modal.close();
          if (existing) void renameCategory(existing.id, name.trim(), path.trim());
          else void createCategory(name.trim(), path.trim());
        }
      })
    ]
  });
}

function openDeleteCategory(c: CategoryRow): void {
  if (c.urlCount === 0) {
    confirmDialog({
      title: `Delete “${c.name}”?`,
      body: 'This category has no URLs in it, so nothing else will be affected.',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => void deleteCategory(c.id, false)
    });
    return;
  }

  let deleteUrls = false;
  const modal = openModal({
    title: `Delete “${c.name}”?`,
    subtitle: `${plural(c.urlCount, 'URL')} and ${plural(c.productCount, 'collected product')} belong to it.`,
    body: h(
      'div',
      null,
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'radio',
          name: 'del',
          checked: true,
          on: { change: () => (deleteUrls = false) }
        }),
        h(
          'span',
          { class: 'check__body' },
          h('strong', null, 'Keep the URLs'),
          h('span', null, 'They stay in the project without a category. You can move them somewhere else later.')
        )
      ),
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'radio', name: 'del', on: { change: () => (deleteUrls = true) } }),
        h(
          'span',
          { class: 'check__body' },
          h('strong', null, 'Delete the URLs and their products too'),
          h('span', null, 'Everything collected under this category is removed. This cannot be undone.')
        )
      )
    ),
    footer: [
      button({ label: 'Cancel', onClick: () => modal.close() }),
      button({
        label: 'Delete category',
        variant: 'danger',
        onClick: () => {
          modal.close();
          void deleteCategory(c.id, deleteUrls);
        }
      })
    ]
  });
}
