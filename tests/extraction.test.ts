import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineWith, fixture, variantByOptions } from './helpers';
import type { CanonicalProduct } from '../src/shared/canonical';

const SHOPIFY_URL = 'https://atlas-supply.myshopify.com/products/atlas-merino-crew';
const SHOPIFY_JS = 'https://atlas-supply.myshopify.com/products/atlas-merino-crew.js';
const WOO_URL = 'https://shop.example.com/product/aster-standing-desk/';
const WOO_SIMPLE_URL = 'https://shop.example.com/product/copper-desk-lamp/';
const GROUP_URL = 'https://store.example.org/p/terra-mug';

function shopifyRoutes() {
  return {
    [SHOPIFY_URL]: { body: fixture('shopify-variable.html') },
    [SHOPIFY_JS]: { body: fixture('shopify-product.js.json'), contentType: 'application/json' }
  };
}

async function scrapeShopify(): Promise<CanonicalProduct> {
  const { engine } = engineWith(shopifyRoutes());
  const out = await engine.scrape({
    url: SHOPIFY_URL,
    projectId: 'p1',
    categoryId: 'c1',
    categoryPath: 'Apparel > Knitwear'
  });
  assert.ok(out.ok, `scrape failed: ${out.error}`);
  return out.product!;
}

/* ------------------------------------------------------------------ */
/* Shopify                                                             */
/* ------------------------------------------------------------------ */

test('Shopify: identifies the platform and the product', async () => {
  const p = await scrapeShopify();
  assert.equal(p.sourcePlatform, 'shopify');
  assert.equal(p.title, 'Atlas Merino Crew');
  assert.equal(p.handle, 'atlas-merino-crew');
  assert.equal(p.vendor, 'Atlas Supply');
  assert.equal(p.sourceProductId, '7712233445566');
  assert.equal(p.kind, 'variable');
  assert.equal(p.currency, 'GBP');
  assert.equal(p.status, 'active');
  assert.equal(p.published, true);
  assert.deepEqual(p.tags, ['merino', 'crew neck', 'core']);
});

test('Shopify: the configured category flows into the product, not the source type', async () => {
  const p = await scrapeShopify();
  assert.equal(p.categoryPath, 'Apparel > Knitwear');
  assert.equal(p.categoryId, 'c1');
  assert.equal(p.provenance['categoryPath'].source, 'user');
  // The store's own type is kept separately, never conflated.
  assert.equal(p.sourceProductType, 'Knitwear');
});

test('Shopify: cent prices are converted, never copied between variants', async () => {
  const p = await scrapeShopify();
  assert.equal(p.variants.length, 4);

  const blackS = variantByOptions(p.variants, 'Black', 'S')!;
  const blackM = variantByOptions(p.variants, 'Black', 'M')!;
  const oatS = variantByOptions(p.variants, 'Oatmeal', 'S')!;
  const oatM = variantByOptions(p.variants, 'Oatmeal', 'M')!;

  assert.equal(blackS.price, 95);
  assert.equal(blackM.price, 95);
  assert.equal(oatS.price, 115);
  assert.equal(oatM.price, 115);

  assert.equal(blackS.compareAtPrice, 120);
  assert.equal(oatS.compareAtPrice, 140);
  // The source gave this variant no compare-at price; nothing is invented.
  assert.equal(oatM.compareAtPrice, null);

  assert.equal(p.price, 95);
  assert.equal(p.priceMin, 95);
  assert.equal(p.priceMax, 115);
});

test('Shopify: SKU, barcode, stock and weight stay with their own variant', async () => {
  const p = await scrapeShopify();
  const blackS = variantByOptions(p.variants, 'Black', 'S')!;
  const blackM = variantByOptions(p.variants, 'Black', 'M')!;
  const oatS = variantByOptions(p.variants, 'Oatmeal', 'S')!;
  const oatM = variantByOptions(p.variants, 'Oatmeal', 'M')!;

  assert.equal(blackS.sku, 'ATL-CRW-BLK-S');
  assert.equal(blackM.sku, 'ATL-CRW-BLK-M');
  assert.equal(oatS.sku, 'ATL-CRW-OAT-S');
  assert.equal(oatM.sku, 'ATL-CRW-OAT-M');

  assert.equal(blackS.barcode, '5060123456789');
  assert.equal(oatM.barcode, null, 'an empty barcode string must not become a value');

  assert.equal(blackS.stockStatus, 'in_stock');
  assert.equal(blackM.stockStatus, 'out_of_stock');
  assert.equal(blackM.inventoryQuantity, 0);
  assert.equal(oatS.inventoryQuantity, 3);
  assert.equal(oatS.inventoryPolicy, 'continue');
  assert.equal(oatM.inventoryPolicy, 'deny');
  assert.equal(oatM.inventoryTracker, null);

  assert.equal(blackS.weight, 320);
  assert.equal(blackM.weight, 340);
  assert.equal(blackS.weightUnit, 'g');

  // The product aggregates without overwriting anything.
  assert.equal(p.stockStatus, 'in_stock');
});

test('Shopify: option axes come from the store, not from guesswork', async () => {
  const p = await scrapeShopify();
  assert.deepEqual(
    p.options.map((o) => o.name),
    ['Colour', 'Size']
  );
  assert.deepEqual(p.options[0].values, ['Black', 'Oatmeal']);
  const blackS = variantByOptions(p.variants, 'Black', 'S')!;
  assert.deepEqual(blackS.options, [
    { name: 'Colour', value: 'Black' },
    { name: 'Size', value: 'S' }
  ]);
});

test('Shopify: variant images are bound to the right variants and upsized', async () => {
  const p = await scrapeShopify();
  const blackS = variantByOptions(p.variants, 'Black', 'S')!;
  const oatS = variantByOptions(p.variants, 'Oatmeal', 'S')!;

  assert.match(blackS.imageUrl ?? '', /crew-black\.jpg$/, 'the _1024x1024 rendition should be upsized');
  assert.match(oatS.imageUrl ?? '', /crew-oatmeal\.jpg$/);
  assert.notEqual(blackS.imageUrl, oatS.imageUrl);

  // The source names its own featured image; we use that, not position 1.
  assert.match(p.featuredImageUrl ?? '', /crew-oatmeal\.jpg$/);
  assert.equal(p.provenance['featuredImageUrl'].confidence, 'high');

  const gallery = p.images.map((i) => i.url);
  assert.equal(new Set(gallery).size, gallery.length, 'no duplicate images');
  assert.ok(gallery.some((u) => /crew-detail\.jpg$/.test(u)));
  assert.ok(!gallery.some((u) => /\.mp4$/.test(u)), 'video media must not enter the image gallery');

  const black = p.images.find((i) => /crew-black\.jpg$/.test(i.url))!;
  assert.equal(black.alt, 'Atlas Merino Crew in black');
  assert.ok(black.variantIds.includes(blackS.id));
});

test('Shopify: the description keeps its structure and loses its scripts', async () => {
  const p = await scrapeShopify();
  const html = p.descriptionHtml ?? '';
  assert.match(html, /<h2>Everyday merino<\/h2>/);
  assert.match(html, /<strong>17\.5 micron<\/strong>/);
  assert.match(html, /<li>Machine washable<\/li>/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /track\(/);
  assert.match(p.descriptionText ?? '', /Machine washable/);
});

test('Shopify: SEO is read from the page and Merchant Center fields stay empty', async () => {
  const p = await scrapeShopify();
  assert.equal(p.seo.title, 'Atlas Merino Crew');
  assert.equal(p.seo.metaDescription, 'A soft everyday merino crew neck, knitted in Portugal.');
  assert.equal(p.seo.canonicalUrl, 'https://atlas-supply.myshopify.com/products/atlas-merino-crew');

  assert.equal(p.google.gtin, null);
  assert.equal(p.google.mpn, null);
  assert.equal(p.google.googleProductCategory, null);
  assert.equal(p.google.customLabel0, null);
  assert.equal(p.provenance['google.gtin'].source, 'unavailable');
  // Brand IS published, so it is captured.
  assert.equal(p.google.brand, 'Atlas Supply');
});

test('Shopify: stronger sources win, and the disagreement is recorded', async () => {
  const p = await scrapeShopify();
  // JSON-LD said the product SKU was "ATL-CRW"; the storefront JSON has no
  // product-level SKU but four variant SKUs, so the JSON-LD value survives.
  assert.equal(p.sku, 'ATL-CRW');
  assert.equal(p.provenance['sku'].source, 'jsonld');
  assert.equal(p.provenance['variants'].source, 'shopify-product-json');
  assert.equal(p.provenance['price'].source, 'shopify-product-json');
});

test('Shopify: no browser is opened for a page the JSON already answered', async () => {
  const { engine, fetcher } = engineWith(shopifyRoutes(), { browserRenderMode: 'auto' });
  const out = await engine.scrape({ url: SHOPIFY_URL, projectId: 'p1', categoryId: null, categoryPath: null });
  assert.ok(out.ok);
  assert.ok(!out.layers.some((l) => l.layer === 'browser-render'), 'should not escalate to the browser');
  assert.ok(fetcher.requested.includes(SHOPIFY_JS));
});

/* ------------------------------------------------------------------ */
/* WooCommerce                                                         */
/* ------------------------------------------------------------------ */

async function scrapeWoo(): Promise<CanonicalProduct> {
  const { engine } = engineWith({ [WOO_URL]: { body: fixture('woo-variable.html') } });
  const out = await engine.scrape({
    url: WOO_URL,
    projectId: 'p1',
    categoryId: 'c2',
    categoryPath: 'Office > Desks'
  });
  assert.ok(out.ok, `scrape failed: ${out.error}`);
  return out.product!;
}

test('WooCommerce: detects the platform without a Store API', async () => {
  const p = await scrapeWoo();
  assert.equal(p.sourcePlatform, 'woocommerce');
  assert.equal(p.title, 'Aster Standing Desk');
  assert.equal(p.sourceProductId, '4099');
  assert.equal(p.handle, 'aster-standing-desk');
  assert.equal(p.kind, 'variable');
  assert.equal(p.sku, 'DSK');
  assert.equal(p.categoryPath, 'Office > Desks');
});

test('WooCommerce: every variation keeps its own price, sale price and stock', async () => {
  const p = await scrapeWoo();
  assert.equal(p.variants.length, 3);

  const graM = variantByOptions(p.variants, 'graphite', 'medium')!;
  const graL = variantByOptions(p.variants, 'graphite', 'large')!;
  const oakM = variantByOptions(p.variants, 'oak', 'medium')!;

  assert.equal(graM.price, 249);
  assert.equal(graM.regularPrice, 299);
  assert.equal(graM.compareAtPrice, 299);
  assert.equal(graM.salePrice, 249);

  assert.equal(graL.price, 289);
  assert.equal(graL.regularPrice, 289);
  assert.equal(graL.compareAtPrice, null, 'not on sale, so no compare-at price is invented');
  assert.equal(graL.salePrice, null);

  assert.equal(oakM.price, 279);
  assert.equal(oakM.compareAtPrice, 329);

  assert.equal(graM.sku, 'DSK-GRA-M');
  assert.equal(graL.sku, 'DSK-GRA-L');
  assert.equal(oakM.sku, 'DSK-OAK-M');

  assert.equal(graM.stockStatus, 'in_stock');
  assert.equal(graM.inventoryQuantity, 8);
  assert.equal(graL.stockStatus, 'out_of_stock');
  assert.equal(oakM.stockStatus, 'on_backorder');
  assert.equal(oakM.backordersAllowed, true);
});

test('WooCommerce: variation weight, dimensions and images are per variation', async () => {
  const p = await scrapeWoo();
  const graM = variantByOptions(p.variants, 'graphite', 'medium')!;
  const graL = variantByOptions(p.variants, 'graphite', 'large')!;
  const oakM = variantByOptions(p.variants, 'oak', 'medium')!;

  assert.equal(graM.weight, 12.5);
  assert.equal(graM.weightUnit, 'kg');
  assert.equal(graL.weight, 15);
  assert.equal(graM.length, 120);
  assert.equal(graL.length, 160);

  assert.match(graM.imageUrl ?? '', /desk-graphite\.jpg$/);
  assert.match(oakM.imageUrl ?? '', /desk-oak\.jpg$/);
  assert.notEqual(graM.imageUrl, oakM.imageUrl);
  assert.equal(graM.imageUrl, graL.imageUrl, 'both graphite sizes share the graphite photo');
});

test('WooCommerce: attribute labels come from the theme, not the slug', async () => {
  const p = await scrapeWoo();
  assert.deepEqual(
    p.options.map((o) => o.name).sort(),
    ['Colour', 'Desk width']
  );
  const graM = variantByOptions(p.variants, 'graphite', 'medium')!;
  assert.deepEqual(graM.options.map((o) => o.name).sort(), ['Colour', 'Desk width']);
});

test('WooCommerce: additional-information table becomes attributes and dimensions', async () => {
  const p = await scrapeWoo();
  assert.equal(p.weight, 12.5);
  assert.equal(p.weightUnit, 'kg');
  assert.equal(p.length, 120);
  assert.equal(p.width, 60);
  assert.equal(p.height, 75);
  assert.equal(p.dimensionUnit, 'cm');
  assert.ok(p.attributes.some((a) => a.name === 'Frame material' && a.values.includes('Powder-coated steel')));
  assert.ok(!p.attributes.some((a) => a.name.toLowerCase() === 'weight'), 'weight is a field, not an attribute');
});

test('WooCommerce: gallery, description and tracking pixels', async () => {
  const p = await scrapeWoo();
  const gallery = p.images.map((i) => i.url);
  assert.ok(gallery.some((u) => /desk-graphite\.jpg$/.test(u)));
  assert.ok(gallery.some((u) => /desk-oak\.jpg$/.test(u)));
  assert.ok(!gallery.some((u) => /-600x600/.test(u)), 'resized renditions should be upgraded to the original');

  const html = p.descriptionHtml ?? '';
  assert.match(html, /62.?cm to 128.?cm/);
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /facebook\.com\/tr/);
  assert.match(p.shortDescriptionHtml ?? '', /<strong>25-year<\/strong>/);
});

test('WooCommerce: JSON-LD Merchant Center identifiers are captured when published', async () => {
  const p = await scrapeWoo();
  assert.equal(p.google.gtin, '4001234567890');
  assert.equal(p.google.mpn, 'AST-DESK-2024');
  assert.equal(p.google.brand, 'Aster');
  assert.equal(p.google.googleProductCategory, null, 'not published, so left blank');
  assert.equal(p.ratingValue, 4.6);
  assert.equal(p.reviewCount, 38);
  assert.equal(p.currency, 'EUR');
});

test('WooCommerce simple product: no phantom variants, stock read correctly', async () => {
  const { engine } = engineWith({ [WOO_SIMPLE_URL]: { body: fixture('woo-simple.html') } });
  const out = await engine.scrape({ url: WOO_SIMPLE_URL, projectId: 'p1', categoryId: null, categoryPath: 'Lighting' });
  assert.ok(out.ok, out.error ?? '');
  const p = out.product!;

  assert.equal(p.kind, 'simple');
  assert.equal(p.variants.length, 0);
  assert.equal(p.sku, 'LMP-CU-01');
  assert.equal(p.price, 89);
  assert.equal(p.currency, 'EUR');
  assert.equal(p.stockStatus, 'out_of_stock');
  assert.equal(p.google.condition, 'new');
  assert.equal(p.images.length, 1, 'the WooCommerce placeholder image must be dropped');
  assert.match(p.images[0].url, /lamp\.jpg$/);
});

/* ------------------------------------------------------------------ */
/* schema.org ProductGroup                                             */
/* ------------------------------------------------------------------ */

test('JSON-LD ProductGroup: hasVariant becomes real variants', async () => {
  const { engine } = engineWith({ [GROUP_URL]: { body: fixture('group-jsonld.html') } });
  const out = await engine.scrape({ url: GROUP_URL, projectId: 'p1', categoryId: null, categoryPath: 'Kitchen' });
  assert.ok(out.ok, out.error ?? '');
  const p = out.product!;

  assert.equal(p.kind, 'variable');
  assert.equal(p.variants.length, 2);
  const sand = variantByOptions(p.variants, 'Sand')!;
  const slate = variantByOptions(p.variants, 'Slate')!;
  assert.equal(sand.price, 18);
  assert.equal(slate.price, 21.5);
  assert.equal(sand.sku, 'MUG-SAND');
  assert.equal(slate.sku, 'MUG-SLATE');
  assert.equal(sand.stockStatus, 'in_stock');
  assert.equal(slate.stockStatus, 'out_of_stock');
  assert.match(sand.imageUrl ?? '', /mug-sand\.jpg$/);
  assert.match(slate.imageUrl ?? '', /mug-slate\.jpg$/);
  assert.deepEqual(p.options.map((o) => o.name), ['Color']);
});

/* ------------------------------------------------------------------ */
/* Failure handling                                                    */
/* ------------------------------------------------------------------ */

test('a 404 is reported in plain English, not as a stack trace', async () => {
  const { engine } = engineWith({});
  const out = await engine.scrape({ url: 'https://shop.example.com/product/gone/', projectId: 'p1', categoryId: null, categoryPath: null });
  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'NOT_FOUND');
  assert.match(out.error ?? '', /does not exist/i);
  assert.doesNotMatch(out.error ?? '', /Error:|at \w+\./);
});

test('a page with no product is refused rather than half-imported', async () => {
  const { engine } = engineWith({
    'https://shop.example.com/about': { body: '<!doctype html><html><head><title>About us</title></head><body><p>We started in 1998.</p></body></html>' }
  });
  const out = await engine.scrape({ url: 'https://shop.example.com/about', projectId: 'p1', categoryId: null, categoryPath: null });
  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'NO_PRODUCT');
});

test('robots.txt disallow stops the scrape and says so', async () => {
  const { engine } = engineWith(shopifyRoutes());
  const blocking = {
    async get() {
      throw new Error('should not be reached');
    },
    async probe() {
      return { ok: false, status: 0, contentType: '' };
    },
    async isAllowed() {
      return { allowed: false, reason: 'https://shop.example.com/robots.txt disallows /product/' };
    },
    clearCache() {}
  };
  const { ScrapeEngine } = await import('../src/main/scraper/engine.js');
  const { testSettings } = await import('./helpers.js');
  const e = new ScrapeEngine(blocking, testSettings({ respectRobotsTxt: true }));
  const out = await e.scrape({ url: 'https://shop.example.com/product/x/', projectId: 'p1', categoryId: null, categoryPath: null });
  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'ROBOTS_DISALLOW');
  assert.match(out.error ?? '', /robots\.txt/);
});

test('re-scraping keeps the same product id', async () => {
  const { engine } = engineWith(shopifyRoutes());
  const first = await engine.scrape({ url: SHOPIFY_URL, projectId: 'p1', categoryId: null, categoryPath: null });
  const again = await engine.scrape({
    url: SHOPIFY_URL,
    projectId: 'p1',
    categoryId: null,
    categoryPath: null,
    existingProductId: first.product!.id
  });
  assert.equal(again.product!.id, first.product!.id);
});
