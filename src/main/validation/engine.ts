/**
 * Validation engine.
 *
 * Rules answer one question: "would importing this row produce something wrong
 * or incomplete in the target store?" Each returns operator-facing English, a
 * severity, and where possible the exact field involved.
 *
 * Severity contract:
 *   INFO     — worth knowing, import is fine.
 *   WARNING  — import will work but a human should look.
 *   ERROR    — the row is wrong or unusable; excluded from a strict export.
 *   CRITICAL — data integrity is compromised (mixed variants, orphan rows).
 */
import { normaliseDimensionUnit, normaliseWeightUnit, type CanonicalProduct } from '../../shared/canonical';
import type { Severity, TargetFormat, ValidationIssue, ValidationRunSummary } from '../../shared/types';
import { newId, nowIso } from '../db/store';
import { optionSignature } from '../scraper/productutil';
import { looksMalformed } from '../scraper/html';

export interface RuleContext {
  product: CanonicalProduct;
  /** Every product in the project, for cross-product checks. */
  all: CanonicalProduct[];
  targetFormat: TargetFormat;
  report: (issue: Omit<ValidationIssue, 'id' | 'projectId' | 'createdAt' | 'acknowledged' | 'productId'> & { productId?: string | null }) => void;
}

export interface ValidationRule {
  id: string;
  label: string;
  /** Cross-product rules run once per project instead of once per product. */
  scope: 'product' | 'project';
  run(ctx: RuleContext): void;
}

/* ------------------------------------------------------------------ */
/* Per-product rules                                                   */
/* ------------------------------------------------------------------ */

/** Shopify products carry at most three option axes (Option1/2/3). */
const SHOPIFY_MAX_OPTIONS = 3;

const requiredFields: ValidationRule = {
  id: 'required-fields',
  label: 'Required fields',
  scope: 'product',
  run({ product, targetFormat, report }) {
    if (!product.title) {
      report({ ruleId: 'required-fields', severity: 'CRITICAL', variantId: null, field: 'title', observed: null,
        message: 'This product has no title.', hint: 'The page may not be a product page, or the title is loaded by JavaScript. Try re-scraping with browser rendering set to Always.' });
    }
    const hasAnyPrice = product.price !== null || product.priceMin !== null || product.variants.some((v) => v.price !== null);
    if (!hasAnyPrice) {
      report({ ruleId: 'required-fields', severity: 'ERROR', variantId: null, field: 'price', observed: null,
        message: 'No price could be found for this product.', hint: 'Most imports reject rows without a price. Check the source page, or re-scrape with browser rendering enabled.' });
    }
    if (product.images.length === 0) {
      report({ ruleId: 'required-fields', severity: 'WARNING', variantId: null, field: 'images', observed: null,
        message: 'No product images were found.', hint: 'The product will import without a picture. Verify the source page has a gallery.' });
    }
    if (!product.categoryPath) {
      report({ ruleId: 'required-fields', severity: 'WARNING', variantId: null, field: 'categoryPath', observed: null,
        message: 'This product is not assigned to a category.', hint: 'Assign the URL to a category so the export carries the right category value.' });
    }
    if (!product.descriptionHtml && !product.descriptionText) {
      report({ ruleId: 'required-fields', severity: 'INFO', variantId: null, field: 'descriptionHtml', observed: null,
        message: 'No description was found for this product.', hint: null });
    }
    if (targetFormat === 'shopify' && !product.handle && !product.title) {
      report({ ruleId: 'required-fields', severity: 'ERROR', variantId: null, field: 'handle', observed: null,
        message: 'Shopify needs a handle, and neither a handle nor a title is available to build one.', hint: null });
    }
  }
};

const productType: ValidationRule = {
  id: 'product-type',
  label: 'Product type',
  scope: 'product',
  run({ product, report }) {
    if (product.kind === 'unknown') {
      report({ ruleId: 'product-type', severity: 'WARNING', variantId: null, field: 'kind', observed: 'unknown',
        message: 'It could not be determined whether this is a simple or a variable product.', hint: 'Open the product and check whether the source page has option selectors.' });
    }
    if (product.kind === 'variable' && product.variants.length < 2) {
      report({ ruleId: 'product-type', severity: 'ERROR', variantId: null, field: 'kind', observed: `${product.variants.length} variants`,
        message: 'This is marked as a variable product but has fewer than two variants.', hint: 'Variant data may not have loaded. Re-scrape with browser rendering set to Always.' });
    }
    if (product.kind === 'simple' && product.variants.length > 1) {
      report({ ruleId: 'product-type', severity: 'WARNING', variantId: null, field: 'kind', observed: `${product.variants.length} variants`,
        message: 'This is marked as a simple product but several variants were found.', hint: null });
    }
  }
};

const variantIntegrity: ValidationRule = {
  id: 'variant-integrity',
  label: 'Variant integrity',
  scope: 'product',
  run({ product, report }) {
    const seenSignatures = new Map<string, string>();
    const seenSkus = new Map<string, string>();

    for (const v of product.variants) {
      if (v.parentProductId !== product.id) {
        report({ ruleId: 'variant-integrity', severity: 'CRITICAL', variantId: v.id, field: 'parentProductId', observed: v.parentProductId,
          message: `Variant "${describeVariant(v.options)}" is not linked to this product.`, hint: 'Re-scrape this URL. Do not export until this is resolved.' });
      }

      const sig = optionSignature(v);
      if (product.variants.length > 1) {
        if (sig === '') {
          report({ ruleId: 'variant-integrity', severity: 'ERROR', variantId: v.id, field: 'options', observed: null,
            message: 'A variant has no option values, so it cannot be told apart from the others.', hint: 'The option names may be rendered by JavaScript. Re-scrape with browser rendering set to Always.' });
        } else if (seenSignatures.has(sig)) {
          report({ ruleId: 'variant-integrity', severity: 'ERROR', variantId: v.id, field: 'options', observed: sig,
            message: `Two variants share the same option combination (${describeVariant(v.options)}).`, hint: 'One of them will be dropped on import. Check the source page.' });
        } else {
          seenSignatures.set(sig, v.id);
        }
      }

      if (v.sku) {
        const prior = seenSkus.get(v.sku.toLowerCase());
        if (prior) {
          const priorV = product.variants.find((x) => x.id === prior);
          report({ ruleId: 'variant-integrity', severity: 'CRITICAL', variantId: v.id, field: 'sku', observed: v.sku,
            message: `SKU "${v.sku}" is used by two different option combinations (${describeVariant(priorV?.options ?? [])} and ${describeVariant(v.options)}).`,
            hint: 'This usually means variant data was mixed up. Re-scrape before exporting.' });
        } else {
          seenSkus.set(v.sku.toLowerCase(), v.id);
        }
      }

      if (v.price === null) {
        report({ ruleId: 'variant-integrity', severity: 'ERROR', variantId: v.id, field: 'price', observed: null,
          message: `Variant "${describeVariant(v.options)}" has no price.`, hint: 'Variant prices are often loaded on demand. Re-scrape with browser rendering set to Always.' });
      }
      if (v.price !== null && v.price < 0) {
        report({ ruleId: 'variant-integrity', severity: 'ERROR', variantId: v.id, field: 'price', observed: String(v.price),
          message: `Variant "${describeVariant(v.options)}" has a negative price.`, hint: null });
      }
      if (v.compareAtPrice !== null && v.price !== null && v.compareAtPrice <= v.price) {
        report({ ruleId: 'variant-integrity', severity: 'WARNING', variantId: v.id, field: 'compareAtPrice', observed: `${v.compareAtPrice} vs ${v.price}`,
          message: `Variant "${describeVariant(v.options)}" has a compare-at price that is not higher than its price.`, hint: 'Shopify hides the strike-through when the compare-at price is not higher. Consider clearing it.' });
      }
      if (v.inventoryQuantity !== null && (v.inventoryQuantity < 0 || v.inventoryQuantity > 1_000_000)) {
        report({ ruleId: 'variant-integrity', severity: 'WARNING', variantId: v.id, field: 'inventoryQuantity', observed: String(v.inventoryQuantity),
          message: `Variant "${describeVariant(v.options)}" reports an implausible stock quantity (${v.inventoryQuantity}).`, hint: 'Some themes print the maximum order quantity rather than real stock.' });
      }
      if (v.stockStatus === 'unknown') {
        report({ ruleId: 'variant-integrity', severity: 'INFO', variantId: v.id, field: 'stockStatus', observed: null,
          message: `Stock status is unknown for variant "${describeVariant(v.options)}".`, hint: null });
      }
    }

    // Option axes declared on the product must be satisfied by every variant.
    if (product.options.length && product.variants.length > 1) {
      const axisNames = product.options.map((o) => o.name.toLowerCase());
      for (const v of product.variants) {
        const have = v.options.map((o) => o.name.toLowerCase());
        const missing = axisNames.filter((a) => !have.includes(a));
        if (missing.length) {
          report({ ruleId: 'variant-integrity', severity: 'ERROR', variantId: v.id, field: 'options', observed: have.join(', '),
            message: `Variant "${describeVariant(v.options)}" is missing a value for ${missing.join(', ')}.`, hint: 'The variant will import against the wrong option combination.' });
        }
      }
    }

    // Every variant carrying the identical price AND sku is suspicious for a
    // variable product, because it usually means only one variant was read.
    if (product.variants.length > 2) {
      const prices = new Set(product.variants.map((v) => String(v.price)));
      const skus = new Set(product.variants.map((v) => String(v.sku)));
      if (prices.size === 1 && skus.size === 1 && product.variants[0].sku !== null) {
        report({ ruleId: 'variant-integrity', severity: 'WARNING', variantId: null, field: 'variants', observed: null,
          message: 'Every variant has the same price and the same SKU, which often means variant-specific values were not read.', hint: 'Re-scrape with browser rendering set to Always and variant interaction enabled.' });
      }
    }
  }
};

const variantImages: ValidationRule = {
  id: 'variant-images',
  label: 'Variant images',
  scope: 'product',
  run({ product, report }) {
    const galleryUrls = new Set(product.images.map((i) => i.url));
    for (const v of product.variants) {
      if (!v.imageUrl) continue;
      if (!galleryUrls.has(v.imageUrl)) {
        report({ ruleId: 'variant-images', severity: 'WARNING', variantId: v.id, field: 'imageUrl', observed: v.imageUrl,
          message: `The image for variant "${describeVariant(v.options)}" is not in the product gallery.`, hint: 'It will still be exported, but check that it belongs to this product.' });
      }
    }
    if (product.variants.length > 1) {
      const withImages = product.variants.filter((v) => v.imageUrl);
      if (withImages.length > 0 && withImages.length < product.variants.length) {
        report({ ruleId: 'variant-images', severity: 'INFO', variantId: null, field: 'imageUrl', observed: `${withImages.length}/${product.variants.length}`,
          message: 'Only some variants have their own image.', hint: null });
      }
      const distinct = new Set(withImages.map((v) => v.imageUrl));
      if (withImages.length > 2 && distinct.size === 1) {
        report({ ruleId: 'variant-images', severity: 'WARNING', variantId: null, field: 'imageUrl', observed: [...distinct][0] ?? null,
          message: 'Every variant points at the same image, which may mean variant images were not detected.', hint: null });
      }
    }
    const featuredProv = product.provenance['featuredImageUrl'];
    if (product.images.length > 1 && featuredProv?.confidence === 'low') {
      report({ ruleId: 'variant-images', severity: 'INFO', variantId: null, field: 'featuredImageUrl', observed: product.featuredImageUrl,
        message: 'The source did not mark a primary image; the first gallery image was used.', hint: 'Check the main image before importing.' });
    }
  }
};

const priceConsistency: ValidationRule = {
  id: 'price-consistency',
  label: 'Price consistency',
  scope: 'product',
  run({ product, report }) {
    const currencies = new Set(
      [product.currency, ...product.variants.map((v) => v.currency)].filter((c): c is string => !!c)
    );
    if (currencies.size > 1) {
      report({ ruleId: 'price-consistency', severity: 'ERROR', variantId: null, field: 'currency', observed: [...currencies].join(', '),
        message: `This product mixes more than one currency (${[...currencies].join(', ')}).`, hint: 'Prices from different currencies must not be imported together.' });
    }
    if (currencies.size === 0) {
      report({ ruleId: 'price-consistency', severity: 'INFO', variantId: null, field: 'currency', observed: null,
        message: 'No currency was published by the source page.', hint: 'The importing store will apply its own currency.' });
    }

    if (product.price !== null && product.variants.length) {
      const prices = product.variants.map((v) => v.price).filter((p): p is number => p !== null);
      if (prices.length && (product.price < Math.min(...prices) - 0.01 || product.price > Math.max(...prices) + 0.01)) {
        report({ ruleId: 'price-consistency', severity: 'WARNING', variantId: null, field: 'price', observed: String(product.price),
          message: `The product price (${product.price}) sits outside the range of its variant prices (${Math.min(...prices)}–${Math.max(...prices)}).`, hint: null });
      }
    }

    // A conflict recorded by the merger means two sources disagreed.
    for (const [field, prov] of Object.entries(product.provenance)) {
      if (!prov.conflict) continue;
      const severity: Severity = /price|sku|inventory/i.test(field) ? 'WARNING' : 'INFO';
      report({ ruleId: 'price-consistency', severity, variantId: variantIdFromKey(field), field,
        observed: `${String(prov.conflict.otherValue)} (${prov.conflict.otherSource})`,
        message: `Two sources on the page disagreed about ${friendlyField(field)}; the value from ${prov.source} was kept.`,
        hint: 'Open Advanced view to compare both readings.' });
    }
  }
};

const skuRules: ValidationRule = {
  id: 'sku',
  label: 'SKU',
  scope: 'product',
  run({ product, report }) {
    if (product.kind !== 'variable' && !product.sku && product.variants.every((v) => !v.sku)) {
      report({ ruleId: 'sku', severity: 'INFO', variantId: null, field: 'sku', observed: null,
        message: 'No SKU was published for this product.', hint: 'The importing store will generate one, or you can add it after import.' });
    }
    for (const v of product.variants) {
      if (v.sku && /^\s|\s$|[\t\n]/.test(v.sku)) {
        report({ ruleId: 'sku', severity: 'WARNING', variantId: v.id, field: 'sku', observed: JSON.stringify(v.sku),
          message: `The SKU for "${describeVariant(v.options)}" has leading or trailing whitespace.`, hint: null });
      }
    }
  }
};

const htmlRules: ValidationRule = {
  id: 'description-html',
  label: 'Description HTML',
  scope: 'product',
  run({ product, report }) {
    const problem = looksMalformed(product.descriptionHtml);
    if (problem) {
      report({ ruleId: 'description-html', severity: 'WARNING', variantId: null, field: 'descriptionHtml', observed: null,
        message: problem, hint: 'Review the description before importing; the store may render it oddly.' });
    }
    if (product.descriptionHtml && product.descriptionHtml.length > 60000) {
      report({ ruleId: 'description-html', severity: 'INFO', variantId: null, field: 'descriptionHtml', observed: `${product.descriptionHtml.length} characters`,
        message: 'The description is very long and may be truncated by the target store.', hint: null });
    }
  }
};

const urlRules: ValidationRule = {
  id: 'urls',
  label: 'URLs',
  scope: 'product',
  run({ product, report }) {
    for (const img of product.images) {
      try {
        const u = new URL(img.url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
      } catch {
        report({ ruleId: 'urls', severity: 'ERROR', variantId: null, field: `images[${img.position}].url`, observed: img.url,
          message: `Image ${img.position} has an address the store will not accept.`, hint: null });
      }
    }
    const identities = product.images.map((i) => i.url.split('?')[0]);
    const dupes = identities.filter((v, i) => identities.indexOf(v) !== i);
    if (dupes.length) {
      report({ ruleId: 'urls', severity: 'INFO', variantId: null, field: 'images', observed: dupes[0],
        message: 'The gallery contains the same image more than once.', hint: null });
    }
  }
};

const googleRules: ValidationRule = {
  id: 'google-shopping',
  label: 'Google Shopping',
  scope: 'product',
  run({ product, report }) {
    const g = product.google;
    const missing: string[] = [];
    if (!g.gtin) missing.push('GTIN');
    if (!g.mpn) missing.push('MPN');
    if (!g.brand) missing.push('brand');
    if (!g.googleProductCategory) missing.push('Google product category');
    if (missing.length) {
      report({ ruleId: 'google-shopping', severity: 'INFO', variantId: null, field: 'google', observed: missing.join(', '),
        message: `The source page did not publish: ${missing.join(', ')}. These fields are left empty rather than guessed.`,
        hint: 'Merchant Center identifiers cannot be derived from a product page; add them in the destination store if you need them.' });
    }
  }
};

const seoRules: ValidationRule = {
  id: 'seo',
  label: 'SEO',
  scope: 'product',
  run({ product, report }) {
    if (!product.seo.title && !product.title) {
      report({ ruleId: 'seo', severity: 'INFO', variantId: null, field: 'seo.title', observed: null,
        message: 'No SEO title was found.', hint: null });
    }
    if (product.seo.metaDescription && product.seo.metaDescription.length > 320) {
      report({ ruleId: 'seo', severity: 'INFO', variantId: null, field: 'seo.metaDescription', observed: `${product.seo.metaDescription.length} characters`,
        message: 'The meta description is longer than search engines usually display.', hint: null });
    }
    if (product.seo.robots && /noindex/i.test(product.seo.robots)) {
      report({ ruleId: 'seo', severity: 'INFO', variantId: null, field: 'seo.robots', observed: product.seo.robots,
        message: 'The source page asks search engines not to index it.', hint: null });
    }
  }
};

const extractionQuality: ValidationRule = {
  id: 'extraction-quality',
  label: 'Extraction quality',
  scope: 'product',
  run({ product, report }) {
    const lowConfidenceFields = Object.entries(product.provenance)
      .filter(([k, v]) => (v.confidence === 'low' || v.source === 'heuristic') && /^(price|sku|title|stockStatus)$/.test(k))
      .map(([k]) => k);
    if (lowConfidenceFields.length) {
      report({ ruleId: 'extraction-quality', severity: 'WARNING', variantId: null, field: lowConfidenceFields.join(', '), observed: null,
        message: `These values were inferred rather than read from structured data: ${lowConfidenceFields.join(', ')}.`,
        hint: 'Check them against the source page before importing.' });
    }
    if (product.sourcePlatform === 'unknown') {
      report({ ruleId: 'extraction-quality', severity: 'INFO', variantId: null, field: 'sourcePlatform', observed: null,
        message: 'The store platform could not be identified, so only generic extraction was possible.', hint: null });
    }
    for (const note of product.extractionNotes) {
      report({ ruleId: 'extraction-quality', severity: 'INFO', variantId: null, field: null, observed: null, message: note, hint: null });
    }
  }
};

/* ------------------------------------------------------------------ */
/* Cross-product rules                                                 */
/* ------------------------------------------------------------------ */

const duplicates: ValidationRule = {
  id: 'duplicates',
  label: 'Duplicates',
  scope: 'project',
  run({ all, report, targetFormat }) {
    const byUrl = new Map<string, CanonicalProduct[]>();
    const byHandle = new Map<string, CanonicalProduct[]>();
    const bySku = new Map<string, Array<{ p: CanonicalProduct; variantId: string | null }>>();

    for (const p of all) {
      push(byUrl, p.sourceUrl.replace(/[?#].*$/, '').toLowerCase(), p);
      const handle = (p.handle ?? slugify(p.title ?? '')).toLowerCase();
      if (handle) push(byHandle, handle, p);
      if (p.sku) pushSku(bySku, p.sku, p, null);
      for (const v of p.variants) if (v.sku) pushSku(bySku, v.sku, p, v.id);
    }

    for (const [url, list] of byUrl) {
      if (list.length < 2) continue;
      for (const p of list.slice(1)) {
        report({ productId: p.id, ruleId: 'duplicates', severity: 'ERROR', variantId: null, field: 'sourceUrl', observed: url,
          message: 'Another product in this project was scraped from the same address.', hint: 'Remove the duplicate URL so the product is not imported twice.' });
      }
    }

    for (const [handle, list] of byHandle) {
      if (list.length < 2) continue;
      for (const p of list.slice(1)) {
        report({ productId: p.id, ruleId: 'duplicates', severity: targetFormat === 'shopify' ? 'ERROR' : 'WARNING', variantId: null, field: 'handle', observed: handle,
          message: `Another product uses the handle "${handle}".`,
          hint: targetFormat === 'shopify' ? 'Shopify merges rows that share a handle — these two products would become one.' : 'Two products would share a slug in WooCommerce.' });
      }
    }

    for (const [sku, list] of bySku) {
      if (list.length < 2) continue;
      const distinctProducts = new Set(list.map((l) => l.p.id));
      if (distinctProducts.size < 2) continue;
      for (const entry of list.slice(1)) {
        report({ productId: entry.p.id, ruleId: 'duplicates', severity: 'ERROR', variantId: entry.variantId, field: 'sku', observed: sku,
          message: `SKU "${sku}" is also used by a different product in this project.`, hint: 'SKUs must be unique across the store.' });
      }
    }
  }
};

const orphanVariants: ValidationRule = {
  id: 'orphan-variants',
  label: 'Orphan variants',
  scope: 'project',
  run({ all, report }) {
    const ids = new Set(all.map((p) => p.id));
    for (const p of all) {
      for (const v of p.variants) {
        if (!ids.has(v.parentProductId)) {
          report({ productId: p.id, ruleId: 'orphan-variants', severity: 'CRITICAL', variantId: v.id, field: 'parentProductId', observed: v.parentProductId,
            message: `Variant "${describeVariant(v.options)}" refers to a parent product that does not exist.`, hint: 'Re-scrape this product before exporting.' });
        }
      }
    }
  }
};

/**
 * What the destination format itself cannot represent. These are limits of
 * Shopify and WooCommerce, not of the source page, and the operator has to know
 * before the file is written rather than after the import.
 */
const destinationLimits: ValidationRule = {
  id: 'destination-limits',
  label: 'Destination limits',
  scope: 'product',
  run({ product, targetFormat, report }) {
    if (targetFormat === 'shopify') {
      const axes = optionAxisNames(product);
      if (axes.length > SHOPIFY_MAX_OPTIONS) {
        const dropped = axes.slice(SHOPIFY_MAX_OPTIONS);
        report({ ruleId: 'destination-limits', severity: 'ERROR', variantId: null, field: 'options', observed: axes.join(', '),
          message: `This product has ${axes.length} option axes and Shopify allows ${SHOPIFY_MAX_OPTIONS}, so ${dropped.join(' and ')} cannot be exported.`,
          hint: 'Combine two axes into one on the source, or export this product to WooCommerce, which has no such limit.' });
      }
    }

    // A measurement without a unit cannot be converted, so it is written as the
    // bare number the source gave and may be read as the store's own unit.
    const weights: Array<{ value: number | null; unit: string | null; what: string }> = [
      { value: product.weight, unit: product.weightUnit, what: 'This product' },
      ...product.variants.map((v) => ({ value: v.weight, unit: v.weightUnit, what: `Variant "${describeVariant(v.options)}"` }))
    ];
    for (const w of weights) {
      if (w.value !== null && !normaliseWeightUnit(w.unit)) {
        report({ ruleId: 'destination-limits', severity: 'WARNING', variantId: null, field: 'weightUnit', observed: w.unit,
          message: `${w.what} has a weight of ${w.value} but the source did not say in what unit.`,
          hint: 'It is exported as that bare number. Check it against the source page before importing, because the store will read it as its own weight unit.' });
        break;
      }
    }
    const hasDimension = product.length !== null || product.width !== null || product.height !== null;
    if (hasDimension && !normaliseDimensionUnit(product.dimensionUnit)) {
      report({ ruleId: 'destination-limits', severity: 'WARNING', variantId: null, field: 'dimensionUnit', observed: product.dimensionUnit,
        message: 'Dimensions were found but the source did not say whether they are centimetres, inches or something else.',
        hint: 'They are exported as the bare numbers. Check them against the source page before importing.' });
    }
  }
};

function optionAxisNames(p: CanonicalProduct): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const o of p.options) {
    const key = o.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(o.name);
  }
  for (const v of p.variants) {
    for (const o of v.options) {
      const key = o.name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      names.push(o.name);
    }
  }
  return names;
}

export const RULES: ValidationRule[] = [
  requiredFields,
  productType,
  destinationLimits,
  variantIntegrity,
  variantImages,
  priceConsistency,
  skuRules,
  htmlRules,
  urlRules,
  googleRules,
  seoRules,
  extractionQuality,
  duplicates,
  orphanVariants
];

/* ------------------------------------------------------------------ */

export function validateProducts(
  projectId: string,
  products: CanonicalProduct[],
  targetFormat: TargetFormat
): { issues: ValidationIssue[]; summary: ValidationRunSummary } {
  const issues: ValidationIssue[] = [];

  const makeReport = (defaultProductId: string | null) =>
    (partial: Parameters<RuleContext['report']>[0]): void => {
      issues.push({
        id: newId('iss_'),
        projectId,
        productId: partial.productId !== undefined ? partial.productId : defaultProductId,
        variantId: partial.variantId ?? null,
        ruleId: partial.ruleId,
        severity: partial.severity,
        message: partial.message,
        hint: partial.hint ?? null,
        field: partial.field ?? null,
        observed: partial.observed ?? null,
        createdAt: nowIso(),
        acknowledged: false
      });
    };

  for (const rule of RULES) {
    if (rule.scope === 'product') {
      for (const product of products) {
        try {
          rule.run({ product, all: products, targetFormat, report: makeReport(product.id) });
        } catch (err) {
          issues.push({
            id: newId('iss_'), projectId, productId: product.id, variantId: null, ruleId: rule.id,
            severity: 'INFO', message: `The "${rule.label}" check could not run for this product.`,
            hint: null, field: null, observed: err instanceof Error ? err.message : String(err),
            createdAt: nowIso(), acknowledged: false
          });
        }
      }
    } else {
      try {
        rule.run({ product: products[0] ?? ({} as CanonicalProduct), all: products, targetFormat, report: makeReport(null) });
      } catch {
        /* a failing cross-check must not abort the run */
      }
    }
  }

  const bySeverity: Record<Severity, number> = { INFO: 0, WARNING: 0, ERROR: 0, CRITICAL: 0 };
  for (const i of issues) bySeverity[i.severity]++;

  return {
    issues,
    summary: {
      projectId,
      ranAt: nowIso(),
      productCount: products.length,
      issueCount: issues.length,
      bySeverity,
      blockingExport: bySeverity.ERROR + bySeverity.CRITICAL
    }
  };
}

/* ------------------------------------------------------------------ */

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function pushSku(
  map: Map<string, Array<{ p: CanonicalProduct; variantId: string | null }>>,
  sku: string,
  p: CanonicalProduct,
  variantId: string | null
): void {
  push(map, sku.trim().toLowerCase(), { p, variantId });
}

export function describeVariant(options: Array<{ name: string; value: string }>): string {
  if (!options.length) return 'default';
  return options.map((o) => o.value).join(' / ');
}

function variantIdFromKey(key: string): string | null {
  const m = key.match(/^variants\[([^\]]+)\]/);
  return m ? m[1] : null;
}

function friendlyField(key: string): string {
  const bare = key.replace(/^variants\[[^\]]+\]\./, '');
  return bare
    .replace(/([A-Z])/g, ' $1')
    .replace(/\./g, ' ')
    .toLowerCase()
    .trim();
}

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 255);
}
