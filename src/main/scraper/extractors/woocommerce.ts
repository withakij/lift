/**
 * Layer 4 — WooCommerce / WordPress.
 *
 * WooCommerce stores are far less uniform than Shopify, so this layer tries
 * several independent sources and takes the strongest one that answers:
 *
 *   A. WooCommerce Store API  (/wp-json/wc/store/v1/products?slug=...)
 *      Public, read-only, no credentials. Gives prices in minor units,
 *      attributes, images, and the ids of every variation, each of which can
 *      then be read as its own product record — the most reliable variant
 *      source available without authentication.
 *   B. data-product_variations on form.variations_form
 *      The payload the theme itself uses to switch variants. Contains per
 *      variation: price, regular price, sku, image, weight, dimensions, stock.
 *   C. WordPress REST (/wp-json/wp/v2/product?slug=...) for description/SEO.
 *   D. The rendered page: gallery, attribute tables, sku, price, stock.
 *
 * Nothing here requires a login, and no attempt is made to read anything the
 * store does not publish to ordinary visitors.
 */
import type { CheerioAPI, Element } from '../../dom';
import type { ExtractionContext, ExtractionLayer, LayerResult } from '../context';
import { cleanText, currencyFrom, decodeEntities, parseBool, parseMoney, parseNumber } from '../merge';
import { sanitiseDescription } from '../html';
import { absoluteUrl, upscaleWordpressImage } from '../../util/url';
import {
  emptyVariant,
  normaliseWeightUnit,
  type CanonicalAttribute,
  type CanonicalVariant,
  type StockStatus
} from '../../../shared/canonical';
import { addImage, mergeVariants } from '../productutil';
import { newId } from '../../db/store';
import { log } from '../../util/logger';

/* ------------------------------------------------------------------ */
/* Store API shapes (only the parts we consume)                        */
/* ------------------------------------------------------------------ */

interface StorePrices {
  price?: string;
  regular_price?: string;
  sale_price?: string;
  price_range?: { min_amount?: string; max_amount?: string } | null;
  currency_code?: string;
  currency_minor_unit?: number;
}

interface StoreImage {
  id?: number;
  src?: string;
  thumbnail?: string;
  srcset?: string;
  name?: string;
  alt?: string;
}

interface StoreAttribute {
  id?: number;
  name?: string;
  taxonomy?: string | null;
  has_variations?: boolean;
  terms?: Array<{ id?: number; name?: string; slug?: string }>;
}

interface StoreProduct {
  id?: number;
  name?: string;
  slug?: string;
  parent?: number;
  type?: string;
  variation?: string;
  permalink?: string;
  sku?: string;
  short_description?: string;
  description?: string;
  on_sale?: boolean;
  prices?: StorePrices;
  average_rating?: string;
  review_count?: number;
  images?: StoreImage[];
  categories?: Array<{ id?: number; name?: string; slug?: string }>;
  tags?: Array<{ id?: number; name?: string; slug?: string }>;
  attributes?: StoreAttribute[];
  variations?: Array<{ id?: number; attributes?: Array<{ name?: string; value?: string }> }>;
  has_options?: boolean;
  is_purchasable?: boolean;
  is_in_stock?: boolean;
  is_on_backorder?: boolean;
  low_stock_remaining?: number | null;
  sold_individually?: boolean;
  weight?: string;
  dimensions?: { length?: string; width?: string; height?: string };
}

function storeMoney(raw: string | undefined, minorUnit: number | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return parseMoney(raw);
  const unit = typeof minorUnit === 'number' ? minorUnit : 2;
  return Math.round((n / 10 ** unit) * 1e6) / 1e6;
}

/* ------------------------------------------------------------------ */
/* data-product_variations shape                                       */
/* ------------------------------------------------------------------ */

interface WooVariationJson {
  variation_id?: number;
  attributes?: Record<string, string>;
  display_price?: number | string;
  display_regular_price?: number | string;
  price_html?: string;
  sku?: string;
  is_in_stock?: boolean;
  is_purchasable?: boolean;
  backorders_allowed?: boolean;
  max_qty?: number | string;
  min_qty?: number | string;
  weight?: string | number;
  weight_html?: string;
  dimensions?: { length?: string | number; width?: string | number; height?: string | number };
  dimensions_html?: string;
  availability_html?: string;
  variation_description?: string;
  image?: {
    src?: string;
    full_src?: string;
    thumb_src?: string;
    src_w?: number;
    src_h?: number;
    full_src_w?: number;
    full_src_h?: number;
    alt?: string;
    title?: string;
    caption?: string;
  };
}

/* ------------------------------------------------------------------ */

export const wooLayer: ExtractionLayer = {
  id: 'woocommerce',
  label: 'WooCommerce product data',

  applies(ctx) {
    return ctx.detection.platform === 'woocommerce' || ctx.detection.platform === 'wordpress-generic';
  },

  async run(ctx): Promise<LayerResult> {
    const m = ctx.merger;
    let produced = 0;
    const notes: string[] = [];

    const origin = new URL(ctx.finalUrl).origin;
    const slug = slugFromUrl(ctx.finalUrl);
    const productId = findProductId(ctx);

    m.set('sourcePlatform', ctx.detection.platform === 'woocommerce' ? 'woocommerce' : 'wordpress-generic', 'html', ctx.detection.signals.join(','));
    // The WordPress post id comes from the platform's own markup (the cart form
    // or the body class), so it is stronger evidence than page text.
    if (productId) m.set('sourceProductId', String(productId), 'embedded-json', 'WordPress post id');
    if (slug) m.set('handle', slug, 'html', 'URL slug');

    /* ---------- A. Store API ---------- */
    let store: StoreProduct | null = null;
    const apiBase = await findStoreApiBase(ctx, origin);
    if (apiBase) {
      store = await fetchStoreProduct(ctx, apiBase, productId, slug);
      if (store) notes.push('Store API');
    }

    if (store) {
      produced += await applyStoreProduct(ctx, store, apiBase!);
    }

    /* ---------- B. variations form payload ---------- */
    const formVariations = readFormVariations(ctx);
    if (formVariations && formVariations.length) {
      produced += applyFormVariations(ctx, formVariations);
      notes.push('variations form');
    }

    /* ---------- C. WordPress REST for description ---------- */
    if (!ctx.product.descriptionHtml) {
      const wp = await fetchWpPost(ctx, origin, slug);
      if (wp) {
        const s = sanitiseDescription(wp.contentHtml, ctx.finalUrl);
        m.set('descriptionHtml', s.html, 'platform-api', 'wp/v2 content');
        m.set('descriptionText', s.text, 'platform-api', 'wp/v2 content');
        if (wp.excerptHtml) {
          const e = sanitiseDescription(wp.excerptHtml, ctx.finalUrl);
          m.set('shortDescriptionHtml', e.html, 'platform-api', 'wp/v2 excerpt');
          m.set('shortDescriptionText', e.text, 'platform-api', 'wp/v2 excerpt');
        }
        m.set('title', cleanText(wp.title), 'platform-api', 'wp/v2 title');
        notes.push('wp/v2');
        produced += 2;
      }
    }

    /* ---------- D. rendered page ---------- */
    produced += applyRenderedPage(ctx);

    /* ---------- product kind ---------- */
    if (ctx.product.variants.length > 1) {
      m.set('kind', 'variable', 'woo-variation-form', `${ctx.product.variants.length} variations`);
    } else if (store?.type) {
      const map: Record<string, 'simple' | 'variable' | 'grouped' | 'external'> = {
        simple: 'simple',
        variable: 'variable',
        grouped: 'grouped',
        external: 'external'
      };
      const k = map[store.type];
      if (k) m.set('kind', k, 'platform-api', 'Store API type');
    } else if (ctx.$('form.variations_form').length) {
      m.set('kind', 'variable', 'html', 'variations form present');
    } else if (ctx.$('form.cart').length) {
      m.set('kind', 'simple', 'html', 'simple add-to-cart form');
    }

    // WooCommerce publishes Merchant Center fields only when a feed plugin is
    // installed; if nothing was found we say so instead of inventing values.
    m.markUnavailable(['google.gtin', 'google.mpn', 'google.googleProductCategory']);

    return {
      produced,
      note: notes.join(' + ') || undefined,
      variantsAuthoritative: ctx.product.variants.length > 0 && !!(store || formVariations?.length)
    };
  }
};

/* ------------------------------------------------------------------ */
/* Store API                                                           */
/* ------------------------------------------------------------------ */

async function findStoreApiBase(ctx: ExtractionContext, origin: string): Promise<string | null> {
  const candidates = [`${origin}/wp-json/wc/store/v1`, `${origin}/?rest_route=/wc/store/v1`];
  const linked = ctx.$('link[rel="https://api.w.org/"]').attr('href');
  if (linked) {
    const base = linked.replace(/\/wp\/v2\/?$/, '').replace(/\/$/, '');
    candidates.unshift(`${base}/wc/store/v1`);
  }
  for (const base of candidates) {
    try {
      const url = base.includes('?rest_route=') ? `${base}/products?per_page=1` : `${base}/products?per_page=1`;
      const res = await ctx.fetcher.get(url, {
        timeoutMs: Math.min(ctx.settings.requestTimeoutMs, 15000),
        userAgent: ctx.settings.userAgent,
        accept: 'application/json',
        referer: ctx.finalUrl
      });
      if (res.status === 200 && res.body.trim().startsWith('[')) return base;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function fetchStoreProduct(
  ctx: ExtractionContext,
  base: string,
  id: number | null,
  slug: string | null
): Promise<StoreProduct | null> {
  const attempts: string[] = [];
  if (id) attempts.push(`${base}/products/${id}`);
  if (slug) attempts.push(`${base}/products?slug=${encodeURIComponent(slug)}`);
  for (const url of attempts) {
    try {
      const res = await ctx.fetcher.get(url, {
        timeoutMs: ctx.settings.requestTimeoutMs,
        userAgent: ctx.settings.userAgent,
        accept: 'application/json',
        referer: ctx.finalUrl
      });
      if (res.status !== 200) continue;
      const parsed = JSON.parse(res.body) as StoreProduct | StoreProduct[];
      const p = Array.isArray(parsed) ? parsed[0] : parsed;
      if (p && (p.name || p.id)) return p;
    } catch (err) {
      log.debug('woo', `Store API request failed: ${url}`, String(err));
    }
  }
  return null;
}

async function applyStoreProduct(ctx: ExtractionContext, p: StoreProduct, apiBase: string): Promise<number> {
  const m = ctx.merger;
  const src = 'woo-rest' as const;
  let produced = 0;
  const minor = p.prices?.currency_minor_unit;

  if (ctx.settings.keepDebugSnippets) ctx.snippets['woo.storeApi'] = JSON.stringify(p).slice(0, 40000);

  m.set('sourceProductId', p.id !== undefined ? String(p.id) : null, src);
  m.set('title', cleanText(decodeEntities(p.name ?? '')), src);
  m.set('handle', cleanText(p.slug), src);
  m.set('sku', cleanText(p.sku), src);
  m.set('currency', currencyFrom(p.prices?.currency_code), src);
  produced += 4;

  if (p.description) {
    const s = sanitiseDescription(p.description, ctx.finalUrl);
    m.set('descriptionHtml', s.html, src, 'Store API description');
    m.set('descriptionText', s.text, src);
    produced++;
  }
  if (p.short_description) {
    const s = sanitiseDescription(p.short_description, ctx.finalUrl);
    m.set('shortDescriptionHtml', s.html, src, 'Store API short_description');
    m.set('shortDescriptionText', s.text, src);
    produced++;
  }

  const price = storeMoney(p.prices?.price, minor);
  const regular = storeMoney(p.prices?.regular_price, minor);
  const sale = storeMoney(p.prices?.sale_price, minor);
  m.set('price', price, src);
  m.set('regularPrice', regular, src);
  m.set('salePrice', p.on_sale && sale !== null && regular !== null && sale < regular ? sale : null, src);
  m.set('compareAtPrice', p.on_sale && regular !== null && price !== null && regular > price ? regular : null, src);
  m.set('priceMin', storeMoney(p.prices?.price_range?.min_amount, minor), src);
  m.set('priceMax', storeMoney(p.prices?.price_range?.max_amount, minor), src);
  produced += 2;

  m.set('stockStatus', p.is_on_backorder ? 'on_backorder' : p.is_in_stock === undefined ? 'unknown' : p.is_in_stock ? 'in_stock' : 'out_of_stock', src);
  m.set('inventoryQuantity', p.low_stock_remaining ?? null, src, 'low_stock_remaining');
  m.set('soldIndividually', p.sold_individually ?? null, src);
  m.set('weight', parseNumber(p.weight), src);
  m.set('length', parseNumber(p.dimensions?.length), src);
  m.set('width', parseNumber(p.dimensions?.width), src);
  m.set('height', parseNumber(p.dimensions?.height), src);
  m.set('ratingValue', parseNumber(p.average_rating), src);
  m.set('reviewCount', p.review_count ?? null, src);
  m.set('sourceProductType', cleanText(p.categories?.map((c) => decodeEntities(c.name ?? '')).filter(Boolean).join(' > ')), src, 'Store API categories');
  m.addToStringArray('tags', (p.tags ?? []).map((t) => decodeEntities(t.name ?? '')).filter(Boolean), src);

  (p.images ?? []).forEach((img, i) => {
    const abs = absoluteUrl(img.src, ctx.finalUrl);
    if (!abs) return;
    addImage(ctx, upscaleWordpressImage(abs), src, {
      alt: cleanText(decodeEntities(img.alt ?? '')),
      title: cleanText(decodeEntities(img.name ?? '')),
      position: i + 1,
      isFeatured: i === 0
    });
    if (i === 0) {
      ctx.product.featuredImageUrl = upscaleWordpressImage(abs);
      ctx.product.provenance['featuredImageUrl'] = { source: src, confidence: 'high', note: 'Store API images[0]' };
    }
  });

  /* attributes */
  const attrs: CanonicalAttribute[] = (p.attributes ?? []).map((a, i) => ({
    name: decodeEntities(a.name ?? '').trim(),
    values: (a.terms ?? []).map((t) => decodeEntities(t.name ?? '').trim()).filter(Boolean),
    isGlobal: !!a.taxonomy,
    isVariation: !!a.has_variations,
    visible: true,
    position: i + 1
  })).filter((a) => a.name);
  if (attrs.length) {
    ctx.product.attributes = attrs;
    ctx.product.provenance['attributes'] = { source: src, confidence: 'high' };
    const variationAxes = attrs.filter((a) => a.isVariation);
    if (variationAxes.length && ctx.product.options.length === 0) {
      ctx.product.options = variationAxes.map((a, i) => ({ name: a.name, values: a.values, position: i + 1 }));
      ctx.product.provenance['options'] = { source: src, confidence: 'high' };
    }
    produced++;
  }

  /* variations — one request per variation, rate limited by the fetcher */
  const variationRefs = p.variations ?? [];
  if (variationRefs.length) {
    const cap = 250;
    const refs = variationRefs.slice(0, cap);
    if (variationRefs.length > cap) {
      ctx.warnings.push(`This product has ${variationRefs.length} variations; the first ${cap} were read.`);
    }
    const built: CanonicalVariant[] = [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      if (!ref.id) continue;
      let detail: StoreProduct | null = null;
      try {
        const res = await ctx.fetcher.get(`${apiBase}/products/${ref.id}`, {
          timeoutMs: ctx.settings.requestTimeoutMs,
          userAgent: ctx.settings.userAgent,
          accept: 'application/json',
          referer: ctx.finalUrl
        });
        if (res.status === 200) detail = JSON.parse(res.body) as StoreProduct;
      } catch (err) {
        log.debug('woo', `Variation ${ref.id} could not be read`, String(err));
      }

      const v = emptyVariant(newId('var_'), ctx.product.id, i + 1);
      v.sourceVariantId = String(ref.id);
      v.options = (ref.attributes ?? [])
        .map((a) => ({ name: cleanAttrName(a.name ?? ''), value: decodeEntities(a.value ?? '').trim() }))
        .filter((o) => o.name && o.value);

      if (detail) {
        const dm = detail.prices?.currency_minor_unit;
        v.sku = cleanText(detail.sku);
        v.price = storeMoney(detail.prices?.price, dm);
        v.regularPrice = storeMoney(detail.prices?.regular_price, dm);
        v.salePrice = detail.on_sale ? storeMoney(detail.prices?.sale_price, dm) : null;
        v.compareAtPrice = detail.on_sale && v.regularPrice !== null && v.price !== null && v.regularPrice > v.price ? v.regularPrice : null;
        v.currency = currencyFrom(detail.prices?.currency_code);
        v.available = detail.is_in_stock ?? null;
        v.stockStatus = detail.is_on_backorder ? 'on_backorder' : detail.is_in_stock === undefined ? 'unknown' : detail.is_in_stock ? 'in_stock' : 'out_of_stock';
        v.inventoryQuantity = detail.low_stock_remaining ?? null;
        v.weight = parseNumber(detail.weight);
        v.length = parseNumber(detail.dimensions?.length);
        v.width = parseNumber(detail.dimensions?.width);
        v.height = parseNumber(detail.dimensions?.height);
        const vImg = detail.images?.[0]?.src;
        const abs = absoluteUrl(vImg, ctx.finalUrl);
        if (abs) {
          v.imageUrl = upscaleWordpressImage(abs);
          addImage(ctx, v.imageUrl, src, { alt: cleanText(detail.images?.[0]?.alt), variantIds: [v.id] });
        }
        if (!v.options.length && detail.variation) {
          v.title = cleanText(decodeEntities(detail.variation));
        }
      }
      built.push(v);
    }
    if (built.length) {
      mergeVariants(ctx, built, src);
      produced++;
    }
  }

  return produced;
}

/* ------------------------------------------------------------------ */
/* data-product_variations                                             */
/* ------------------------------------------------------------------ */

function readFormVariations(ctx: ExtractionContext): WooVariationJson[] | null {
  const fromHarvest = ctx.harvest?.wooVariations;
  if (Array.isArray(fromHarvest) && fromHarvest.length) return fromHarvest as WooVariationJson[];

  const raw = ctx.$('form.variations_form, form[data-product_variations]').first().attr('data-product_variations');
  if (!raw || raw === 'false' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(decodeEntities(raw)) as WooVariationJson[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    ctx.warnings.push('The variation data on this page could not be read; it may be loaded on demand.');
    return null;
  }
}

function applyFormVariations(ctx: ExtractionContext, list: WooVariationJson[]): number {
  const src = 'woo-variation-form' as const;
  if (ctx.settings.keepDebugSnippets) ctx.snippets['woo.variations'] = JSON.stringify(list).slice(0, 40000);

  const labels = attributeLabels(ctx.$);
  const built: CanonicalVariant[] = list.map((raw, i) => {
    const v = emptyVariant(newId('var_'), ctx.product.id, i + 1);
    v.sourceVariantId = raw.variation_id !== undefined ? String(raw.variation_id) : null;
    v.options = Object.entries(raw.attributes ?? {})
      .map(([key, value]) => ({
        name: labels[key] ?? cleanAttrName(key),
        value: decodeEntities(String(value ?? '')).trim()
      }))
      .filter((o) => o.name && o.value);

    v.price = parseMoney(raw.display_price);
    v.regularPrice = parseMoney(raw.display_regular_price);
    v.salePrice = v.regularPrice !== null && v.price !== null && v.price < v.regularPrice ? v.price : null;
    v.compareAtPrice = v.regularPrice !== null && v.price !== null && v.regularPrice > v.price ? v.regularPrice : null;
    v.sku = cleanText(raw.sku);
    v.available = raw.is_in_stock ?? null;
    v.stockStatus = availabilityFromHtml(raw.availability_html, raw.is_in_stock);
    v.backordersAllowed = raw.backorders_allowed ?? null;
    v.inventoryQuantity = parseNumber(raw.max_qty);

    const w = parseNumber(raw.weight);
    if (w !== null) {
      v.weight = w;
      v.weightUnit = unitFromHtml(raw.weight_html) ?? null;
    }
    v.length = parseNumber(raw.dimensions?.length);
    v.width = parseNumber(raw.dimensions?.width);
    v.height = parseNumber(raw.dimensions?.height);

    const img = raw.image?.full_src ?? raw.image?.src;
    const abs = absoluteUrl(img, ctx.finalUrl);
    if (abs) v.imageUrl = upscaleWordpressImage(abs);
    return v;
  });

  for (const v of built) {
    if (v.imageUrl) {
      const raw = list.find((r) => String(r.variation_id) === v.sourceVariantId);
      addImage(ctx, v.imageUrl, src, {
        alt: cleanText(decodeEntities(raw?.image?.alt ?? '')),
        title: cleanText(decodeEntities(raw?.image?.title ?? '')),
        width: raw?.image?.full_src_w ?? null,
        height: raw?.image?.full_src_h ?? null,
        variantIds: [v.id]
      });
    }
  }

  mergeVariants(ctx, built, src);
  return built.length ? 1 : 0;
}

/** attribute_pa_color -> "Color", using the theme's own labels when present. */
function attributeLabels($: CheerioAPI): Record<string, string> {
  const out: Record<string, string> = {};
  $('form.variations_form table.variations tr, form.variations_form .variations .variation').each((_, tr) => {
    const $tr = $(tr as Element);
    const sel = $tr.find('select[name^="attribute_"]').first();
    const name = sel.attr('name');
    const label = cleanText($tr.find('label, th').first().text())?.replace(/:$/, '');
    if (name && label) out[name] = label;
  });
  $('[data-attribute_name]').each((_, el) => {
    const name = $(el as Element).attr('data-attribute_name');
    const label = cleanText($(el as Element).closest('tr, .variation').find('label, th').first().text())?.replace(/:$/, '');
    if (name && label) out[name] = label;
  });
  return out;
}

function cleanAttrName(raw: string): string {
  return decodeEntities(raw)
    .replace(/^attribute_/, '')
    .replace(/^pa_/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function availabilityFromHtml(html: string | undefined, inStock: boolean | undefined): StockStatus {
  const t = (html ?? '').toLowerCase();
  if (t.includes('backorder')) return 'on_backorder';
  if (t.includes('out of stock') || t.includes('sold out')) return 'out_of_stock';
  if (t.includes('in stock') || /\d+\s+in stock/.test(t)) return 'in_stock';
  if (inStock === true) return 'in_stock';
  if (inStock === false) return 'out_of_stock';
  return 'unknown';
}

function unitFromHtml(html: string | undefined): string | null {
  if (!html) return null;
  const m = html.match(/\b(kg|g|lbs?|oz)\b/i);
  return m ? normaliseWeightUnit(m[1]) : null;
}

/* ------------------------------------------------------------------ */
/* WordPress REST                                                      */
/* ------------------------------------------------------------------ */

async function fetchWpPost(
  ctx: ExtractionContext,
  origin: string,
  slug: string | null
): Promise<{ title: string; contentHtml: string; excerptHtml: string } | null> {
  if (!slug) return null;
  const urls = [
    `${origin}/wp-json/wp/v2/product?slug=${encodeURIComponent(slug)}`,
    `${origin}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}`
  ];
  for (const url of urls) {
    try {
      const res = await ctx.fetcher.get(url, {
        timeoutMs: Math.min(ctx.settings.requestTimeoutMs, 20000),
        userAgent: ctx.settings.userAgent,
        accept: 'application/json',
        referer: ctx.finalUrl
      });
      if (res.status !== 200) continue;
      const arr = JSON.parse(res.body) as Array<{
        title?: { rendered?: string };
        content?: { rendered?: string };
        excerpt?: { rendered?: string };
      }>;
      const p = Array.isArray(arr) ? arr[0] : null;
      if (p?.content?.rendered) {
        return {
          title: decodeEntities(p.title?.rendered ?? ''),
          contentHtml: p.content.rendered,
          excerptHtml: p.excerpt?.rendered ?? ''
        };
      }
    } catch {
      /* next */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Rendered page                                                       */
/* ------------------------------------------------------------------ */

function applyRenderedPage(ctx: ExtractionContext): number {
  const $ = ctx.$;
  const m = ctx.merger;
  const src = 'html' as const;
  let produced = 0;

  m.set('title', cleanText($('h1.product_title, .product_title, h1.entry-title').first().text()), src, 'h1.product_title');

  const shortDesc = $('.woocommerce-product-details__short-description').first();
  if (shortDesc.length) {
    const s = sanitiseDescription(shortDesc.html(), ctx.finalUrl);
    m.set('shortDescriptionHtml', s.html, src, '.woocommerce-product-details__short-description');
    m.set('shortDescriptionText', s.text, src);
    produced++;
  }

  const longDesc = $('#tab-description, .woocommerce-Tabs-panel--description, .woocommerce-product-details__description').first();
  if (longDesc.length) {
    const clone = longDesc.clone();
    clone.find('h2:first-child').filter((_, el) => /description/i.test($(el as Element).text())).remove();
    const s = sanitiseDescription(clone.html(), ctx.finalUrl);
    m.set('descriptionHtml', s.html, src, '#tab-description');
    m.set('descriptionText', s.text, src);
    produced++;
  }

  m.set('sku', cleanText($('.sku_wrapper .sku, span.sku').first().text()), src, '.sku');

  const priceBlock = $('.summary .price, .entry-summary .price, p.price').first();
  if (priceBlock.length) {
    const ins = priceBlock.find('ins .amount, ins bdi').first().text();
    const del = priceBlock.find('del .amount, del bdi').first().text();
    const plain = priceBlock.find('.amount, bdi').first().text();
    const current = parseMoney(ins || plain);
    const was = parseMoney(del);
    m.set('price', current, src, '.price');
    m.set('regularPrice', was ?? current, src, '.price');
    if (was !== null && current !== null && was > current) {
      m.set('salePrice', current, src, '.price ins');
      m.set('compareAtPrice', was, src, '.price del');
    }
    m.set('currency', currencyFrom(priceBlock.text()), src, '.price');
    produced++;
  }

  const stockEl = $('.stock, .availability').first();
  if (stockEl.length) {
    m.set('stockStatus', availabilityFromHtml(stockEl.text(), undefined), src, '.stock');
    const qty = stockEl.text().match(/(\d+)\s+in stock/i);
    if (qty) m.set('inventoryQuantity', Number(qty[1]), src, '.stock');
  }
  const maxQty = $('input.qty[max]').attr('max');
  if (maxQty) m.set('inventoryQuantity', parseNumber(maxQty), 'heuristic', 'quantity input max');

  /* gallery */
  const gallery = $('.woocommerce-product-gallery__image, .woocommerce-product-gallery figure a, .flex-control-thumbs li');
  let pos = 0;
  gallery.each((_, el) => {
    const $el = $(el as Element);
    const full =
      $el.attr('data-large_image') ??
      $el.find('a').attr('href') ??
      $el.attr('href') ??
      $el.find('img').attr('data-large_image') ??
      $el.find('img').attr('data-src') ??
      $el.find('img').attr('src');
    const abs = absoluteUrl(full, ctx.finalUrl);
    if (!abs || !/\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(abs)) return;
    pos++;
    addImage(ctx, upscaleWordpressImage(abs), src, {
      alt: cleanText($el.find('img').attr('alt')),
      title: cleanText($el.find('img').attr('title')),
      width: parseNumber($el.attr('data-large_image_width')),
      height: parseNumber($el.attr('data-large_image_height')),
      position: pos,
      isFeatured: pos === 1 && $el.hasClass('woocommerce-product-gallery__image--placeholder') === false
    });
  });
  if (pos) produced++;

  /* additional information table -> attributes, weight, dimensions */
  const attrs: CanonicalAttribute[] = [...ctx.product.attributes];
  $('table.woocommerce-product-attributes, table.shop_attributes').find('tr').each((i, tr) => {
    const $tr = $(tr as Element);
    const label = cleanText($tr.find('th, .woocommerce-product-attributes-item__label').first().text())?.replace(/:$/, '');
    const valueCell = $tr.find('td, .woocommerce-product-attributes-item__value').first();
    const value = cleanText(valueCell.text());
    if (!label || !value) return;
    const lower = label.toLowerCase();
    if (lower === 'weight') {
      const n = parseNumber(value);
      if (n !== null) {
        m.set('weight', n, src, 'attributes table');
        m.set('weightUnit', unitFromHtml(value) ?? null, src, 'attributes table');
      }
      return;
    }
    if (lower === 'dimensions') {
      const nums = value.match(/[\d.]+/g);
      if (nums && nums.length >= 3) {
        m.set('length', Number(nums[0]), src, 'attributes table');
        m.set('width', Number(nums[1]), src, 'attributes table');
        m.set('height', Number(nums[2]), src, 'attributes table');
        const u = value.match(/\b(cm|mm|m|in|inch|inches|ft)\b/i);
        if (u) m.set('dimensionUnit', u[1].toLowerCase(), src, 'attributes table');
      }
      return;
    }
    if (!attrs.some((a) => a.name.toLowerCase() === lower)) {
      attrs.push({
        name: label,
        values: valueCell.find('p, a').length
          ? valueCell.find('p, a').map((_, n) => cleanText($(n as Element).text()) ?? '').get().filter(Boolean)
          : value.split(/\s*,\s*/).filter(Boolean),
        isGlobal: false,
        isVariation: false,
        visible: true,
        position: attrs.length + 1
      });
    }
  });
  if (attrs.length !== ctx.product.attributes.length) {
    ctx.product.attributes = attrs;
    if (!ctx.product.provenance['attributes']) ctx.product.provenance['attributes'] = { source: src, confidence: 'medium' };
    produced++;
  }

  /* option axes from the variation selectors, when nothing better exists */
  if (ctx.product.options.length === 0) {
    const labels = attributeLabels($);
    const opts: Array<{ name: string; values: string[]; position: number }> = [];
    $('form.variations_form select[name^="attribute_"]').each((i, el) => {
      const $el = $(el as Element);
      const name = $el.attr('name') ?? '';
      const values = $el
        .find('option')
        .map((_, o) => $(o as Element).attr('value') ?? '')
        .get()
        .filter((v) => v !== '');
      if (!values.length) return;
      opts.push({ name: labels[name] ?? cleanAttrName(name), values: values.map(decodeEntities), position: i + 1 });
    });
    if (opts.length) {
      ctx.product.options = opts;
      ctx.product.provenance['options'] = { source: src, confidence: 'medium' };
      produced++;
    }
  }

  const catText = cleanText($('.posted_in a').map((_, a) => $(a as Element).text()).get().join(' > '));
  m.set('sourceProductType', catText, src, '.posted_in');
  const tagText = $('.tagged_as a').map((_, a) => cleanText($(a as Element).text()) ?? '').get().filter(Boolean);
  if (tagText.length) m.addToStringArray('tags', tagText, src);

  m.set('allowReviews', parseBool($('#reviews, .woocommerce-Reviews').length > 0), 'heuristic', 'reviews section present');
  m.set('externalUrl', cleanText($('a.single_add_to_cart_button[href^="http"]').attr('href')), src);
  m.set('externalButtonText', cleanText($('a.single_add_to_cart_button[href^="http"]').text()), src);

  return produced;
}

/* ------------------------------------------------------------------ */

function slugFromUrl(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length ? decodeURIComponent(parts[parts.length - 1]) : null;
  } catch {
    return null;
  }
}

function findProductId(ctx: ExtractionContext): number | null {
  const fromHarvest = ctx.harvest?.wooProductId;
  if (typeof fromHarvest === 'number' && fromHarvest > 0) return fromHarvest;

  const formId = ctx.$('form.variations_form, form.cart').attr('data-product_id') ?? ctx.$('input[name="add-to-cart"]').attr('value');
  const n1 = parseNumber(formId);
  if (n1) return n1;

  const bodyClass = ctx.$('body').attr('class') ?? '';
  const m1 = bodyClass.match(/postid-(\d+)/);
  if (m1) return Number(m1[1]);

  const divId = ctx.$('div[id^="product-"]').attr('id');
  const m2 = divId?.match(/product-(\d+)/);
  if (m2) return Number(m2[1]);

  const shortlink = ctx.$('link[rel="shortlink"]').attr('href');
  const m3 = shortlink?.match(/[?&]p=(\d+)/);
  if (m3) return Number(m3[1]);

  return null;
}
