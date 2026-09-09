/**
 * Layer 4 — Shopify.
 *
 * Preference order, strongest first:
 *   1. /products/<handle>.js       — the storefront product JSON (prices in cents)
 *   2. /products/<handle>.json     — the same product as decimal strings
 *   3. an inline product JSON blob printed by the theme
 *   4. ShopifyAnalytics.meta       — id/type/vendor only, no variant depth
 *
 * Every variant carries its OWN price, compare-at price, SKU, barcode,
 * inventory, weight and image. Nothing is inherited from the parent.
 */
import type { ExtractionContext, ExtractionLayer, LayerResult } from '../context';
import { cleanText, currencyFrom, parseMoney, parseNumber } from '../merge';
import { sanitiseDescription } from '../html';
import { absoluteUrl, shopifyHandleFromUrl, upscaleShopifyImage } from '../../util/url';
import { emptyVariant, type CanonicalVariant } from '../../../shared/canonical';
import { addImage, mergeVariants } from '../productutil';
import { newId } from '../../db/store';
import { log } from '../../util/logger';

interface ShopifyVariantJson {
  id?: number | string;
  title?: string;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  options?: string[];
  sku?: string | null;
  barcode?: string | null;
  requires_shipping?: boolean;
  taxable?: boolean;
  available?: boolean;
  price?: number | string;
  compare_at_price?: number | string | null;
  weight?: number;
  weight_unit?: string;
  grams?: number;
  inventory_management?: string | null;
  inventory_policy?: string | null;
  inventory_quantity?: number;
  featured_image?: { src?: string; alt?: string | null; width?: number; height?: number; position?: number } | null;
  image_id?: number | string | null;
  public_title?: string | null;
  name?: string | null;
}

interface ShopifyProductJson {
  id?: number | string;
  title?: string;
  handle?: string;
  description?: string;
  body_html?: string;
  published_at?: string | null;
  vendor?: string;
  type?: string;
  product_type?: string;
  tags?: string[] | string;
  price?: number | string;
  price_min?: number | string;
  price_max?: number | string;
  compare_at_price?: number | string | null;
  compare_at_price_min?: number | string;
  compare_at_price_max?: number | string;
  available?: boolean;
  variants?: ShopifyVariantJson[];
  images?: Array<string | { src: string; alt?: string | null; position?: number; width?: number; height?: number; id?: number | string }>;
  image?: { src?: string; alt?: string | null } | null;
  featured_image?: string | { src?: string; alt?: string | null } | null;
  options?: Array<string | { name: string; position?: number; values?: string[] }>;
  media?: Array<{ src?: string; preview_image?: { src?: string; width?: number; height?: number }; alt?: string | null; position?: number; media_type?: string }>;
  status?: string;
  url?: string;
}

function isCentsFormat(p: ShopifyProductJson): boolean {
  // /products/x.js reports integer cents. /products/x.json reports "19.99".
  const sample = p.price ?? p.price_min ?? p.variants?.[0]?.price;
  if (typeof sample === 'number') return Number.isInteger(sample);
  if (typeof sample === 'string') return !sample.includes('.');
  return false;
}

function money(v: unknown, cents: boolean): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (cents) {
    const n = parseNumber(v);
    return n === null ? null : Math.round(n) / 100;
  }
  return parseMoney(v);
}

export const shopifyLayer: ExtractionLayer = {
  id: 'shopify',
  label: 'Shopify product JSON',

  applies(ctx) {
    return ctx.detection.platform === 'shopify' || /\/products\//.test(ctx.finalUrl);
  },

  async run(ctx): Promise<LayerResult> {
    const handle = shopifyHandleFromUrl(ctx.finalUrl) ?? shopifyHandleFromUrl(ctx.url);
    let json: ShopifyProductJson | null = null;
    let sourceNote = '';

    if (handle) {
      const origin = new URL(ctx.finalUrl).origin;
      const pathPrefix = localePrefix(ctx.finalUrl);
      for (const suffix of ['.js', '.json']) {
        const endpoint = `${origin}${pathPrefix}/products/${encodeURIComponent(handle)}${suffix}`;
        try {
          const res = await ctx.fetcher.get(endpoint, {
            timeoutMs: ctx.settings.requestTimeoutMs,
            userAgent: ctx.settings.userAgent,
            accept: 'application/json',
            referer: ctx.finalUrl,
            fastLane: false
          });
          if (res.status === 200 && res.body.trim().startsWith('{')) {
            const parsed = JSON.parse(res.body) as ShopifyProductJson & { product?: ShopifyProductJson };
            json = parsed.product ?? parsed;
            sourceNote = endpoint;
            break;
          }
        } catch (err) {
          log.debug('shopify', `Product endpoint ${endpoint} unavailable`, String(err));
        }
      }
    }

    if (!json) {
      json = findInlineProductJson(ctx);
      if (json) sourceNote = 'inline theme product JSON';
    }

    if (!json || !json.title) {
      const meta = ctx.harvest?.shopifyMeta as { product?: { id?: number; type?: string; vendor?: string; variants?: unknown[] } } | null;
      if (meta?.product) {
        ctx.merger.set('sourceProductId', String(meta.product.id ?? ''), 'embedded-json', 'ShopifyAnalytics.meta');
        ctx.merger.set('vendor', cleanText(meta.product.vendor), 'embedded-json', 'ShopifyAnalytics.meta');
        ctx.merger.set('sourceProductType', cleanText(meta.product.type), 'embedded-json', 'ShopifyAnalytics.meta');
        ctx.merger.set('sourcePlatform', 'shopify', 'embedded-json');
        return { produced: 3, note: 'Only ShopifyAnalytics metadata was available; variant detail is missing.' };
      }
      return { produced: 0, note: 'No Shopify product JSON was reachable for this page.' };
    }

    if (ctx.settings.keepDebugSnippets) ctx.snippets['shopify.product'] = JSON.stringify(json).slice(0, 60000);

    const m = ctx.merger;
    const cents = isCentsFormat(json);
    const src = 'shopify-product-json' as const;
    let produced = 0;

    m.set('sourcePlatform', 'shopify', src, sourceNote);
    m.set('sourceProductId', json.id !== undefined ? String(json.id) : null, src);
    m.set('handle', cleanText(json.handle) ?? handle, src);
    m.set('title', cleanText(json.title), src);
    m.set('vendor', cleanText(json.vendor), src);
    m.set('sourceProductType', cleanText(json.product_type ?? json.type), src);
    produced += 5;

    const tags = Array.isArray(json.tags) ? json.tags : typeof json.tags === 'string' ? json.tags.split(',') : [];
    m.addToStringArray('tags', tags.map(String), src);

    const bodyHtml = json.body_html ?? json.description ?? null;
    if (bodyHtml) {
      const s = sanitiseDescription(bodyHtml, ctx.finalUrl);
      m.set('descriptionHtml', s.html, src, 'body_html');
      m.set('descriptionText', s.text, src, 'body_html');
      produced++;
    }

    const published = json.published_at !== undefined ? json.published_at !== null : json.status ? json.status === 'active' : null;
    m.set('published', published, src, 'published_at');
    if (json.status) m.set('status', json.status === 'active' ? 'active' : json.status === 'draft' ? 'draft' : 'archived', src);
    else if (published !== null) m.set('status', published ? 'active' : 'draft', src, 'derived from published_at');

    const currency = currencyFrom(ctx.harvest?.currency) ?? currencyFrom(ctx.$('meta[property="og:price:currency"]').attr('content')) ?? null;
    m.set('currency', currency, currency ? 'embedded-json' : 'unavailable', 'Shopify.currency.active');

    m.set('price', money(json.price, cents), src);
    m.set('priceMin', money(json.price_min, cents), src);
    m.set('priceMax', money(json.price_max, cents), src);
    m.set('compareAtPrice', money(json.compare_at_price ?? null, cents), src);
    produced += 2;

    /* ---------------- options ---------------- */
    const optionDefs = (json.options ?? []).map((o, i) =>
      typeof o === 'string'
        ? { name: o, values: [] as string[], position: i + 1 }
        : { name: o.name, values: o.values ?? [], position: o.position ?? i + 1 }
    );
    if (optionDefs.length) {
      ctx.product.options = optionDefs;
      ctx.product.provenance['options'] = { source: src, confidence: 'high' };
      produced++;
    }

    /* ---------------- images ---------------- */
    const imageById = new Map<string, string>();
    const imgs = json.images ?? [];
    imgs.forEach((im, i) => {
      const url = typeof im === 'string' ? im : im.src;
      const abs = absoluteUrl(url, ctx.finalUrl);
      if (!abs) return;
      const full = upscaleShopifyImage(abs);
      const alt = typeof im === 'string' ? null : cleanText(im.alt);
      const position = typeof im === 'string' ? i + 1 : im.position ?? i + 1;
      if (typeof im !== 'string' && im.id !== undefined) imageById.set(String(im.id), full);
      addImage(ctx, full, src, {
        alt,
        position,
        width: typeof im === 'string' ? null : im.width ?? null,
        height: typeof im === 'string' ? null : im.height ?? null,
        isFeatured: i === 0 && !!featuredUrl(json)
      });
    });

    const feat = featuredUrl(json);
    if (feat) {
      const absFeat = upscaleShopifyImage(absoluteUrl(feat, ctx.finalUrl) ?? feat);
      addImage(ctx, absFeat, src, { isFeatured: true, position: 1 });
      ctx.product.featuredImageUrl = absFeat;
      ctx.product.provenance['featuredImageUrl'] = { source: src, confidence: 'high', note: 'featured_image' };
      produced++;
    }

    // media[] carries entries images[] may omit (video posters, 3D previews).
    for (const md of json.media ?? []) {
      if (md.media_type && md.media_type !== 'image') continue;
      const u = md.src ?? md.preview_image?.src;
      const abs = absoluteUrl(u, ctx.finalUrl);
      if (abs) addImage(ctx, upscaleShopifyImage(abs), src, { alt: cleanText(md.alt), position: md.position });
    }

    /* ---------------- variants ---------------- */
    const variants: CanonicalVariant[] = [];
    const optionNames = optionDefs.map((o) => o.name);
    (json.variants ?? []).forEach((sv, idx) => {
      const v = emptyVariant(newId('var_'), ctx.product.id, idx + 1);
      v.sourceVariantId = sv.id !== undefined ? String(sv.id) : null;
      v.title = cleanText(sv.public_title ?? sv.title);
      v.sku = cleanText(sv.sku);
      v.barcode = cleanText(sv.barcode);

      const values = sv.options ?? [sv.option1, sv.option2, sv.option3].filter((x): x is string => !!x);
      v.options = values
        .map((value, i) => ({ name: optionNames[i] ?? `Option ${i + 1}`, value: String(value) }))
        .filter((o) => o.value !== '' && o.value.toLowerCase() !== 'default title');

      v.price = money(sv.price, cents);
      v.compareAtPrice = money(sv.compare_at_price ?? null, cents);
      v.regularPrice = v.compareAtPrice ?? v.price;
      v.salePrice = v.compareAtPrice !== null && v.price !== null && v.price < v.compareAtPrice ? v.price : null;
      v.currency = currency;

      v.available = sv.available ?? null;
      v.stockStatus = sv.available === undefined ? 'unknown' : sv.available ? 'in_stock' : 'out_of_stock';
      v.inventoryQuantity = sv.inventory_quantity ?? null;
      v.inventoryTracker = sv.inventory_management ?? null;
      v.inventoryPolicy = sv.inventory_policy === 'continue' ? 'continue' : sv.inventory_policy === 'deny' ? 'deny' : null;

      if (typeof sv.grams === 'number') {
        v.weight = sv.grams;
        v.weightUnit = 'g';
      } else if (typeof sv.weight === 'number') {
        v.weight = sv.weight;
        v.weightUnit = sv.weight_unit ?? 'g';
      }

      v.requiresShipping = sv.requires_shipping ?? null;
      v.taxable = sv.taxable ?? null;

      const vi = sv.featured_image?.src ?? (sv.image_id !== undefined && sv.image_id !== null ? imageById.get(String(sv.image_id)) : undefined);
      const absVi = absoluteUrl(vi, ctx.finalUrl);
      if (absVi) {
        v.imageUrl = upscaleShopifyImage(absVi);
        addImage(ctx, v.imageUrl, src, { alt: cleanText(sv.featured_image?.alt), variantIds: [v.id] });
      }
      variants.push(v);
    });

    if (variants.length) {
      mergeVariants(ctx, variants, src);
      produced++;
      const meaningful = variants.filter((v) => v.options.length > 0);
      m.set('kind', meaningful.length > 0 || variants.length > 1 ? 'variable' : 'simple', src, `${variants.length} variants`);
      if (variants.length === 1) {
        // A single default variant: its values are the product's values.
        const only = variants[0];
        m.set('sku', only.sku, src, 'single variant');
        m.set('barcode', only.barcode, src, 'single variant');
        m.set('price', only.price, src, 'single variant');
        m.set('compareAtPrice', only.compareAtPrice, src, 'single variant');
        m.set('weight', only.weight, src, 'single variant');
        m.set('weightUnit', only.weightUnit, src, 'single variant');
        m.set('inventoryQuantity', only.inventoryQuantity, src, 'single variant');
        m.set('inventoryPolicy', only.inventoryPolicy, src, 'single variant');
        m.set('requiresShipping', only.requiresShipping, src, 'single variant');
        m.set('taxable', only.taxable, src, 'single variant');
        m.set('stockStatus', only.stockStatus, src, 'single variant');
      } else {
        const anyIn = variants.some((v) => v.stockStatus === 'in_stock');
        m.set('stockStatus', anyIn ? 'in_stock' : variants.every((v) => v.stockStatus === 'out_of_stock') ? 'out_of_stock' : 'unknown', src, 'aggregated from variants');
      }
    }

    // Shopify exposes no Merchant Center fields on the storefront; record that
    // explicitly rather than leaving the operator guessing.
    m.markUnavailable(['google.gtin', 'google.mpn', 'google.googleProductCategory', 'google.customLabel0']);

    return { produced, note: sourceNote, variantsAuthoritative: variants.length > 0 };
  }
};

function featuredUrl(json: ShopifyProductJson): string | null {
  const f = json.featured_image ?? json.image;
  if (!f) return null;
  return typeof f === 'string' ? f : f.src ?? null;
}

/** Handles /en-gb/products/... and similar market prefixes. */
function localePrefix(url: string): string {
  try {
    const p = new URL(url).pathname;
    const idx = p.indexOf('/products/');
    return idx > 0 ? p.slice(0, idx) : '';
  } catch {
    return '';
  }
}

function findInlineProductJson(ctx: ExtractionContext): ShopifyProductJson | null {
  const candidates: unknown[] = [...(ctx.harvest?.inlineProductJson ?? [])];
  ctx.$('script[type="application/json"]').each((_, el) => {
    const id = `${ctx.$(el).attr('id') ?? ''} ${ctx.$(el).attr('class') ?? ''} ${ctx.$(el).attr('data-product-json') ?? ''}`;
    const raw = ctx.$(el).html() ?? '';
    if (!raw.trim()) return;
    if (!/product/i.test(id) && !/"variants"\s*:/.test(raw.slice(0, 4000))) return;
    try {
      candidates.push(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  });

  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const p = (o.product ?? o) as ShopifyProductJson;
    if (p && typeof p === 'object' && Array.isArray(p.variants) && (p.title || p.handle)) return p;
  }
  return null;
}
