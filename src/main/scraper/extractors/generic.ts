/**
 * Layer 1 / 2b / 3 — platform-independent extraction.
 *
 *   metaLayer      : <title>, meta description, canonical, robots, OpenGraph,
 *                    Twitter cards, product:* meta, and any Merchant Center
 *                    fields a feed plugin has printed into the head.
 *   microdataLayer : schema.org microdata (itemprop attributes).
 *   genericHtmlLayer: last-resort DOM reading for stores on neither platform.
 *
 * These layers rank below the platform-specific ones, so they fill gaps rather
 * than overriding better data.
 */
import type { Element } from '../../dom';
import type { ExtractionContext, ExtractionLayer, LayerResult } from '../context';
import { cleanText, currencyFrom, decodeEntities, parseMoney, parseNumber } from '../merge';
import { sanitiseDescription } from '../html';
import { absoluteUrl } from '../../util/url';
import { addImage } from '../productutil';
import type { StockStatus } from '../../../shared/canonical';

function meta(ctx: ExtractionContext, selectors: string[]): string | null {
  for (const sel of selectors) {
    const el = ctx.$(sel).first();
    if (!el.length) continue;
    const v = el.attr('content') ?? el.attr('value') ?? el.text();
    const c = cleanText(v ? decodeEntities(v) : null);
    if (c) return c;
  }
  return null;
}

function stockFromText(v: string | null): StockStatus {
  if (!v) return 'unknown';
  const s = v.toLowerCase();
  if (s.includes('backorder')) return 'on_backorder';
  if (s.includes('preorder')) return 'preorder';
  if (s.includes('out of stock') || s.includes('outofstock') || s.includes('sold out') || s.includes('unavailable')) return 'out_of_stock';
  if (s.includes('in stock') || s.includes('instock') || s.includes('available')) return 'in_stock';
  return 'unknown';
}

export const metaLayer: ExtractionLayer = {
  id: 'meta',
  label: 'Page metadata & OpenGraph',
  applies: () => true,

  async run(ctx): Promise<LayerResult> {
    const m = ctx.merger;
    let produced = 0;

    /* ---- SEO ---- */
    const docTitle = cleanText(ctx.$('head > title').first().text());
    const seoTitle = meta(ctx, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ?? docTitle;
    m.setPath('seo.title', seoTitle, seoTitle === docTitle ? 'html' : 'opengraph', seoTitle === docTitle ? '<title>' : 'og:title');
    m.setPath('seo.ogTitle', meta(ctx, ['meta[property="og:title"]']), 'opengraph', 'og:title');
    const desc = meta(ctx, ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']);
    m.setPath('seo.metaDescription', desc, 'html', 'meta[name=description]');
    m.setPath('seo.description', desc, 'html', 'meta description');
    m.setPath('seo.ogDescription', meta(ctx, ['meta[property="og:description"]']), 'opengraph', 'og:description');
    m.setPath('seo.robots', meta(ctx, ['meta[name="robots"]']), 'html', 'meta[name=robots]');
    const canonical = absoluteUrl(ctx.$('link[rel="canonical"]').attr('href'), ctx.finalUrl);
    m.setPath('seo.canonicalUrl', canonical, 'html', 'link[rel=canonical]');
    const keywords = meta(ctx, ['meta[name="keywords"]']);
    if (keywords) m.addToStringArray('seo.keywords', keywords.split(','), 'html');
    const ogImage = absoluteUrl(meta(ctx, ['meta[property="og:image"]', 'meta[name="twitter:image"]']), ctx.finalUrl);
    m.setPath('seo.ogImage', ogImage, 'opengraph', 'og:image');
    produced += 4;

    /* ---- product basics ---- */
    m.set('title', meta(ctx, ['meta[property="og:title"]']), 'opengraph', 'og:title');
    m.set('title', cleanText(ctx.$('h1').first().text()), 'html', 'first h1');
    // The meta description is offered only as the weakest possible fallback.
    // Whether it ended up being the ONLY description is decided at the end of
    // the run, once every stronger layer has had its turn.
    if (desc) m.set('descriptionText', desc, 'heuristic', 'meta description (fallback)');

    const ogType = meta(ctx, ['meta[property="og:type"]']);
    if (ogType && /product/i.test(ogType)) m.set('kind', 'simple', 'heuristic', 'og:type=product');

    /* ---- product:* meta (used by Shopify, Woo SEO plugins and feed plugins) ---- */
    const price = meta(ctx, ['meta[property="product:price:amount"]', 'meta[property="og:price:amount"]', 'meta[itemprop="price"]']);
    m.set('price', parseMoney(price), 'opengraph', 'product:price:amount');
    const cur = meta(ctx, ['meta[property="product:price:currency"]', 'meta[property="og:price:currency"]', 'meta[itemprop="priceCurrency"]']);
    m.set('currency', currencyFrom(cur), 'opengraph', 'product:price:currency');
    const sale = meta(ctx, ['meta[property="product:sale_price:amount"]']);
    m.set('salePrice', parseMoney(sale), 'opengraph', 'product:sale_price:amount');
    m.set('stockStatus', stockFromText(meta(ctx, ['meta[property="product:availability"]', 'meta[property="og:availability"]'])), 'opengraph', 'product:availability');
    m.set('brand', meta(ctx, ['meta[property="product:brand"]', 'meta[property="og:brand"]']), 'opengraph', 'product:brand');
    m.set('sku', meta(ctx, ['meta[property="product:retailer_item_id"]', 'meta[property="product:sku"]']), 'opengraph', 'product:retailer_item_id');
    produced += 2;

    /* ---- Merchant Center fields, only when the page publishes them ---- */
    m.setPath('google.brand', meta(ctx, ['meta[property="product:brand"]']), 'opengraph', 'product:brand');
    m.setPath('google.gtin', meta(ctx, ['meta[property="product:retailer_part_no"]', 'meta[property="product:gtin"]', 'meta[itemprop="gtin13"]', 'meta[itemprop="gtin"]']), 'opengraph');
    m.setPath('google.mpn', meta(ctx, ['meta[property="product:mfr_part_no"]', 'meta[property="product:mpn"]', 'meta[itemprop="mpn"]']), 'opengraph');
    m.setPath('google.condition', normaliseCondition(meta(ctx, ['meta[property="product:condition"]'])), 'opengraph', 'product:condition');
    m.setPath('google.gender', meta(ctx, ['meta[property="product:gender"]']), 'opengraph');
    m.setPath('google.ageGroup', meta(ctx, ['meta[property="product:age_group"]']), 'opengraph');
    m.setPath('google.color', meta(ctx, ['meta[property="product:color"]']), 'opengraph');
    m.setPath('google.size', meta(ctx, ['meta[property="product:size"]']), 'opengraph');
    m.setPath('google.material', meta(ctx, ['meta[property="product:material"]']), 'opengraph');
    m.setPath('google.itemGroupId', meta(ctx, ['meta[property="product:item_group_id"]']), 'opengraph');
    m.setPath('google.productTypeString', meta(ctx, ['meta[property="product:category"]', 'meta[property="product:product_type"]']), 'opengraph');
    m.setPath('google.googleProductCategory', meta(ctx, ['meta[property="product:google_product_category"]']), 'opengraph');
    for (let i = 0; i < 5; i++) {
      m.setPath(`google.customLabel${i}`, meta(ctx, [`meta[property="product:custom_label_${i}"]`]), 'opengraph');
    }

    /* ---- og image as a gallery candidate ---- */
    if (ogImage) addImage(ctx, ogImage, 'opengraph', { alt: meta(ctx, ['meta[property="og:image:alt"]']) });

    m.set('vendor', meta(ctx, ['meta[property="og:site_name"]']), 'heuristic', 'og:site_name');
    return { produced };
  }
};

function normaliseCondition(v: string | null): 'new' | 'refurbished' | 'used' | null {
  if (!v) return null;
  const s = v.toLowerCase();
  if (s.includes('new')) return 'new';
  if (s.includes('refurb')) return 'refurbished';
  if (s.includes('used')) return 'used';
  return null;
}

/* ------------------------------------------------------------------ */

export const microdataLayer: ExtractionLayer = {
  id: 'microdata',
  label: 'Schema.org microdata',

  applies(ctx) {
    return ctx.$('[itemtype*="schema.org/Product" i], [itemprop="price"], [itemprop="sku"]').length > 0;
  },

  async run(ctx): Promise<LayerResult> {
    const $ = ctx.$;
    const m = ctx.merger;
    const scope = $('[itemtype*="schema.org/Product" i]').first();
    const root = scope.length ? scope : $.root();
    let produced = 0;

    const prop = (name: string): string | null => {
      const el = root.find(`[itemprop="${name}"]`).first();
      if (!el.length) return null;
      const v = el.attr('content') ?? el.attr('href') ?? el.attr('src') ?? el.text();
      return cleanText(v ? decodeEntities(v) : null);
    };

    m.set('title', prop('name'), 'microdata', 'itemprop=name');
    m.set('sku', prop('sku'), 'microdata', 'itemprop=sku');
    m.set('brand', prop('brand'), 'microdata', 'itemprop=brand');
    m.setPath('google.brand', prop('brand'), 'microdata');
    m.setPath('google.mpn', prop('mpn'), 'microdata');
    m.setPath('google.gtin', prop('gtin13') ?? prop('gtin12') ?? prop('gtin'), 'microdata');
    m.set('barcode', prop('gtin13') ?? prop('gtin12'), 'microdata');
    m.set('price', parseMoney(prop('price')), 'microdata', 'itemprop=price');
    m.set('currency', currencyFrom(prop('priceCurrency')), 'microdata');
    m.set('stockStatus', stockFromText(prop('availability')), 'microdata');
    m.set('ratingValue', parseNumber(prop('ratingValue')), 'microdata');
    m.set('reviewCount', parseNumber(prop('reviewCount') ?? prop('ratingCount')), 'microdata');
    produced += 4;

    const descEl = root.find('[itemprop="description"]').first();
    if (descEl.length) {
      const s = sanitiseDescription(descEl.html(), ctx.finalUrl);
      m.set('descriptionHtml', s.html, 'microdata', 'itemprop=description');
      m.set('descriptionText', s.text, 'microdata');
      produced++;
    }

    root.find('[itemprop="image"]').each((_, el) => {
      const $el = $(el as Element);
      const u = absoluteUrl($el.attr('content') ?? $el.attr('src') ?? $el.attr('href'), ctx.finalUrl);
      if (u) addImage(ctx, u, 'microdata', { alt: cleanText($el.attr('alt')) });
    });

    return { produced };
  }
};

/* ------------------------------------------------------------------ */

const GALLERY_SELECTORS = [
  '.product-gallery img',
  '.product__media img',
  '.product-single__photo img',
  '.product-images img',
  '[data-product-gallery] img',
  '.swiper-slide img',
  'figure.product-image img',
  '.gallery img',
  'main img'
];

export const genericHtmlLayer: ExtractionLayer = {
  id: 'generic-html',
  label: 'Generic page reading',
  applies: () => true,

  async run(ctx): Promise<LayerResult> {
    const $ = ctx.$;
    const m = ctx.merger;
    let produced = 0;

    m.set('title', cleanText($('h1').first().text()), 'html', 'first h1');

    if (!ctx.product.price) {
      const priceText = cleanText(
        $('[class*="price" i]:not([class*="compare" i]):not(del):not(s)').first().text()
      );
      const parsed = parseMoney(priceText);
      if (parsed !== null) {
        m.set('price', parsed, 'html', 'first element with a price class');
        m.set('currency', currencyFrom(priceText), 'html');
        ctx.warnings.push('The price was read from page text rather than structured data; please verify it.');
        produced++;
      }
    }

    if (!ctx.product.descriptionHtml) {
      const candidates = [
        '#tab-description',
        '.product-description',
        '.product__description',
        '[class*="description" i]',
        '.rte',
        'article'
      ];
      for (const sel of candidates) {
        const el = $(sel).first();
        if (!el.length) continue;
        const html = el.html();
        if (!html || html.replace(/<[^>]+>/g, '').trim().length < 40) continue;
        const s = sanitiseDescription(html, ctx.finalUrl);
        m.set('descriptionHtml', s.html, 'html', sel);
        m.set('descriptionText', s.text, 'html', sel);
        produced++;
        break;
      }
    }

    if (ctx.product.images.length === 0) {
      for (const sel of GALLERY_SELECTORS) {
        const imgs = $(sel);
        if (!imgs.length) continue;
        let added = 0;
        imgs.each((_, el) => {
          if (added >= 30) return;
          const $el = $(el as Element);
          const raw =
            $el.attr('data-zoom-image') ??
            $el.attr('data-large_image') ??
            $el.attr('data-src') ??
            $el.attr('data-lazy-src') ??
            $el.attr('src');
          const abs = absoluteUrl(raw, ctx.finalUrl);
          if (!abs) return;
          if (!/\.(jpe?g|png|webp|avif)(\?|$)/i.test(abs)) return;
          if (/logo|icon|sprite|placeholder|badge|payment|flag/i.test(abs)) return;
          const w = parseNumber($el.attr('width'));
          if (w !== null && w < 150) return;
          addImage(ctx, abs, 'html', { alt: cleanText($el.attr('alt')), title: cleanText($el.attr('title')) });
          added++;
        });
        if (added) {
          produced++;
          ctx.warnings.push('Images were read from the page layout; check that no unrelated pictures were picked up.');
          break;
        }
      }
    }

    return { produced };
  }
};
