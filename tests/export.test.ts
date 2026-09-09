import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineWith, fixture } from './helpers';
import { buildExport, parseCsv, toCsv } from '../src/main/export';
import { escapeCsvValue } from '../src/main/export/csv';
import { validateProducts } from '../src/main/validation/engine';
import type { CanonicalProduct } from '../src/shared/canonical';
import type { ExportOptions } from '../src/shared/types';

const SHOPIFY_URL = 'https://atlas-supply.myshopify.com/products/atlas-merino-crew';
const SHOPIFY_JS = 'https://atlas-supply.myshopify.com/products/atlas-merino-crew.js';
const WOO_URL = 'https://shop.example.com/product/aster-standing-desk/';
const WOO_SIMPLE_URL = 'https://shop.example.com/product/copper-desk-lamp/';

async function getProducts(): Promise<CanonicalProduct[]> {
  const { engine } = engineWith({
    [SHOPIFY_URL]: { body: fixture('shopify-variable.html') },
    [SHOPIFY_JS]: { body: fixture('shopify-product.js.json'), contentType: 'application/json' },
    [WOO_URL]: { body: fixture('woo-variable.html') },
    [WOO_SIMPLE_URL]: { body: fixture('woo-simple.html') }
  });
  const a = await engine.scrape({ url: SHOPIFY_URL, projectId: 'p1', categoryId: 'c1', categoryPath: 'Apparel > Knitwear' });
  const b = await engine.scrape({ url: WOO_URL, projectId: 'p1', categoryId: 'c2', categoryPath: 'Office > Desks' });
  const c = await engine.scrape({ url: WOO_SIMPLE_URL, projectId: 'p1', categoryId: 'c3', categoryPath: 'Office > Lighting' });
  return [a.product!, b.product!, c.product!];
}

function opts(patch: Partial<ExportOptions> = {}): ExportOptions {
  return {
    projectId: 'p1',
    format: 'shopify',
    profileId: 'shopify-legacy',
    categoryIds: null,
    productIds: null,
    includeWarnings: true,
    includeErrors: true,
    excludeFailed: true,
    outputDir: null,
    fileName: null,
    ...patch
  };
}

/* ------------------------------------------------------------------ */
/* CSV mechanics                                                       */
/* ------------------------------------------------------------------ */

test('CSV escaping handles quotes, commas, newlines and formula injection', () => {
  assert.equal(escapeCsvValue('plain'), 'plain');
  assert.equal(escapeCsvValue('a,b'), '"a,b"');
  assert.equal(escapeCsvValue('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvValue('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCsvValue(' padded '), '" padded "');
  assert.equal(escapeCsvValue('=1+1'), "'=1+1");
  assert.equal(escapeCsvValue('-lead'), "'-lead");
  assert.equal(escapeCsvValue(null), '');
});

test('CSV round-trips a description containing markup and newlines', () => {
  const csv = toCsv(['A', 'B'], [['<p>Hi, "there"</p>\n<ul><li>x</li></ul>', '2']]);
  const rows = parseCsv(csv);
  assert.equal(rows[0][0], 'A');
  assert.equal(rows[1][0], '<p>Hi, "there"</p>\n<ul><li>x</li></ul>');
  assert.equal(rows[1][1], '2');
});

/* ------------------------------------------------------------------ */
/* Shopify adapter                                                     */
/* ------------------------------------------------------------------ */

test('Shopify export: variants share one handle and only the first row carries product fields', async () => {
  const products = await getProducts();
  const built = buildExport(products, [], opts({ productIds: [products[0].id] }));
  const H = (name: string) => built.headers.indexOf(name);
  assert.ok(H('Handle') >= 0 && H('Variant Price') >= 0);

  const rows = built.rows;
  assert.equal(rows.length, 4, 'four variants, three images — no extra image rows needed');
  assert.ok(rows.every((r) => r[H('Handle')] === 'atlas-merino-crew'));

  assert.equal(rows[0][H('Title')], 'Atlas Merino Crew');
  assert.equal(rows[1][H('Title')], '', 'later rows must leave product fields blank');
  assert.equal(rows[0][H('Option1 Name')], 'Colour');
  assert.equal(rows[0][H('Option2 Name')], 'Size');
  assert.equal(rows[1][H('Option1 Name')], '');
});

test('Shopify export: each row keeps its own variant values', async () => {
  const products = await getProducts();
  const built = buildExport(products, [], opts({ productIds: [products[0].id] }));
  const H = (n: string) => built.headers.indexOf(n);

  const byCombo = new Map(built.rows.map((r) => [`${r[H('Option1 Value')]}/${r[H('Option2 Value')]}`, r]));
  const blackS = byCombo.get('Black/S')!;
  const oatS = byCombo.get('Oatmeal/S')!;
  const oatM = byCombo.get('Oatmeal/M')!;
  const blackM = byCombo.get('Black/M')!;

  assert.equal(blackS[H('Variant Price')], '95.00');
  assert.equal(oatS[H('Variant Price')], '115.00');
  assert.equal(blackS[H('Variant Compare At Price')], '120.00');
  assert.equal(oatS[H('Variant Compare At Price')], '140.00');
  assert.equal(oatM[H('Variant Compare At Price')], '', 'blank stays blank');

  assert.equal(blackS[H('Variant SKU')], 'ATL-CRW-BLK-S');
  assert.equal(oatM[H('Variant SKU')], 'ATL-CRW-OAT-M');
  assert.equal(blackS[H('Variant Grams')], '320');
  assert.equal(blackM[H('Variant Grams')], '340');
  assert.equal(blackM[H('Variant Inventory Qty')], '0');
  assert.equal(blackM[H('Variant Inventory Policy')], 'deny');
  assert.equal(oatS[H('Variant Inventory Policy')], 'continue');
  assert.equal(blackS[H('Variant Barcode')], '5060123456789');
  assert.equal(oatM[H('Variant Barcode')], '');
  assert.match(blackS[H('Variant Image')], /crew-black\.jpg$/);
  assert.match(oatS[H('Variant Image')], /crew-oatmeal\.jpg$/);
});

test('Shopify export: the app category lands in Product Category and Type', async () => {
  const products = await getProducts();
  const built = buildExport(products, [], opts({ productIds: [products[0].id] }));
  const H = (n: string) => built.headers.indexOf(n);
  assert.equal(built.rows[0][H('Product Category')], 'Apparel > Knitwear');
  assert.equal(built.rows[0][H('Type')], 'Apparel > Knitwear');
});

test('Shopify export: the featured image is row 1 and every gallery image appears once', async () => {
  const products = await getProducts();
  const built = buildExport(products, [], opts({ productIds: [products[0].id] }));
  const H = (n: string) => built.headers.indexOf(n);
  assert.match(built.rows[0][H('Image Src')], /crew-oatmeal\.jpg$/, 'featured image must come first');
  assert.equal(built.rows[0][H('Image Position')], '1');

  const srcs = built.rows.map((r) => r[H('Image Src')]).filter(Boolean);
  assert.equal(new Set(srcs).size, srcs.length);
  assert.equal(srcs.length, products[0].images.length);
});

test('Shopify export: Merchant Center columns stay empty when the source had nothing', async () => {
  const products = await getProducts();
  const built = buildExport(products, [], opts({ productIds: [products[0].id] }));
  const H = (n: string) => built.headers.indexOf(n);
  assert.equal(built.rows[0][H('Google Shopping / MPN')], '');
  assert.equal(built.rows[0][H('Google Shopping / Google Product Category')], '');
  assert.equal(built.rows[0][H('Google Shopping / Custom Label 0')], '');
  assert.equal(built.rows[0][H('SEO Title')], 'Atlas Merino Crew');
});

test('Shopify export: a simple product produces exactly one row', async () => {
  const products = await getProducts();
  const built = buildExport(products, [], opts({ productIds: [products[2].id] }));
  const H = (n: string) => built.headers.indexOf(n);
  assert.equal(built.rows.length, 1);
  assert.equal(built.rows[0][H('Option1 Name')], 'Title');
  assert.equal(built.rows[0][H('Option1 Value')], 'Default Title');
  assert.equal(built.rows[0][H('Variant Price')], '89.00');
  assert.equal(built.rows[0][H('Variant SKU')], 'LMP-CU-01');
});

test('Shopify export: the modern profile emits the current header names', async () => {
  const products = await getProducts();
  const built = buildExport(products, [], opts({ profileId: 'shopify-2024', productIds: [products[0].id] }));
  assert.ok(built.headers.includes('URL handle'));
  assert.ok(built.headers.includes('Compare-at price'));
  assert.ok(built.headers.includes('Continue selling when out of stock'));
  assert.ok(!built.headers.includes('Body (HTML)'));
  const H = (n: string) => built.headers.indexOf(n);
  assert.equal(built.rows[0][H('URL handle')], 'atlas-merino-crew');
  assert.equal(built.rows[0][H('Status')], 'active');
});

/* ------------------------------------------------------------------ */
/* WooCommerce adapter                                                 */
/* ------------------------------------------------------------------ */

test('WooCommerce export: a variable product becomes a parent row plus variation rows', async () => {
  const products = await getProducts();
  const built = buildExport(products, [], opts({ format: 'woocommerce', profileId: 'woocommerce-default', productIds: [products[1].id] }));
  const H = (n: string) => built.headers.indexOf(n);

  assert.equal(built.rows.length, 4, '1 parent + 3 variations');
  const parent = built.rows[0];
  const variations = built.rows.slice(1);

  assert.equal(parent[H('Type')], 'variable');
  assert.equal(parent[H('SKU')], 'DSK');
  assert.equal(parent[H('Name')], 'Aster Standing Desk');
  assert.equal(parent[H('Regular price')], '', 'a variable parent carries no price of its own');
  assert.equal(parent[H('Categories')], 'Office > Desks');

  assert.ok(variations.every((r) => r[H('Type')] === 'variation'));
  assert.ok(variations.every((r) => r[H('Parent')] === 'DSK'), 'every variation must point at its parent');
  assert.ok(variations.every((r) => r[H('Name')].startsWith('Aster Standing Desk - ')));
});

test('WooCommerce export: variation rows carry their own price, stock, weight and image', async () => {
  const products = await getProducts();
  const built = buildExport(products, [], opts({ format: 'woocommerce', profileId: 'woocommerce-default', productIds: [products[1].id] }));
  const H = (n: string) => built.headers.indexOf(n);
  const bySku = new Map(built.rows.map((r) => [r[H('SKU')], r]));

  const graM = bySku.get('DSK-GRA-M')!;
  const graL = bySku.get('DSK-GRA-L')!;
  const oakM = bySku.get('DSK-OAK-M')!;

  assert.equal(graM[H('Regular price')], '299');
  assert.equal(graM[H('Sale price')], '249');
  assert.equal(graL[H('Regular price')], '289');
  assert.equal(graL[H('Sale price')], '', 'not on sale');
  assert.equal(oakM[H('Regular price')], '329');
  assert.equal(oakM[H('Sale price')], '279');

  assert.equal(graM[H('In stock?')], '1');
  assert.equal(graM[H('Stock')], '8');
  assert.equal(graL[H('In stock?')], '0');
  assert.equal(oakM[H('Backorders allowed?')], '1');

  assert.equal(graM[H('Weight (kg)')], '12.5');
  assert.equal(graL[H('Weight (kg)')], '15');
  assert.equal(graM[H('Length (cm)')], '120');
  assert.equal(graL[H('Length (cm)')], '160');

  assert.match(graM[H('Images')], /desk-graphite\.jpg$/);
  assert.match(oakM[H('Images')], /desk-oak\.jpg$/);
});

test('WooCommerce export: attributes are numbered, and a variation names only its own value', async () => {
  const products = await getProducts();
  const built = buildExport(products, [], opts({ format: 'woocommerce', profileId: 'woocommerce-default', productIds: [products[1].id] }));
  const H = (n: string) => built.headers.indexOf(n);
  assert.ok(built.headers.includes('Attribute 1 name'));
  assert.ok(built.headers.includes('Attribute 1 value(s)'));
  assert.ok(built.headers.includes('Attribute 1 visible'));
  assert.ok(built.headers.includes('Attribute 1 global'));
  assert.ok(built.headers.includes('Attribute 1 default'));

  const parent = built.rows[0];
  const names = [parent[H('Attribute 1 name')], parent[H('Attribute 2 name')]];
  assert.deepEqual([...names].sort(), ['Colour', 'Desk width']);
  assert.match(parent[H('Attribute 1 value(s)')], /,/, 'the parent lists every value');

  const bySku = new Map(built.rows.map((r) => [r[H('SKU')], r]));
  const graM = bySku.get('DSK-GRA-M')!;
  const colourCol = names[0] === 'Colour' ? 'Attribute 1 value(s)' : 'Attribute 2 value(s)';
  assert.equal(graM[H(colourCol)], 'graphite');
  assert.doesNotMatch(graM[H(colourCol)], /,/);
});

test('WooCommerce export: a parent without a SKU gets a disclosed grouping key', async () => {
  const products = await getProducts();
  const clone: CanonicalProduct = JSON.parse(JSON.stringify(products[1]));
  clone.sku = null;
  const built = buildExport([clone], [], opts({ format: 'woocommerce', profileId: 'woocommerce-default' }));
  const H = (n: string) => built.headers.indexOf(n);
  const key = built.rows[0][H('SKU')];
  assert.equal(key, 'aster-standing-desk');
  assert.ok(built.rows.slice(1).every((r) => r[H('Parent')] === key));
  assert.match(built.notes.join(' '), /grouping key/i);
});

test('WooCommerce export: a simple product is one row typed "simple"', async () => {
  const products = await getProducts();
  const built = buildExport(products, [], opts({ format: 'woocommerce', profileId: 'woocommerce-default', productIds: [products[2].id] }));
  const H = (n: string) => built.headers.indexOf(n);
  assert.equal(built.rows.length, 1);
  assert.equal(built.rows[0][H('Type')], 'simple');
  assert.equal(built.rows[0][H('Regular price')], '89');
  assert.equal(built.rows[0][H('In stock?')], '0');
  assert.equal(built.rows[0][H('Parent')], '');
});

test('the same canonical product exports to both formats without re-scraping', async () => {
  const products = await getProducts();
  const shop = buildExport(products, [], opts({ productIds: [products[1].id] }));
  const woo = buildExport(products, [], opts({ format: 'woocommerce', profileId: 'woocommerce-default', productIds: [products[1].id] }));
  const priceShop = shop.rows.map((r) => r[shop.headers.indexOf('Variant Price')]).filter(Boolean).sort();
  const priceWoo = woo.rows
    .slice(1)
    .map((r) => r[woo.headers.indexOf('Sale price')] || r[woo.headers.indexOf('Regular price')])
    .sort();
  assert.deepEqual(priceShop, ['249.00', '279.00', '289.00']);
  assert.deepEqual(priceWoo, ['249', '279', '289']);
});

/* ------------------------------------------------------------------ */
/* Export gating                                                       */
/* ------------------------------------------------------------------ */

test('products with a critical issue are never written, whatever the options say', async () => {
  const products = await getProducts();
  const broken: CanonicalProduct = JSON.parse(JSON.stringify(products[1]));
  broken.variants[0].parentProductId = 'someone-else';
  const { issues } = validateProducts('p1', [broken], 'woocommerce');
  assert.ok(issues.some((i) => i.severity === 'CRITICAL'));

  const built = buildExport([broken], issues, opts({ format: 'woocommerce', profileId: 'woocommerce-default', includeErrors: true, includeWarnings: true }));
  assert.equal(built.rows.length, 0);
  assert.equal(built.skipped.length, 1);
  assert.match(built.skipped[0].reason, /critical/i);
});

test('warning-level products are held back unless the operator opts in', async () => {
  const products = await getProducts();
  const p: CanonicalProduct = JSON.parse(JSON.stringify(products[2]));
  p.categoryPath = null; // raises a WARNING
  const { issues } = validateProducts('p1', [p], 'shopify');

  const strict = buildExport([p], issues, opts({ includeWarnings: false, includeErrors: false }));
  assert.equal(strict.rows.length, 0);
  assert.match(strict.skipped[0].reason, /warnings/i);

  const relaxed = buildExport([p], issues, opts({ includeWarnings: true }));
  assert.equal(relaxed.rows.length, 1);
});

test('exporting one category selects only that category', async () => {
  const products = await getProducts();
  const built = buildExport(products, [], opts({ categoryIds: ['c2'], format: 'woocommerce', profileId: 'woocommerce-default' }));
  const H = (n: string) => built.headers.indexOf(n);
  assert.ok(built.rows.every((r) => r[H('Categories')] === 'Office > Desks' || r[H('Type')] === 'variation'));
  assert.equal(built.included.length, 1);
});
