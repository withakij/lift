import { h, icon } from '../lib/dom.js';
import {
  badge,
  banner,
  button,
  confirmDialog,
  emptyState,
  keyValue,
  openModal,
  sectionHead,
  selectField,
  table,
  tabs,
  toast
} from '../lib/ui.js';
import { currentProject, getState, loadProduct, notify, setView } from '../lib/state.js';
import { deleteProducts, openExternal, rescrapeProducts } from '../actions.js';
import { api } from '../lib/api.js';
import {
  dateTime,
  hostOf,
  kindLabel,
  money,
  number,
  pathOf,
  platformLabel,
  plural,
  relativeTime,
  stockLabel,
  truncate
} from '../lib/format.js';
import type { CanonicalProduct, CanonicalVariant } from '../../shared/canonical';
import type { ProductSummary } from '../../shared/ipc';
import type { Severity, ValidationIssue } from '../../shared/types';

const SEVERITY_TONE: Record<Severity, 'crit' | 'err' | 'warn' | 'info'> = {
  CRITICAL: 'crit',
  ERROR: 'err',
  WARNING: 'warn',
  INFO: 'info'
};

export function renderProducts(): HTMLElement {
  const s = getState();
  if (!currentProject()) {
    return h(
      'div',
      { class: 'view' },
      emptyState({
        icon: 'projects',
        title: 'Choose a project first',
        body: 'Products belong to a project.',
        action: { label: 'Go to projects', onClick: () => setView('projects') }
      })
    );
  }

  const rows = s.products;
  const selection = s.selection.products;

  let searchInput!: HTMLInputElement;

  return h(
    'div',
    { class: 'view view--wide' },
    sectionHead({
      title: 'Products',
      subtitle: `${plural(s.productTotal, 'product')} collected in this project.`,
      actions: [
        selection.size
          ? button({
              label: `Collect ${plural(selection.size, 'again')}`,
              icon: 'retry',
              onClick: () => void rescrapeProducts([...selection])
            })
          : null,
        selection.size
          ? button({
              icon: 'trash',
              variant: 'danger',
              title: 'Delete selected',
              onClick: () =>
                confirmDialog({
                  title: `Delete ${plural(selection.size, 'product')}?`,
                  body: 'Their URLs stay in the project and can be collected again. This cannot be undone.',
                  confirmLabel: 'Delete',
                  danger: true,
                  onConfirm: () => void deleteProducts([...selection])
                })
            })
          : null
      ]
    }),

    h(
      'div',
      { class: 'row row--wrap', style: 'margin-bottom:14px' },
      h(
        'div',
        { class: 'searchbox' },
        icon('search', 14),
        h('input', {
          class: 'input',
          placeholder: 'Search titles, addresses and SKUs',
          value: s.filters.productSearch,
          ref: (el) => (searchInput = el as HTMLInputElement),
          on: {
            input: () => {
              s.filters.productSearch = searchInput.value;
              scheduleProductSearch();
            }
          }
        })
      ),
      h(
        'div',
        { style: 'width:180px' },
        selectField({
          label: '',
          value: s.filters.categoryId ?? '',
          options: [
            { value: '', label: 'All categories' },
            ...s.categories.map((c) => ({ value: c.id, label: c.name }))
          ],
          onChange: (v) => {
            s.filters.categoryId = v || null;
            void reload();
          }
        })
      ),
      h(
        'div',
        { style: 'width:150px' },
        selectField({
          label: '',
          value: s.filters.productKind ?? '',
          options: [
            { value: '', label: 'Any type' },
            { value: 'simple', label: 'Simple' },
            { value: 'variable', label: 'Variable' }
          ],
          onChange: (v) => {
            s.filters.productKind = v || null;
            void reload();
          }
        })
      ),
      h(
        'label',
        { class: 'check', style: 'padding:0' },
        h('input', {
          type: 'checkbox',
          checked: s.filters.onlyReview,
          on: {
            change: (e: Event) => {
              s.filters.onlyReview = (e.target as HTMLInputElement).checked;
              void reload();
            }
          }
        }),
        h('span', { class: 'check__body' }, h('strong', null, 'Needs review'))
      )
    ),

    rows.length === 0
      ? h(
          'div',
          { class: 'card' },
          emptyState({
            icon: 'products',
            title: s.productTotal === 0 ? 'Nothing collected yet' : 'Nothing matches',
            body:
              s.productTotal === 0
                ? 'Add product URLs and run a collection — everything found appears here.'
                : 'Try clearing the filters or the search box.',
            action:
              s.productTotal === 0 ? { label: 'Go to URLs', onClick: () => setView('urls') } : undefined
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
                render: (p: ProductSummary) =>
                  h('input', {
                    type: 'checkbox',
                    checked: selection.has(p.id),
                    on: {
                      change: (e: Event) => {
                        if ((e.target as HTMLInputElement).checked) selection.add(p.id);
                        else selection.delete(p.id);
                        notify();
                      }
                    }
                  })
              },
              {
                header: '',
                className: 'shrink',
                render: (p) =>
                  p.featuredImageUrl
                    ? h('img', { class: 'thumb', src: p.featuredImageUrl, alt: '' })
                    : h('div', { class: 'thumb thumb--empty' }, icon('image', 15))
              },
              {
                header: 'Product',
                render: (p) =>
                  h(
                    'div',
                    { style: 'min-width:0' },
                    h('div', { class: 'ellipsis', style: 'font-weight:560' }, p.title ?? 'Untitled'),
                    h(
                      'div',
                      { class: 'tiny faint ellipsis', title: p.sourceUrl },
                      `${hostOf(p.sourceUrl)}${truncate(pathOf(p.sourceUrl), 60)}`
                    )
                  )
              },
              { header: 'Category', className: 'shrink', render: (p) => (p.categoryPath ? badge(p.categoryPath) : h('span', { class: 'faint tiny' }, 'none')) },
              {
                header: 'Type',
                className: 'shrink',
                render: (p) =>
                  h(
                    'div',
                    { class: 'col', style: 'gap:2px' },
                    badge(kindLabel(p.kind), p.kind === 'variable' ? 'brand' : 'neutral'),
                    p.variantCount ? h('span', { class: 'tiny faint' }, plural(p.variantCount, 'variant')) : null
                  )
              },
              { header: 'Price', className: 'shrink num', render: (p) => money(p.price, p.currency) },
              {
                header: 'Stock',
                className: 'shrink',
                render: (p) =>
                  badge(
                    stockLabel(p.stockStatus),
                    p.stockStatus === 'in_stock' ? 'ok' : p.stockStatus === 'out_of_stock' ? 'err' : 'neutral'
                  )
              },
              { header: 'Images', className: 'shrink num muted', render: (p) => String(p.imageCount) },
              {
                header: 'Findings',
                className: 'shrink',
                render: (p) =>
                  p.worstSeverity
                    ? badge(`${p.issueCount}`, SEVERITY_TONE[p.worstSeverity as Severity])
                    : h('span', { class: 'faint tiny' }, '—')
              },
              { header: 'Collected', className: 'shrink muted tiny', render: (p) => relativeTime(p.scrapedAt) }
            ],
            rows,
            rowClass: (p) => (selection.has(p.id) ? 'is-selected' : undefined),
            onRowClick: (p) => void openProduct(p.id)
          })
        )
  );
}

let searchTimer: number | undefined;
function scheduleProductSearch(): void {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void reload(), 220);
}

async function reload(): Promise<void> {
  const { loadProducts } = await import('../lib/state.js');
  await loadProducts();
}

/* ================================================================== */
/* Product detail                                                     */
/* ================================================================== */

export async function openProduct(id: string): Promise<void> {
  const product = await loadProduct(id);
  if (!product) {
    toast('That product could not be loaded.', 'err');
    return;
  }
  const issues = await api.validation.list(product.projectId, { productId: id });

  let tab = 'overview';
  const bodyHost = h('div');

  const render = (): void => {
    bodyHost.replaceChildren(
      tabs(
        [
          { id: 'overview', label: 'Overview' },
          { id: 'variants', label: 'Variants', count: product.variants.length },
          { id: 'images', label: 'Images', count: product.images.length },
          { id: 'seo', label: 'SEO & Google' },
          { id: 'issues', label: 'Findings', count: issues.length },
          { id: 'source', label: 'Where it came from' }
        ],
        tab,
        (t) => {
          tab = t;
          render();
        }
      ),
      tab === 'overview'
        ? overviewTab(product)
        : tab === 'variants'
          ? variantsTab(product)
          : tab === 'images'
            ? imagesTab(product)
            : tab === 'seo'
              ? seoTab(product)
              : tab === 'issues'
                ? issuesTab(issues)
                : sourceTab(product)
    );
  };
  render();

  const modal = openModal({
    title: product.title ?? 'Untitled product',
    subtitle: `${platformLabel(product.sourcePlatform)} · ${kindLabel(product.kind)}${
      product.categoryPath ? ` · ${product.categoryPath}` : ''
    }`,
    width: 'xl',
    body: bodyHost,
    footer: [
      button({ label: 'Open source page', icon: 'external', onClick: () => void openExternal(product.sourceUrl) }),
      h('div', { class: 'spacer' }),
      button({
        label: 'Collect again',
        icon: 'retry',
        onClick: () => {
          modal.close();
          void rescrapeProducts([product.id]);
        }
      }),
      button({ label: 'Close', variant: 'primary', onClick: () => modal.close() })
    ]
  });
}

function overviewTab(p: CanonicalProduct): HTMLElement {
  return h(
    'div',
    { class: 'detail__grid' },
    h(
      'div',
      null,
      keyValue([
        ['Title', p.title],
        ['Handle / slug', p.handle],
        ['Vendor', p.vendor],
        ['Brand', p.brand],
        ['Category (from this app)', p.categoryPath],
        ['Type on the source site', p.sourceProductType],
        ['Tags', p.tags.length ? p.tags.join(', ') : null],
        ['Price', p.price === null ? null : money(p.price, p.currency)],
        [
          'Price range',
          p.priceMin !== null && p.priceMax !== null && p.priceMin !== p.priceMax
            ? `${money(p.priceMin, p.currency)} – ${money(p.priceMax, p.currency)}`
            : null
        ],
        ['Compare-at price', p.compareAtPrice === null ? null : money(p.compareAtPrice, p.currency)],
        ['SKU', p.sku],
        ['Barcode', p.barcode],
        ['Stock', p.stockStatus === 'unknown' ? null : stockLabel(p.stockStatus)],
        ['Inventory', p.inventoryQuantity === null ? null : number(p.inventoryQuantity)],
        ['Weight', p.weight === null ? null : `${p.weight} ${p.weightUnit ?? ''}`.trim()],
        [
          'Dimensions',
          p.length !== null || p.width !== null || p.height !== null
            ? `${p.length ?? '?'} × ${p.width ?? '?'} × ${p.height ?? '?'} ${p.dimensionUnit ?? ''}`.trim()
            : null
        ],
        ['Published', p.published === null ? null : p.published ? 'Yes' : 'No'],
        ['Rating', p.ratingValue === null ? null : `${p.ratingValue} (${number(p.reviewCount)} reviews)`]
      ]),
      p.descriptionHtml
        ? h(
            'div',
            { style: 'margin-top:18px' },
            h('div', { class: 'field__label' }, 'Description'),
            h('div', { class: 'desc', html: p.descriptionHtml })
          )
        : p.descriptionText
          ? h(
              'div',
              { style: 'margin-top:18px' },
              h('div', { class: 'field__label' }, 'Description (plain text only)'),
              h('div', { class: 'desc' }, p.descriptionText)
            )
          : h('p', { class: 'faint tiny', style: 'margin-top:18px' }, 'No description was found on the source page.')
    ),
    h(
      'div',
      null,
      p.featuredImageUrl
        ? h(
            'div',
            { style: 'margin-bottom:14px' },
            h('div', { class: 'field__label' }, 'Main image'),
            h('img', { src: p.featuredImageUrl, alt: '', style: 'width:100%;border-radius:10px;border:1px solid var(--line)' })
          )
        : null,
      p.extractionNotes.length
        ? h(
            'div',
            null,
            h('div', { class: 'field__label' }, 'Notes from collection'),
            h(
              'ul',
              { class: 'tiny muted', style: 'padding-left:16px;margin:0;line-height:1.7' },
              ...p.extractionNotes.map((n) => h('li', null, n))
            )
          )
        : null
    )
  );
}

function variantsTab(p: CanonicalProduct): HTMLElement {
  if (p.variants.length === 0) {
    return h(
      'div',
      null,
      banner('info', [
        'This is a simple product — the source page published no variants. Its price, SKU and stock are on the Overview tab.'
      ])
    );
  }

  const optionNames = p.options.map((o) => o.name);

  return h(
    'div',
    null,
    h(
      'p',
      { class: 'tiny muted', style: 'margin:0 0 12px' },
      `${plural(p.variants.length, 'variant')} across ${p.options.map((o) => `${o.name} (${o.values.length})`).join(' × ') || 'no declared options'}.`
    ),
    table({
      columns: [
        {
          header: 'Options',
          render: (v: CanonicalVariant) =>
            v.options.length
              ? h(
                  'div',
                  { class: 'row row--wrap', style: 'gap:4px' },
                  ...v.options.map((o) => badge(`${o.name}: ${o.value}`, 'brand'))
                )
              : h('span', { class: 'faint tiny' }, v.title ?? 'default')
        },
        { header: 'SKU', className: 'shrink mono', render: (v) => v.sku ?? h('span', { class: 'faint' }, '—') },
        { header: 'Price', className: 'shrink num', render: (v) => money(v.price, v.currency ?? p.currency) },
        {
          header: 'Compare-at',
          className: 'shrink num muted',
          render: (v) => (v.compareAtPrice === null ? '—' : money(v.compareAtPrice, v.currency ?? p.currency))
        },
        {
          header: 'Stock',
          className: 'shrink',
          render: (v) =>
            badge(
              stockLabel(v.stockStatus),
              v.stockStatus === 'in_stock' ? 'ok' : v.stockStatus === 'out_of_stock' ? 'err' : 'neutral'
            )
        },
        { header: 'Qty', className: 'shrink num muted', render: (v) => (v.inventoryQuantity === null ? '—' : String(v.inventoryQuantity)) },
        {
          header: 'Weight',
          className: 'shrink num muted',
          render: (v) => (v.weight === null ? '—' : `${v.weight} ${v.weightUnit ?? ''}`.trim())
        },
        { header: 'Barcode', className: 'shrink mono muted', render: (v) => v.barcode ?? '—' },
        {
          header: 'Image',
          className: 'shrink',
          render: (v) =>
            v.imageUrl
              ? h('img', { class: 'thumb', src: v.imageUrl, alt: '', title: v.imageUrl })
              : h('span', { class: 'faint tiny' }, 'none')
        }
      ],
      rows: p.variants,
      scroll: true
    }),
    optionNames.length === 0
      ? banner('warn', ['No option names were published for these variants, so they may be hard to tell apart on import.'])
      : null
  );
}

function imagesTab(p: CanonicalProduct): HTMLElement {
  if (p.images.length === 0) {
    return banner('warn', ['No images were found for this product.']);
  }
  return h(
    'div',
    null,
    h(
      'p',
      { class: 'tiny muted', style: 'margin:0 0 12px' },
      `${plural(p.images.length, 'image')} in source order. The highlighted one is the main image.`
    ),
    h(
      'div',
      { class: 'gallery' },
      ...p.images.map((img) =>
        h(
          'figure',
          { class: img.url === p.featuredImageUrl ? 'is-featured' : undefined },
          h('img', { src: img.url, alt: img.alt ?? '', title: img.url }),
          h('figcaption', { title: img.alt ?? '' }, `${img.position}${img.variantIds.length ? ' · variant' : ''}`)
        )
      )
    ),
    h('div', { class: 'divider' }),
    table({
      scroll: false,
      columns: [
        { header: '#', className: 'shrink num', render: (i) => String(i.position) },
        { header: 'Alt text', render: (i) => i.alt ?? h('span', { class: 'faint' }, 'none') },
        { header: 'Bound to', className: 'shrink', render: (i) => (i.variantIds.length ? badge(plural(i.variantIds.length, 'variant')) : h('span', { class: 'faint tiny' }, 'gallery')) },
        { header: 'Address', className: 'mono tiny', render: (i) => h('span', { class: 'ellipsis', style: 'display:block;max-width:400px' }, i.url) }
      ],
      rows: p.images
    })
  );
}

function seoTab(p: CanonicalProduct): HTMLElement {
  const g = p.google;
  const nothingFromGoogle = !g.gtin && !g.mpn && !g.googleProductCategory && !g.brand;

  return h(
    'div',
    null,
    h('div', { class: 'field__label' }, 'SEO'),
    keyValue([
      ['SEO title', p.seo.title],
      ['Meta description', p.seo.metaDescription],
      ['Canonical URL', p.seo.canonicalUrl],
      ['Robots', p.seo.robots],
      ['OpenGraph title', p.seo.ogTitle],
      ['Keywords', p.seo.keywords.length ? p.seo.keywords.join(', ') : null]
    ]),
    h('div', { class: 'divider' }),
    h('div', { class: 'field__label' }, 'Google Merchant Center'),
    nothingFromGoogle
      ? banner('info', [
          'This page did not publish Merchant Center attributes. They are left empty on purpose — a GTIN, MPN or Google category cannot be derived from a product page, and inventing one would make the feed wrong.'
        ])
      : null,
    keyValue([
      ['Brand', g.brand],
      ['GTIN', g.gtin],
      ['MPN', g.mpn],
      ['Google product category', g.googleProductCategory],
      ['Condition', g.condition === 'unknown' ? null : g.condition],
      ['Gender', g.gender],
      ['Age group', g.ageGroup],
      ['Colour', g.color],
      ['Size', g.size],
      ['Material', g.material],
      ['Item group id', g.itemGroupId],
      ['Custom label 0', g.customLabel0],
      ['Custom label 1', g.customLabel1],
      ['Custom label 2', g.customLabel2],
      ['Custom label 3', g.customLabel3],
      ['Custom label 4', g.customLabel4]
    ])
  );
}

function issuesTab(issues: ValidationIssue[]): HTMLElement {
  if (issues.length === 0) {
    return h(
      'div',
      { class: 'empty', style: 'padding:40px' },
      h('div', { class: 'empty__icon' }, icon('check', 20)),
      h('h3', null, 'No findings'),
      h('p', null, 'Nothing about this product was flagged during validation.')
    );
  }
  return h(
    'div',
    null,
    ...issues.map((i) =>
      h(
        'div',
        { class: 'issue' },
        h('div', { class: `issue__icon sev-${i.severity}` }, icon(i.severity === 'INFO' ? 'info' : i.severity === 'WARNING' ? 'warning' : 'error', 15)),
        h(
          'div',
          { class: 'issue__body' },
          h('div', { class: 'issue__msg' }, i.message),
          i.hint ? h('div', { class: 'issue__hint' }, i.hint) : null,
          h(
            'div',
            { class: 'issue__meta' },
            badge(i.severity, SEVERITY_TONE[i.severity]),
            i.field ? h('span', { class: 'mono' }, i.field) : null,
            i.observed ? h('span', null, `saw: ${truncate(i.observed, 70)}`) : null
          )
        )
      )
    )
  );
}

function sourceTab(p: CanonicalProduct): HTMLElement {
  const entries = Object.entries(p.provenance).sort(([a], [b]) => a.localeCompare(b));

  return h(
    'div',
    null,
    banner('info', [
      'Every value below records where it came from and how much it can be trusted. Values marked ',
      h('strong', null, 'unavailable'),
      ' were not published by the source page and were deliberately left empty.'
    ]),
    keyValue([
      ['Source address', h('span', { class: 'mono tiny' }, p.sourceUrl)],
      ['Platform', platformLabel(p.sourcePlatform)],
      ['Store product id', p.sourceProductId],
      ['Collected', dateTime(p.scrapedAt)],
      ['Layers used', p.layersUsed.join(' → ')],
      ['Opened in the browser', p.debug?.renderedWithBrowser ? 'Yes' : 'No'],
      ['Detection signals', p.debug?.detectedBy]
    ]),
    h('div', { class: 'divider' }),
    table({
      columns: [
        { header: 'Field', className: 'mono tiny', render: ([field]) => field },
        {
          header: 'Value',
          render: ([field]) => {
            const value = readPath(p, field);
            const text =
              value === null || value === undefined
                ? ''
                : typeof value === 'object'
                  ? JSON.stringify(value)
                  : String(value);
            return text
              ? h('span', { class: 'ellipsis', style: 'display:block;max-width:340px' }, truncate(text, 120))
              : h('span', { class: 'faint' }, 'empty');
          }
        },
        {
          header: 'Source',
          className: 'shrink',
          render: ([, prov]) =>
            badge(
              prov.source,
              prov.source === 'unavailable' ? 'neutral' : prov.confidence === 'high' ? 'ok' : prov.confidence === 'low' ? 'warn' : 'info'
            )
        },
        { header: 'Confidence', className: 'shrink muted tiny', render: ([, prov]) => prov.confidence },
        {
          header: 'Note',
          className: 'tiny muted',
          render: ([, prov]) =>
            prov.conflict
              ? h(
                  'span',
                  { style: 'color:var(--warn)' },
                  `disagreed with ${String(prov.conflict.otherValue)} from ${prov.conflict.otherSource}`
                )
              : (prov.note ?? '')
        }
      ],
      rows: entries
    })
  );
}

function readPath(product: CanonicalProduct, path: string): unknown {
  const variantMatch = path.match(/^variants\[([^\]]+)\]\.(.+)$/);
  if (variantMatch) {
    const v = product.variants.find((x) => x.id === variantMatch[1]);
    return v ? (v as unknown as Record<string, unknown>)[variantMatch[2]] : undefined;
  }
  let cur: unknown = product;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
