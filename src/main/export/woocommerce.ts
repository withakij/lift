/**
 * WooCommerce export adapter.
 *
 * Row shape expected by WooCommerce's built-in product CSV importer:
 *   - one row per product, Type = simple | variable | grouped | external
 *   - for a variable product, one extra row per variation, Type = variation,
 *     with `Parent` pointing at the parent product's SKU
 *   - attributes go in numbered Attribute N columns; on a variation row the
 *     value column holds the single selected value
 *
 * WooCommerce needs a stable identifier to attach variations to their parent.
 * When the source publishes a parent SKU we use it verbatim. When it does not,
 * an import grouping key derived from the product's own slug is written into
 * the parent's SKU column and reported in the export summary — it is an import
 * mechanism, never presented as source data, and it can be turned off.
 */
import { normaliseWeightUnit, type CanonicalProduct, type CanonicalVariant } from '../../shared/canonical';
import { slugify } from '../validation/engine';
import type { ExportColumn, ExportProfile, RowContext } from './types';

export interface WooExportSettings {
  /** Generate a grouping SKU for parents that have none. */
  generateParentKeys: boolean;
  /** Suffix appended to generated keys so they never collide with real SKUs. */
  keyPrefix: string;
}

export const DEFAULT_WOO_SETTINGS: WooExportSettings = {
  generateParentKeys: true,
  keyPrefix: ''
};

let settings: WooExportSettings = { ...DEFAULT_WOO_SETTINGS };

export function configureWooExport(s: Partial<WooExportSettings>): void {
  settings = { ...settings, ...s };
}

/** Products whose parent key had to be generated during the last build. */
export const generatedKeys = new Set<string>();

export function wooParentKey(p: CanonicalProduct): string {
  if (p.sku && p.sku.trim()) return p.sku.trim();
  if (!settings.generateParentKeys) return '';
  const key = `${settings.keyPrefix}${p.handle?.trim() || slugify(p.title ?? '') || p.id}`;
  generatedKeys.add(p.id);
  return key;
}

function wooType(p: CanonicalProduct): string {
  switch (p.kind) {
    case 'variable':
      return 'variable';
    case 'grouped':
      return 'grouped';
    case 'external':
      return 'external';
    default:
      return 'simple';
  }
}

function bool01(v: boolean | null | undefined, fallback: number | ''): string {
  if (v === null || v === undefined) return fallback === '' ? '' : String(fallback);
  return v ? '1' : '0';
}

function money(v: number | null): string {
  return v === null ? '' : String(v);
}

function stockToBool(status: string): string {
  if (status === 'in_stock' || status === 'preorder') return '1';
  if (status === 'out_of_stock') return '0';
  if (status === 'on_backorder') return '1';
  return '';
}

/** The full ordered attribute axis list a product exposes. */
export function attributeAxes(p: CanonicalProduct): Array<{ name: string; values: string[]; isGlobal: boolean; isVariation: boolean; visible: boolean }> {
  const out: Array<{ name: string; values: string[]; isGlobal: boolean; isVariation: boolean; visible: boolean }> = [];
  const seen = new Set<string>();

  for (const o of p.options) {
    const key = o.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const declared = p.attributes.find((a) => a.name.toLowerCase() === key);
    const values = o.values.length ? o.values : uniqueVariantValues(p, o.name);
    out.push({ name: o.name, values, isGlobal: declared?.isGlobal ?? false, isVariation: true, visible: declared?.visible ?? true });
  }
  for (const a of p.attributes) {
    const key = a.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: a.name, values: a.values, isGlobal: a.isGlobal, isVariation: a.isVariation, visible: a.visible });
  }
  return out;
}

function uniqueVariantValues(p: CanonicalProduct, axisName: string): string[] {
  const vals: string[] = [];
  for (const v of p.variants) {
    const o = v.options.find((x) => x.name.toLowerCase() === axisName.toLowerCase());
    if (o?.value && !vals.includes(o.value)) vals.push(o.value);
  }
  return vals;
}

function variantAxisValue(v: CanonicalVariant, axisName: string): string {
  return v.options.find((o) => o.name.toLowerCase() === axisName.toLowerCase())?.value ?? '';
}

/* ------------------------------------------------------------------ */

const isVariation = (c: RowContext): boolean => c.rowType === 'variant';

const C = {
  id: () => '',
  type: (c: RowContext) => (isVariation(c) ? 'variation' : wooType(c.product)),
  sku: (c: RowContext) => (isVariation(c) ? c.variant?.sku ?? '' : wooParentKey(c.product)),
  name: (c: RowContext) => {
    if (!isVariation(c)) return c.product.title ?? '';
    const suffix = c.variant?.options.map((o) => o.value).join(', ');
    return suffix ? `${c.product.title ?? ''} - ${suffix}` : c.product.title ?? '';
  },
  published: (c: RowContext) => (c.product.published === false ? '0' : '1'),
  featured: () => '0',
  visibility: () => 'visible',
  shortDesc: (c: RowContext) => (isVariation(c) ? '' : c.product.shortDescriptionHtml ?? c.product.shortDescriptionText ?? ''),
  description: (c: RowContext) => (isVariation(c) ? '' : c.product.descriptionHtml ?? c.product.descriptionText ?? ''),
  saleFrom: () => '',
  saleTo: () => '',
  taxStatus: (c: RowContext) => c.product.taxStatus ?? 'taxable',
  taxClass: (c: RowContext) => c.product.taxClass ?? '',
  inStock: (c: RowContext) => stockToBool(isVariation(c) ? c.variant?.stockStatus ?? 'unknown' : c.product.stockStatus),
  stock: (c: RowContext) => {
    const q = isVariation(c) ? c.variant?.inventoryQuantity ?? null : c.product.inventoryQuantity;
    return q === null ? '' : String(q);
  },
  lowStock: (c: RowContext) => (c.product.lowStockAmount === null ? '' : String(c.product.lowStockAmount)),
  backorders: (c: RowContext) => {
    const b = isVariation(c) ? c.variant?.backordersAllowed ?? null : c.product.backordersAllowed;
    const status = isVariation(c) ? c.variant?.stockStatus : c.product.stockStatus;
    if (b === null || b === undefined) return status === 'on_backorder' ? '1' : '';
    return b ? '1' : '0';
  },
  soldIndividually: (c: RowContext) => bool01(c.product.soldIndividually, ''),
  weight: (c: RowContext) => {
    const w = isVariation(c) ? c.variant?.weight ?? null : c.product.weight;
    return w === null ? '' : String(w);
  },
  length: (c: RowContext) => numOrBlank(isVariation(c) ? c.variant?.length ?? null : c.product.length),
  width: (c: RowContext) => numOrBlank(isVariation(c) ? c.variant?.width ?? null : c.product.width),
  height: (c: RowContext) => numOrBlank(isVariation(c) ? c.variant?.height ?? null : c.product.height),
  reviews: (c: RowContext) => bool01(c.product.allowReviews, ''),
  purchaseNote: (c: RowContext) => c.product.purchaseNote ?? '',
  salePrice: (c: RowContext) => money(isVariation(c) ? c.variant?.salePrice ?? null : c.product.salePrice),
  regularPrice: (c: RowContext) => {
    if (isVariation(c)) {
      const v = c.variant;
      if (!v) return '';
      return money(v.regularPrice ?? v.price);
    }
    if (c.product.kind === 'variable') return '';
    return money(c.product.regularPrice ?? c.product.price);
  },
  categories: (c: RowContext) => (isVariation(c) ? '' : c.product.categoryPath ?? c.product.sourceProductType ?? ''),
  tags: (c: RowContext) => (isVariation(c) ? '' : c.product.tags.join(', ')),
  shippingClass: (c: RowContext) => c.product.shippingClass ?? '',
  images: (c: RowContext) => {
    if (isVariation(c)) return c.variant?.imageUrl ?? '';
    const ordered = orderedImages(c.product);
    return ordered.map((i) => i.url).join(', ');
  },
  downloadLimit: () => '',
  downloadExpiry: () => '',
  parent: (c: RowContext) => (isVariation(c) ? wooParentKey(c.product) : ''),
  grouped: () => '',
  upsells: () => '',
  crossSells: () => '',
  externalUrl: (c: RowContext) => (c.product.kind === 'external' ? c.product.externalUrl ?? '' : ''),
  buttonText: (c: RowContext) => (c.product.kind === 'external' ? c.product.externalButtonText ?? '' : ''),
  position: (c: RowContext) => (isVariation(c) ? String(c.index) : '0')
};

function numOrBlank(v: number | null): string {
  return v === null ? '' : String(v);
}

function orderedImages(p: CanonicalProduct) {
  const imgs = [...p.images].sort((a, b) => a.position - b.position);
  if (p.featuredImageUrl) {
    const i = imgs.findIndex((x) => x.url === p.featuredImageUrl);
    if (i > 0) {
      const [f] = imgs.splice(i, 1);
      imgs.unshift(f);
    }
  }
  return imgs;
}

/* ------------------------------------------------------------------ */

export const wooProfile: ExportProfile = {
  id: 'woocommerce-default',
  format: 'woocommerce',
  label: 'WooCommerce — product CSV',
  description:
    "WooCommerce's built-in product CSV importer format, including variation rows linked to their parent and numbered attribute columns.",
  columns: [
    { header: 'ID', get: C.id },
    { header: 'Type', get: C.type },
    { header: 'SKU', get: C.sku },
    { header: 'Name', get: C.name },
    { header: 'Published', get: C.published },
    { header: 'Is featured?', get: C.featured },
    { header: 'Visibility in catalog', get: C.visibility },
    { header: 'Short description', get: C.shortDesc },
    { header: 'Description', get: C.description },
    { header: 'Date sale price starts', get: C.saleFrom },
    { header: 'Date sale price ends', get: C.saleTo },
    { header: 'Tax status', get: C.taxStatus },
    { header: 'Tax class', get: C.taxClass },
    { header: 'In stock?', get: C.inStock },
    { header: 'Stock', get: C.stock },
    { header: 'Low stock amount', get: C.lowStock },
    { header: 'Backorders allowed?', get: C.backorders },
    { header: 'Sold individually?', get: C.soldIndividually },
    { header: 'Weight (kg)', get: C.weight },
    { header: 'Length (cm)', get: C.length },
    { header: 'Width (cm)', get: C.width },
    { header: 'Height (cm)', get: C.height },
    { header: 'Allow customer reviews?', get: C.reviews },
    { header: 'Purchase note', get: C.purchaseNote },
    { header: 'Sale price', get: C.salePrice },
    { header: 'Regular price', get: C.regularPrice },
    { header: 'Categories', get: C.categories },
    { header: 'Tags', get: C.tags },
    { header: 'Shipping class', get: C.shippingClass },
    { header: 'Images', get: C.images },
    { header: 'Download limit', get: C.downloadLimit },
    { header: 'Download expiry days', get: C.downloadExpiry },
    { header: 'Parent', get: C.parent },
    { header: 'Grouped products', get: C.grouped },
    { header: 'Upsells', get: C.upsells },
    { header: 'Cross-sells', get: C.crossSells },
    { header: 'External URL', get: C.externalUrl },
    { header: 'Button text', get: C.buttonText },
    { header: 'Position', get: C.position }
  ],

  dynamicColumns(products): ExportColumn[] {
    const maxAxes = products.reduce((n, p) => Math.max(n, attributeAxes(p).length), 0);
    const cols: ExportColumn[] = [];
    for (let i = 0; i < maxAxes; i++) {
      const n = i + 1;
      cols.push({
        header: `Attribute ${n} name`,
        get: (c) => attributeAxes(c.product)[i]?.name ?? ''
      });
      cols.push({
        header: `Attribute ${n} value(s)`,
        get: (c) => {
          const axis = attributeAxes(c.product)[i];
          if (!axis) return '';
          if (isVariation(c) && c.variant) return variantAxisValue(c.variant, axis.name);
          return axis.values.join(', ');
        }
      });
      cols.push({
        header: `Attribute ${n} visible`,
        get: (c) => {
          const axis = attributeAxes(c.product)[i];
          if (!axis || isVariation(c)) return '';
          return axis.visible ? '1' : '0';
        }
      });
      cols.push({
        header: `Attribute ${n} global`,
        get: (c) => {
          const axis = attributeAxes(c.product)[i];
          if (!axis || isVariation(c)) return '';
          return axis.isGlobal ? '1' : '0';
        }
      });
      cols.push({
        header: `Attribute ${n} default`,
        get: (c) => {
          const axis = attributeAxes(c.product)[i];
          if (!axis || isVariation(c) || !axis.isVariation) return '';
          // Only declare a default when the source itself selected one.
          return '';
        }
      });
    }
    // Weight unit is not a WooCommerce column, but losing it silently would be
    // wrong when the source was not metric, so it rides along as meta.
    cols.push({
      header: 'meta:_toto_weight_unit',
      get: (c) => {
        const unit = isVariation(c) ? c.variant?.weightUnit ?? null : c.product.weightUnit;
        return normaliseWeightUnit(unit) ?? '';
      }
    });
    cols.push({ header: 'meta:_toto_source_url', get: (c) => (isVariation(c) ? '' : c.product.sourceUrl) });
    return cols;
  },

  buildRows(product): RowContext[] {
    const rows: RowContext[] = [{ product, variant: null, image: null, rowType: 'primary', index: 0 }];
    if (product.kind === 'variable' || product.variants.length > 1) {
      product.variants.forEach((variant, i) => {
        rows.push({ product, variant, image: null, rowType: 'variant', index: i + 1 });
      });
    }
    return rows;
  }
};
