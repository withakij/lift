/**
 * Layer 2 — schema.org structured data (JSON-LD).
 *
 * Handles single objects, arrays, @graph containers, Product, ProductGroup
 * (schema.org's variant container), Offer and AggregateOffer.
 */
import type { ExtractionContext, ExtractionLayer, LayerResult } from '../context';
import { cleanText, currencyFrom, parseBool, parseMoney, parseNumber } from '../merge';
import { sanitiseDescription } from '../html';
import { absoluteUrl } from '../../util/url';
import { emptyVariant, type CanonicalVariant, type StockStatus } from '../../../shared/canonical';
import { addImages, mergeVariants } from '../productutil';
import { newId } from '../../db/store';

type Json = Record<string, unknown>;

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function typeOf(node: unknown): string[] {
  if (typeof node !== 'object' || node === null) return [];
  const t = (node as Json)['@type'];
  return asArray(t).map((x) => String(x).replace(/^https?:\/\/schema\.org\//i, ''));
}

/** Walks a JSON-LD document (including @graph) collecting nodes of a type. */
export function collectNodes(doc: unknown, wanted: string[], acc: Json[] = [], depth = 0): Json[] {
  if (depth > 8 || doc === null || typeof doc !== 'object') return acc;
  if (Array.isArray(doc)) {
    for (const d of doc) collectNodes(d, wanted, acc, depth + 1);
    return acc;
  }
  const node = doc as Json;
  const types = typeOf(node);
  if (types.some((t) => wanted.includes(t))) acc.push(node);
  for (const key of ['@graph', 'mainEntity', 'itemListElement', 'hasVariant', 'isVariantOf', 'subjectOf']) {
    if (node[key]) collectNodes(node[key], wanted, acc, depth + 1);
  }
  return acc;
}

export function readJsonLdBlocks(ctx: ExtractionContext): unknown[] {
  const blocks: unknown[] = [];
  if (ctx.harvest?.jsonLd?.length) blocks.push(...ctx.harvest.jsonLd);
  ctx.$('script[type="application/ld+json"]').each((_, el) => {
    const raw = ctx.$(el).html();
    if (!raw) return;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // Some themes emit trailing commas or HTML comments around the JSON.
      const cleaned = raw
        .replace(/^\s*<!--/, '')
        .replace(/-->\s*$/, '')
        .replace(/,\s*([}\]])/g, '$1');
      try {
        blocks.push(JSON.parse(cleaned));
      } catch {
        ctx.warnings.push('A structured-data block on this page could not be parsed.');
      }
    }
  });
  return blocks;
}

function availabilityToStatus(v: unknown): StockStatus {
  const s = String(v ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('backorder')) return 'on_backorder';
  if (s.includes('preorder') || s.includes('presale')) return 'preorder';
  if (s.includes('outofstock') || s.includes('out_of_stock') || s.includes('soldout') || s.includes('discontinued')) {
    return 'out_of_stock';
  }
  if (s.includes('instock') || s.includes('in_stock') || s.includes('limitedavailability') || s.includes('onlineonly')) {
    return 'in_stock';
  }
  return 'unknown';
}

function conditionOf(v: unknown): 'new' | 'refurbished' | 'used' | 'unknown' {
  const s = String(v ?? '').toLowerCase();
  if (s.includes('newcondition')) return 'new';
  if (s.includes('refurbish')) return 'refurbished';
  if (s.includes('used') || s.includes('damaged')) return 'used';
  return 'unknown';
}

function textOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return cleanText(v);
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === 'object') {
    const o = v as Json;
    return textOf(o.name ?? o['@value'] ?? o.value ?? o.url ?? null);
  }
  return null;
}

function imageUrlsOf(v: unknown, base: string): string[] {
  const out: string[] = [];
  for (const item of asArray(v)) {
    if (typeof item === 'string') {
      const abs = absoluteUrl(item, base);
      if (abs) out.push(abs);
    } else if (typeof item === 'object' && item !== null) {
      const o = item as Json;
      const u = (o.url ?? o.contentUrl ?? o['@id']) as string | undefined;
      const abs = absoluteUrl(u, base);
      if (abs) out.push(abs);
    }
  }
  return out;
}

export const jsonLdLayer: ExtractionLayer = {
  id: 'jsonld',
  label: 'Structured data (JSON-LD)',

  applies(ctx) {
    return (ctx.harvest?.jsonLd?.length ?? 0) > 0 || ctx.$('script[type="application/ld+json"]').length > 0;
  },

  async run(ctx): Promise<LayerResult> {
    const blocks = readJsonLdBlocks(ctx);
    if (!blocks.length) return { produced: 0 };

    const groups = blocks.flatMap((b) => collectNodes(b, ['ProductGroup']));
    const products = blocks.flatMap((b) => collectNodes(b, ['Product', 'IndividualProduct', 'ProductModel']));
    const primary = groups[0] ?? products[0];
    if (!primary) return { produced: 0, note: 'No Product node in structured data.' };

    if (ctx.settings.keepDebugSnippets) {
      ctx.snippets['jsonld'] = JSON.stringify(primary).slice(0, 20000);
    }

    const m = ctx.merger;
    const base = ctx.finalUrl;
    let produced = 0;
    const count = () => produced++;

    m.set('title', textOf(primary.name), 'jsonld', 'Product.name');
    count();
    // Deliberately NOT `sku`: a stock number is not the store's product id, and
    // treating it as one outranks the platform's real id later in the run.
    const declaredId = textOf(primary.productID) ?? idFromNode(primary['@id']);
    m.set('sourceProductId', declaredId, 'jsonld', 'Product.productID');
    m.set('sku', textOf(primary.sku), 'jsonld', 'Product.sku');
    m.set('brand', textOf(primary.brand), 'jsonld', 'Product.brand');
    m.set('vendor', textOf(primary.brand ?? primary.manufacturer), 'jsonld', 'Product.brand');
    m.setPath('google.brand', textOf(primary.brand), 'jsonld', 'Product.brand');
    m.setPath('google.gtin', textOf(primary.gtin13 ?? primary.gtin14 ?? primary.gtin12 ?? primary.gtin8 ?? primary.gtin), 'jsonld', 'Product.gtin*');
    m.setPath('google.mpn', textOf(primary.mpn), 'jsonld', 'Product.mpn');
    m.setPath('google.color', textOf(primary.color), 'jsonld', 'Product.color');
    m.setPath('google.material', textOf(primary.material), 'jsonld', 'Product.material');
    m.setPath('google.pattern', textOf(primary.pattern), 'jsonld', 'Product.pattern');
    m.setPath('google.size', textOf(primary.size), 'jsonld', 'Product.size');
    m.setPath('google.gender', textOf((primary.audience as Json)?.suggestedGender ?? primary.gender), 'jsonld', 'Product.audience');
    m.setPath('google.ageGroup', textOf((primary.audience as Json)?.suggestedAge ?? primary.ageGroup), 'jsonld', 'Product.audience');
    m.setPath('google.itemGroupId', textOf(primary.inProductGroupWithID ?? primary.productGroupID), 'jsonld', 'ProductGroup id');
    m.setPath('google.googleProductCategory', textOf(primary.googleProductCategory), 'jsonld', 'Product.googleProductCategory');
    m.set('sourceProductType', textOf(primary.category), 'jsonld', 'Product.category');
    m.set('barcode', textOf(primary.gtin13 ?? primary.gtin12 ?? primary.gtin), 'jsonld', 'Product.gtin*');

    const rawDesc = typeof primary.description === 'string' ? primary.description : null;
    if (rawDesc) {
      const looksHtml = /<\/?[a-z][\s\S]*>/i.test(rawDesc);
      if (looksHtml) {
        const s = sanitiseDescription(rawDesc, base);
        m.set('descriptionHtml', s.html, 'jsonld', 'Product.description');
        m.set('descriptionText', s.text, 'jsonld', 'Product.description');
      } else {
        m.set('descriptionText', cleanText(rawDesc), 'jsonld', 'Product.description');
      }
      count();
    }

    const imgs = imageUrlsOf(primary.image, base);
    if (imgs.length) {
      ctx.product.debug = ctx.product.debug ?? {};
      (ctx.product.debug.rawSnippets ??= {})['jsonld.images'] = imgs.slice(0, 30).join('\n');
      addImages(ctx, imgs, 'jsonld');
      count();
    }

    const weightNode = primary.weight as Json | undefined;
    if (weightNode) {
      m.set('weight', parseNumber(weightNode.value ?? weightNode), 'jsonld', 'Product.weight');
      m.set('weightUnit', normaliseUnitCode(textOf(weightNode.unitCode ?? weightNode.unitText)), 'jsonld', 'Product.weight.unitCode');
      count();
    }
    for (const [dim, field] of [['depth', 'length'], ['width', 'width'], ['height', 'height']] as const) {
      const node = primary[dim] as Json | undefined;
      if (node) m.set(field as never, parseNumber(node.value ?? node) as never, 'jsonld', `Product.${dim}`);
    }

    const rating = primary.aggregateRating as Json | undefined;
    if (rating) {
      m.set('ratingValue', parseNumber(rating.ratingValue), 'jsonld', 'aggregateRating');
      m.set('reviewCount', parseNumber(rating.reviewCount ?? rating.ratingCount), 'jsonld', 'aggregateRating');
    }

    /* ---------------- offers ---------------- */
    const offers = asArray(primary.offers as Json | Json[] | undefined);
    const flatOffers: Json[] = [];
    for (const o of offers) {
      const t = typeOf(o);
      if (t.includes('AggregateOffer')) {
        m.set('priceMin', parseMoney(o.lowPrice), 'jsonld', 'AggregateOffer.lowPrice');
        m.set('priceMax', parseMoney(o.highPrice), 'jsonld', 'AggregateOffer.highPrice');
        m.set('currency', currencyFrom(o.priceCurrency), 'jsonld', 'AggregateOffer.priceCurrency');
        if (o.offers) flatOffers.push(...asArray(o.offers as Json | Json[]));
        if (o.lowPrice !== undefined && o.highPrice !== undefined && String(o.lowPrice) !== String(o.highPrice)) {
          m.set('kind', 'variable', 'heuristic', 'AggregateOffer price range');
        }
      } else {
        flatOffers.push(o);
      }
    }

    if (flatOffers.length === 1) {
      const o = flatOffers[0];
      m.set('price', parseMoney(o.price ?? (o.priceSpecification as Json)?.price), 'jsonld', 'Offer.price');
      m.set('currency', currencyFrom(o.priceCurrency ?? (o.priceSpecification as Json)?.priceCurrency), 'jsonld', 'Offer.priceCurrency');
      m.set('stockStatus', availabilityToStatus(o.availability), 'jsonld', 'Offer.availability');
      m.set('sku', textOf(o.sku), 'jsonld', 'Offer.sku');
      m.setPath('google.condition', conditionOf(o.itemCondition), 'jsonld', 'Offer.itemCondition');
      m.set('externalUrl', textOf(o.url), 'jsonld', 'Offer.url');
      count();
    } else if (flatOffers.length > 1) {
      m.set('currency', currencyFrom(flatOffers[0].priceCurrency), 'jsonld', 'Offer.priceCurrency');
      const prices = flatOffers.map((o) => parseMoney(o.price)).filter((p): p is number => p !== null);
      if (prices.length) {
        m.set('priceMin', Math.min(...prices), 'jsonld', 'offers');
        m.set('priceMax', Math.max(...prices), 'jsonld', 'offers');
      }
      count();
    }

    /* ---------------- variants ---------------- */
    // schema.org ProductGroup.hasVariant, or a Product with several offers that
    // each name a distinct SKU.
    const variantNodes = asArray(primary.hasVariant as Json | Json[] | undefined).filter((n) => typeof n === 'object');
    let variantsAuthoritative = false;

    if (variantNodes.length) {
      const axisProps = asArray(primary.variesBy as string | string[] | undefined).map((s) =>
        String(s).replace(/^https?:\/\/schema\.org\//i, '')
      );
      const built: CanonicalVariant[] = [];
      variantNodes.forEach((node, idx) => {
        const v = emptyVariant(newId('var_'), ctx.product.id, idx + 1);
        v.sourceVariantId = textOf(node.productID ?? node.sku ?? node['@id']);
        v.title = textOf(node.name);
        v.sku = textOf(node.sku);
        v.barcode = textOf(node.gtin13 ?? node.gtin12 ?? node.gtin);
        const props = axisProps.length ? axisProps : ['color', 'size', 'material', 'pattern'];
        for (const p of props) {
          const val = textOf(node[p]);
          if (val) v.options.push({ name: capitalise(p), value: val });
        }
        const vOffers = asArray(node.offers as Json | Json[] | undefined);
        const off = vOffers[0];
        if (off) {
          v.price = parseMoney(off.price ?? (off.priceSpecification as Json)?.price);
          v.currency = currencyFrom(off.priceCurrency);
          v.stockStatus = availabilityToStatus(off.availability);
          v.available = v.stockStatus === 'unknown' ? null : v.stockStatus === 'in_stock';
          v.inventoryQuantity = parseNumber(off.inventoryLevel);
        }
        const vImgs = imageUrlsOf(node.image, base);
        if (vImgs.length) v.imageUrl = vImgs[0];
        const w = node.weight as Json | undefined;
        if (w) {
          v.weight = parseNumber(w.value ?? w);
          v.weightUnit = normaliseUnitCode(textOf(w.unitCode ?? w.unitText));
        }
        built.push(v);
      });
      if (built.length) {
        mergeVariants(ctx, built, 'jsonld');
        m.set('kind', 'variable', 'jsonld', 'ProductGroup.hasVariant');
        variantsAuthoritative = built.every((v) => v.price !== null) && built.length > 1;
        count();
      }
    }

    m.setPath('seo.canonicalUrl', textOf(primary.url), 'jsonld', 'Product.url');
    m.set('allowReviews', parseBool(primary.reviewCount !== undefined || primary.review !== undefined), 'heuristic');

    return { produced, variantsAuthoritative };
  }
};

/** Accepts "#product" or "12345" but not a full page URL. */
function idFromNode(value: unknown): string | null {
  const s = textOf(value);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return null;
  return s.replace(/^#/, '') || null;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normaliseUnitCode(code: string | null): string | null {
  if (!code) return null;
  const s = code.trim().toUpperCase();
  const map: Record<string, string> = {
    GRM: 'g', KGM: 'kg', LBR: 'lb', ONZ: 'oz',
    G: 'g', KG: 'kg', LB: 'lb', LBS: 'lb', OZ: 'oz',
    GRAM: 'g', GRAMS: 'g', KILOGRAM: 'kg', KILOGRAMS: 'kg', POUND: 'lb', POUNDS: 'lb', OUNCE: 'oz', OUNCES: 'oz'
  };
  return map[s] ?? null;
}
