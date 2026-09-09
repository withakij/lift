/**
 * Shopify export adapter.
 *
 * Two column profiles are supplied because Shopify accepts both the long-
 * standing import headers and the newer human-readable ones its own exports now
 * produce. Profiles are plain data, so a future header change is a config edit
 * rather than a code change.
 *
 * Row shape (the structure Shopify's importer expects):
 *   row 1        product fields + variant 1 + image 1
 *   rows 2..n    handle + option values + variant fields (+ variant image)
 *   extra rows   handle + image src/position/alt only, for gallery images
 *                that no variant row has already carried
 */
import {
  emptyVariant,
  toGrams,
  type CanonicalImage,
  type CanonicalProduct,
  type CanonicalVariant
} from '../../shared/canonical';
import { slugify } from '../validation/engine';
import type { ExportProfile, RowContext } from './types';

const DEFAULT_INVENTORY_TRACKER = 'shopify';
const DEFAULT_FULFILLMENT = 'manual';

function optionName(p: CanonicalProduct, i: number): string {
  const explicit = p.options[i]?.name;
  if (explicit) return explicit;
  // Fall back to whatever the variants themselves call the axis.
  const fromVariant = p.variants.find((v) => v.options[i])?.options[i]?.name;
  if (fromVariant) return fromVariant;
  return i === 0 && p.variants.length <= 1 ? 'Title' : '';
}

function optionValue(v: CanonicalVariant | null, p: CanonicalProduct, i: number): string {
  if (!v) return i === 0 && p.options.length === 0 ? 'Default Title' : '';
  const byName = p.options[i]?.name
    ? v.options.find((o) => o.name.toLowerCase() === p.options[i].name.toLowerCase())
    : undefined;
  const chosen = byName ?? v.options[i];
  if (chosen) return chosen.value;
  return i === 0 && v.options.length === 0 ? 'Default Title' : '';
}

export function shopifyHandle(p: CanonicalProduct): string {
  return p.handle?.trim() || slugify(p.title ?? '') || p.id;
}

/** true/false as Shopify's importer expects them. */
function bool(v: boolean | null | undefined, fallback: boolean): string {
  return (v === null || v === undefined ? fallback : v) ? 'TRUE' : 'FALSE';
}

function money(v: number | null): string {
  return v === null ? '' : v.toFixed(2);
}

/* ------------------------------------------------------------------ */
/* Shared value resolvers                                              */
/* ------------------------------------------------------------------ */

const V = {
  handle: (c: RowContext) => shopifyHandle(c.product),
  title: (c: RowContext) => (c.rowType === 'primary' ? c.product.title ?? '' : ''),
  body: (c: RowContext) => (c.rowType === 'primary' ? c.product.descriptionHtml ?? c.product.descriptionText ?? '' : ''),
  vendor: (c: RowContext) => (c.rowType === 'primary' ? c.product.vendor ?? c.product.brand ?? '' : ''),
  /** The category configured in the app wins; the source's own type is a fallback. */
  productCategory: (c: RowContext) => (c.rowType === 'primary' ? c.product.categoryPath ?? '' : ''),
  type: (c: RowContext) => (c.rowType === 'primary' ? c.product.categoryPath ?? c.product.sourceProductType ?? '' : ''),
  tags: (c: RowContext) => (c.rowType === 'primary' ? c.product.tags.join(', ') : ''),
  published: (c: RowContext) => (c.rowType === 'primary' ? bool(c.product.published, true) : ''),
  status: (c: RowContext) =>
    c.rowType === 'primary' ? (c.product.status === 'unknown' ? 'active' : c.product.status) : '',

  opt1Name: (c: RowContext) => (c.rowType === 'primary' ? optionName(c.product, 0) : ''),
  opt2Name: (c: RowContext) => (c.rowType === 'primary' ? optionName(c.product, 1) : ''),
  opt3Name: (c: RowContext) => (c.rowType === 'primary' ? optionName(c.product, 2) : ''),
  opt1Value: (c: RowContext) => (c.variant ? optionValue(c.variant, c.product, 0) : ''),
  opt2Value: (c: RowContext) => (c.variant ? optionValue(c.variant, c.product, 1) : ''),
  opt3Value: (c: RowContext) => (c.variant ? optionValue(c.variant, c.product, 2) : ''),

  vSku: (c: RowContext) => c.variant?.sku ?? (c.rowType === 'primary' && !c.variant ? c.product.sku ?? '' : ''),
  vBarcode: (c: RowContext) => c.variant?.barcode ?? (c.rowType === 'primary' && !c.variant ? c.product.barcode ?? '' : ''),
  vGrams: (c: RowContext) => {
    if (!c.variant) return '';
    const g = toGrams(c.variant.weight, c.variant.weightUnit);
    return g === null ? '' : String(Math.round(g));
  },
  vWeightUnit: (c: RowContext) => c.variant?.weightUnit ?? '',
  vTracker: (c: RowContext) => {
    if (!c.variant) return '';
    if (c.variant.inventoryTracker) return c.variant.inventoryTracker;
    return c.variant.inventoryQuantity !== null ? DEFAULT_INVENTORY_TRACKER : '';
  },
  vQty: (c: RowContext) => (c.variant?.inventoryQuantity === null || c.variant === null ? '' : String(c.variant.inventoryQuantity)),
  vPolicy: (c: RowContext) => {
    if (!c.variant) return '';
    if (c.variant.inventoryPolicy) return c.variant.inventoryPolicy;
    if (c.variant.stockStatus === 'on_backorder' || c.variant.stockStatus === 'preorder') return 'continue';
    return c.variant.inventoryQuantity !== null ? 'deny' : '';
  },
  vContinue: (c: RowContext) => {
    if (!c.variant) return '';
    const policy = c.variant.inventoryPolicy ?? (c.variant.stockStatus === 'on_backorder' ? 'continue' : null);
    return policy === null ? '' : policy === 'continue' ? 'TRUE' : 'FALSE';
  },
  vFulfilment: (c: RowContext) => (c.variant ? DEFAULT_FULFILLMENT : ''),
  vPrice: (c: RowContext) => money(c.variant ? c.variant.price : null),
  vCompare: (c: RowContext) => money(c.variant ? c.variant.compareAtPrice : null),
  vRequiresShipping: (c: RowContext) => (c.variant ? bool(c.variant.requiresShipping, true) : ''),
  vTaxable: (c: RowContext) => (c.variant ? bool(c.variant.taxable, true) : ''),
  vCost: (c: RowContext) => money(c.variant?.costPerItem ?? (c.rowType === 'primary' ? c.product.costPerItem : null)),
  vImage: (c: RowContext) => c.variant?.imageUrl ?? '',

  imgSrc: (c: RowContext) => c.image?.url ?? '',
  imgPos: (c: RowContext) => (c.image ? String(c.image.position) : ''),
  imgAlt: (c: RowContext) => c.image?.alt ?? '',

  giftCard: (c: RowContext) => (c.rowType === 'primary' ? 'FALSE' : ''),
  seoTitle: (c: RowContext) => (c.rowType === 'primary' ? c.product.seo.title ?? '' : ''),
  seoDesc: (c: RowContext) => (c.rowType === 'primary' ? c.product.seo.metaDescription ?? c.product.seo.description ?? '' : ''),

  /* Google Shopping — emitted only when the source actually published them. */
  gCategory: (c: RowContext) => (c.rowType === 'primary' ? c.product.google.googleProductCategory ?? '' : ''),
  gGender: (c: RowContext) => (c.rowType === 'primary' ? c.product.google.gender ?? '' : ''),
  gAge: (c: RowContext) => (c.rowType === 'primary' ? c.product.google.ageGroup ?? '' : ''),
  gMpn: (c: RowContext) => (c.rowType === 'primary' ? c.product.google.mpn ?? '' : ''),
  gCondition: (c: RowContext) =>
    c.rowType === 'primary' && c.product.google.condition !== 'unknown' ? c.product.google.condition : '',
  gCustomProduct: (c: RowContext) => (c.rowType === 'primary' ? (c.product.google.identifierExists === false ? 'TRUE' : '') : ''),
  gAdsGrouping: (c: RowContext) => (c.rowType === 'primary' ? c.product.google.adsGrouping ?? '' : ''),
  gAdsLabels: (c: RowContext) => (c.rowType === 'primary' ? c.product.google.adsLabels.join(', ') : ''),
  gLabel: (n: 0 | 1 | 2 | 3 | 4) => (c: RowContext) =>
    c.rowType === 'primary' ? c.product.google[`customLabel${n}` as const] ?? '' : ''
};

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

export const shopifyLegacyProfile: ExportProfile = {
  id: 'shopify-legacy',
  format: 'shopify',
  label: 'Shopify — product import CSV',
  description:
    "Shopify's long-standing product import columns (Handle, Title, Body (HTML), Variant …). Accepted by Products → Import in every current Shopify plan.",
  columns: [
    { header: 'Handle', get: V.handle },
    { header: 'Title', get: V.title },
    { header: 'Body (HTML)', get: V.body },
    { header: 'Vendor', get: V.vendor },
    { header: 'Product Category', get: V.productCategory },
    { header: 'Type', get: V.type },
    { header: 'Tags', get: V.tags },
    { header: 'Published', get: V.published },
    { header: 'Option1 Name', get: V.opt1Name },
    { header: 'Option1 Value', get: V.opt1Value },
    { header: 'Option2 Name', get: V.opt2Name },
    { header: 'Option2 Value', get: V.opt2Value },
    { header: 'Option3 Name', get: V.opt3Name },
    { header: 'Option3 Value', get: V.opt3Value },
    { header: 'Variant SKU', get: V.vSku },
    { header: 'Variant Grams', get: V.vGrams },
    { header: 'Variant Inventory Tracker', get: V.vTracker },
    { header: 'Variant Inventory Qty', get: V.vQty },
    { header: 'Variant Inventory Policy', get: V.vPolicy },
    { header: 'Variant Fulfillment Service', get: V.vFulfilment },
    { header: 'Variant Price', get: V.vPrice },
    { header: 'Variant Compare At Price', get: V.vCompare },
    { header: 'Variant Requires Shipping', get: V.vRequiresShipping },
    { header: 'Variant Taxable', get: V.vTaxable },
    { header: 'Variant Barcode', get: V.vBarcode },
    { header: 'Image Src', get: V.imgSrc },
    { header: 'Image Position', get: V.imgPos },
    { header: 'Image Alt Text', get: V.imgAlt },
    { header: 'Gift Card', get: V.giftCard },
    { header: 'SEO Title', get: V.seoTitle },
    { header: 'SEO Description', get: V.seoDesc },
    { header: 'Google Shopping / Google Product Category', get: V.gCategory },
    { header: 'Google Shopping / Gender', get: V.gGender },
    { header: 'Google Shopping / Age Group', get: V.gAge },
    { header: 'Google Shopping / MPN', get: V.gMpn },
    { header: 'Google Shopping / AdWords Grouping', get: V.gAdsGrouping },
    { header: 'Google Shopping / AdWords Labels', get: V.gAdsLabels },
    { header: 'Google Shopping / Condition', get: V.gCondition },
    { header: 'Google Shopping / Custom Product', get: V.gCustomProduct },
    { header: 'Google Shopping / Custom Label 0', get: V.gLabel(0) },
    { header: 'Google Shopping / Custom Label 1', get: V.gLabel(1) },
    { header: 'Google Shopping / Custom Label 2', get: V.gLabel(2) },
    { header: 'Google Shopping / Custom Label 3', get: V.gLabel(3) },
    { header: 'Google Shopping / Custom Label 4', get: V.gLabel(4) },
    { header: 'Variant Image', get: V.vImage },
    { header: 'Variant Weight Unit', get: V.vWeightUnit },
    { header: 'Variant Tax Code', get: () => '' },
    { header: 'Cost per item', get: V.vCost },
    { header: 'Status', get: V.status }
  ],
  buildRows: buildShopifyRows
};

export const shopifyModernProfile: ExportProfile = {
  id: 'shopify-2024',
  format: 'shopify',
  label: 'Shopify — current export column names',
  description:
    'The friendlier header names Shopify now uses when it exports products (Title, URL handle, Description …). Use this if you want the file to match a fresh Shopify export.',
  columns: [
    { header: 'Title', get: V.title },
    { header: 'URL handle', get: V.handle },
    { header: 'Description', get: V.body },
    { header: 'Vendor', get: V.vendor },
    { header: 'Product category', get: V.productCategory },
    { header: 'Type', get: V.type },
    { header: 'Tags', get: V.tags },
    { header: 'Published on online store', get: V.published },
    { header: 'Status', get: V.status },
    { header: 'SKU', get: V.vSku },
    { header: 'Barcode', get: V.vBarcode },
    { header: 'Option1 name', get: V.opt1Name },
    { header: 'Option1 value', get: V.opt1Value },
    { header: 'Option2 name', get: V.opt2Name },
    { header: 'Option2 value', get: V.opt2Value },
    { header: 'Option3 name', get: V.opt3Name },
    { header: 'Option3 value', get: V.opt3Value },
    { header: 'Price', get: V.vPrice },
    { header: 'Compare-at price', get: V.vCompare },
    { header: 'Cost per item', get: V.vCost },
    { header: 'Charge tax', get: V.vTaxable },
    { header: 'Inventory tracker', get: V.vTracker },
    { header: 'Inventory quantity', get: V.vQty },
    { header: 'Continue selling when out of stock', get: V.vContinue },
    { header: 'Weight value (grams)', get: V.vGrams },
    { header: 'Weight unit for display', get: V.vWeightUnit },
    { header: 'Requires shipping', get: V.vRequiresShipping },
    { header: 'Fulfillment service', get: V.vFulfilment },
    { header: 'Product image URL', get: V.imgSrc },
    { header: 'Image position', get: V.imgPos },
    { header: 'Image alt text', get: V.imgAlt },
    { header: 'Variant image URL', get: V.vImage },
    { header: 'Gift card', get: V.giftCard },
    { header: 'SEO title', get: V.seoTitle },
    { header: 'SEO description', get: V.seoDesc },
    { header: 'Google Shopping / Google Product Category', get: V.gCategory },
    { header: 'Google Shopping / Gender', get: V.gGender },
    { header: 'Google Shopping / Age Group', get: V.gAge },
    { header: 'Google Shopping / MPN', get: V.gMpn },
    { header: 'Google Shopping / Condition', get: V.gCondition },
    { header: 'Google Shopping / Custom Product', get: V.gCustomProduct },
    { header: 'Google Shopping / Custom Label 0', get: V.gLabel(0) },
    { header: 'Google Shopping / Custom Label 1', get: V.gLabel(1) },
    { header: 'Google Shopping / Custom Label 2', get: V.gLabel(2) },
    { header: 'Google Shopping / Custom Label 3', get: V.gLabel(3) },
    { header: 'Google Shopping / Custom Label 4', get: V.gLabel(4) }
  ],
  buildRows: buildShopifyRows
};

/* ------------------------------------------------------------------ */

/**
 * Shopify has no concept of a product without variants: a simple product is a
 * product with one "Default Title" variant. So when the source published no
 * variants we present the product's OWN values through that single row. This
 * copies nothing between variants and adds no data the source did not give.
 */
function defaultVariantView(p: CanonicalProduct): CanonicalVariant {
  const v = emptyVariant(`${p.id}-default`, p.id, 1);
  v.sku = p.sku;
  v.barcode = p.barcode;
  v.price = p.price;
  v.compareAtPrice = p.compareAtPrice;
  v.regularPrice = p.regularPrice;
  v.salePrice = p.salePrice;
  v.costPerItem = p.costPerItem;
  v.currency = p.currency;
  v.stockStatus = p.stockStatus;
  v.available = p.stockStatus === 'unknown' ? null : p.stockStatus === 'in_stock';
  v.inventoryQuantity = p.inventoryQuantity;
  v.inventoryPolicy = p.inventoryPolicy;
  v.backordersAllowed = p.backordersAllowed;
  v.weight = p.weight;
  v.weightUnit = p.weightUnit;
  v.requiresShipping = p.requiresShipping;
  v.taxable = p.taxable;
  return v;
}

function buildShopifyRows(product: CanonicalProduct): RowContext[] {
  const rows: RowContext[] = [];
  const variants: Array<CanonicalVariant | null> = product.variants.length
    ? product.variants
    : [defaultVariantView(product)];
  const images = [...product.images].sort((a, b) => a.position - b.position);

  // Put the featured image first so Shopify makes it the product image.
  if (product.featuredImageUrl) {
    const idx = images.findIndex((i) => i.url === product.featuredImageUrl);
    if (idx > 0) {
      const [feat] = images.splice(idx, 1);
      images.unshift(feat);
    }
  }
  const ordered: CanonicalImage[] = images.map((img, i) => ({ ...img, position: i + 1 }));

  variants.forEach((variant, vi) => {
    rows.push({
      product,
      variant,
      image: vi < ordered.length ? ordered[vi] : null,
      rowType: vi === 0 ? 'primary' : 'variant',
      index: vi
    });
  });

  for (let i = variants.length; i < ordered.length; i++) {
    rows.push({ product, variant: null, image: ordered[i], rowType: 'image', index: i });
  }

  return rows;
}
