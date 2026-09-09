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
import {
  normaliseDimensionUnit,
  normaliseWeightUnit,
  toCentimetres,
  toKilograms,
  type CanonicalProduct,
  type CanonicalVariant
} from '../../shared/canonical';
import { slugify } from '../validation/engine';
import type { ExportColumn, ExportProfile, RowContext } from './types';

export interface WooExportSettings {
  /** Generate a grouping SKU for parents that have none. */
  generateParentKeys: boolean;
  /** Suffix appended to generated keys so they never collide with real SKUs. */
  keyPrefix: string;
}

/** Namespace for the app's own meta columns, so they never clash with a store's. */
const META_PREFIX = '_lift';

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

/**
 * A product that is not exported as a variable one but still carries a single
 * variant keeps its price, SKU, stock and measurements on that variant — every
 * Shopify "simple" product is shaped this way, because Shopify has no product
 * without variants. WooCommerce writes those values on the product row itself,
 * so the single variant is where the product row has to read them from.
 *
 * Only ever consulted for a lone variant: with two or more, variation rows are
 * emitted and nothing may be lifted onto the parent.
 */
export function soleVariant(p: CanonicalProduct): CanonicalVariant | null {
  if (emitsVariations(p)) return null;
  return p.variants.length === 1 ? p.variants[0] : null;
}

/** Whether this product is written as a parent row plus variation rows. */
function emitsVariations(p: CanonicalProduct): boolean {
  return p.kind === 'variable' || p.variants.length > 1;
}

export function wooParentKey(p: CanonicalProduct): string {
  if (p.sku && p.sku.trim()) return p.sku.trim();
  const sole = soleVariant(p);
  if (sole?.sku && sole.sku.trim()) return sole.sku.trim();
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
      // Variation rows under a "simple" parent are rejected by the importer, so
      // when several variants are written the parent must say it is variable.
      return emitsVariations(p) ? 'variable' : 'simple';
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

/**
 * The variant a row should read variant-level fields from: the row's own
 * variant on a variation row, and on a product row the lone variant a simple
 * product may be carrying (see soleVariant).
 */
function rowVariant(c: RowContext): CanonicalVariant | null {
  return isVariation(c) ? c.variant : soleVariant(c.product);
}

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
  inStock: (c: RowContext) => {
    const v = rowVariant(c);
    const status = isVariation(c)
      ? v?.stockStatus ?? 'unknown'
      : c.product.stockStatus !== 'unknown'
        ? c.product.stockStatus
        : v?.stockStatus ?? 'unknown';
    return stockToBool(status);
  },
  stock: (c: RowContext) => {
    const v = rowVariant(c);
    const q = isVariation(c) ? v?.inventoryQuantity ?? null : c.product.inventoryQuantity ?? v?.inventoryQuantity ?? null;
    return q === null ? '' : String(q);
  },
  lowStock: (c: RowContext) => (c.product.lowStockAmount === null ? '' : String(c.product.lowStockAmount)),
  backorders: (c: RowContext) => {
    const v = rowVariant(c);
    const b = isVariation(c) ? v?.backordersAllowed ?? null : c.product.backordersAllowed ?? v?.backordersAllowed ?? null;
    const status = isVariation(c) ? v?.stockStatus : c.product.stockStatus !== 'unknown' ? c.product.stockStatus : v?.stockStatus;
    if (b === null || b === undefined) return status === 'on_backorder' ? '1' : '';
    return b ? '1' : '0';
  },
  soldIndividually: (c: RowContext) => bool01(c.product.soldIndividually, ''),
  /** Kilograms, to match the column header. An unconvertible unit is left blank. */
  weight: (c: RowContext) => {
    const v = rowVariant(c);
    const w = isVariation(c) ? v?.weight ?? null : c.product.weight ?? v?.weight ?? null;
    if (w === null) return '';
    const unit = isVariation(c) ? v?.weightUnit ?? null : c.product.weightUnit ?? v?.weightUnit ?? null;
    // No unit published anywhere: the number is all the source gave us, so it
    // is passed through and the (empty) unit is recorded in the meta column.
    if (!unit) return String(w);
    return numOrBlank(toKilograms(w, unit));
  },
  length: (c: RowContext) => dimension(c, 'length'),
  width: (c: RowContext) => dimension(c, 'width'),
  height: (c: RowContext) => dimension(c, 'height'),
  reviews: (c: RowContext) => bool01(c.product.allowReviews, ''),
  purchaseNote: (c: RowContext) => c.product.purchaseNote ?? '',
  salePrice: (c: RowContext) => money(pricesFor(c).sale),
  regularPrice: (c: RowContext) => money(pricesFor(c).regular),
  categories: (c: RowContext) => (isVariation(c) ? '' : c.product.categoryPath ?? c.product.sourceProductType ?? ''),
  tags: (c: RowContext) => (isVariation(c) ? '' : c.product.tags.join(', ')),
  shippingClass: (c: RowContext) => c.product.shippingClass ?? '',
  images: (c: RowContext) => {
    if (isVariation(c)) return c.variant?.imageUrl ?? '';
    const ordered = orderedImages(c.product);
    if (ordered.length) return ordered.map((i) => i.url).join(', ');
    // Nothing in the gallery, but a lone variant may still name an image.
    return soleVariant(c.product)?.imageUrl ?? '';
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

/**
 * WooCommerce splits a price into "Regular" and "Sale". A source that publishes
 * a compare-at price is saying exactly that — the compare-at figure is the
 * regular price and the current price is the sale price — so the discount is
 * carried across rather than dropped. Nothing is invented: with no compare-at
 * price there is simply no sale price.
 */
function pricesFor(c: RowContext): { regular: number | null; sale: number | null } {
  const v = rowVariant(c);
  if (isVariation(c)) {
    if (!v) return { regular: null, sale: null };
    return split(v.price, v.regularPrice, v.salePrice, v.compareAtPrice);
  }
  // A variable parent has no price of its own; its variation rows carry them.
  if (emitsVariations(c.product)) return { regular: null, sale: null };
  const p = c.product;
  return split(
    p.price ?? v?.price ?? null,
    p.regularPrice ?? v?.regularPrice ?? null,
    p.salePrice ?? v?.salePrice ?? null,
    p.compareAtPrice ?? v?.compareAtPrice ?? null
  );
}

function split(
  price: number | null,
  regular: number | null,
  sale: number | null,
  compareAt: number | null
): { regular: number | null; sale: number | null } {
  if (regular !== null) return { regular, sale: sale ?? (price !== null && price < regular ? price : null) };
  if (compareAt !== null && price !== null && compareAt > price) return { regular: compareAt, sale: price };
  return { regular: price, sale };
}

/** Centimetres, to match the column header. */
function dimension(c: RowContext, field: 'length' | 'width' | 'height'): string {
  const v = rowVariant(c);
  const raw = isVariation(c) ? v?.[field] ?? null : c.product[field] ?? v?.[field] ?? null;
  if (raw === null) return '';
  const unit = isVariation(c) ? v?.dimensionUnit ?? null : c.product.dimensionUnit ?? v?.dimensionUnit ?? null;
  if (!unit) return String(raw);
  return numOrBlank(toCentimetres(raw, unit));
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
    // The Weight and dimension columns are written in kg and cm to match their
    // headers. The unit the source actually published is not a WooCommerce
    // column, but discarding it would hide what was converted, so it rides
    // along as meta.
    cols.push({
      header: `meta:${META_PREFIX}_source_weight_unit`,
      get: (c) => {
        const v = rowVariant(c);
        const unit = isVariation(c) ? v?.weightUnit ?? null : c.product.weightUnit ?? v?.weightUnit ?? null;
        return normaliseWeightUnit(unit) ?? '';
      }
    });
    cols.push({
      header: `meta:${META_PREFIX}_source_dimension_unit`,
      get: (c) => {
        const v = rowVariant(c);
        const unit = isVariation(c) ? v?.dimensionUnit ?? null : c.product.dimensionUnit ?? v?.dimensionUnit ?? null;
        return normaliseDimensionUnit(unit) ?? '';
      }
    });
    cols.push({ header: `meta:${META_PREFIX}_source_url`, get: (c) => (isVariation(c) ? '' : c.product.sourceUrl) });
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
