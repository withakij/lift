import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineWith, fixture } from './helpers';
import { validateProducts } from '../src/main/validation/engine';
import type { CanonicalProduct } from '../src/shared/canonical';
import type { Severity } from '../src/shared/types';

const SHOPIFY_URL = 'https://atlas-supply.myshopify.com/products/atlas-merino-crew';
const SHOPIFY_JS = 'https://atlas-supply.myshopify.com/products/atlas-merino-crew.js';
const WOO_URL = 'https://shop.example.com/product/aster-standing-desk/';

async function goodProducts(): Promise<CanonicalProduct[]> {
  const { engine } = engineWith({
    [SHOPIFY_URL]: { body: fixture('shopify-variable.html') },
    [SHOPIFY_JS]: { body: fixture('shopify-product.js.json'), contentType: 'application/json' },
    [WOO_URL]: { body: fixture('woo-variable.html') }
  });
  const a = await engine.scrape({ url: SHOPIFY_URL, projectId: 'p1', categoryId: 'c1', categoryPath: 'Knitwear' });
  const b = await engine.scrape({ url: WOO_URL, projectId: 'p1', categoryId: 'c2', categoryPath: 'Desks' });
  return [a.product!, b.product!];
}

function clone(p: CanonicalProduct): CanonicalProduct {
  return JSON.parse(JSON.stringify(p));
}

function severities(issues: Array<{ severity: Severity }>): Severity[] {
  return [...new Set(issues.map((i) => i.severity))];
}

function find<T extends { ruleId: string; message: string }>(issues: T[], rule: string, pattern: RegExp): T | undefined {
  return issues.find((i) => i.ruleId === rule && pattern.test(i.message));
}

test('clean products raise nothing above INFO', async () => {
  const products = await goodProducts();
  const { issues, summary } = validateProducts('p1', products, 'shopify');
  const bad = issues.filter((i) => i.severity !== 'INFO');
  assert.deepEqual(
    bad.map((i) => `${i.severity}: ${i.message}`),
    [],
    'well-formed fixtures should produce no warnings or errors'
  );
  assert.equal(summary.blockingExport, 0);
  assert.equal(summary.productCount, 2);
});

test('missing essentials are graded by how badly they break an import', async () => {
  const [p] = await goodProducts();
  const broken = clone(p);
  broken.title = null;
  broken.price = null;
  broken.priceMin = null;
  broken.variants.forEach((v) => (v.price = null));
  broken.images = [];
  broken.featuredImageUrl = null;
  broken.categoryPath = null;

  const { issues } = validateProducts('p1', [broken], 'shopify');
  assert.ok(find(issues, 'required-fields', /no title/i)?.severity === 'CRITICAL');
  assert.ok(find(issues, 'required-fields', /no price could be found/i)?.severity === 'ERROR');
  assert.ok(find(issues, 'required-fields', /no product images/i)?.severity === 'WARNING');
  assert.ok(find(issues, 'required-fields', /not assigned to a category/i)?.severity === 'WARNING');
});

test('a SKU shared by two option combinations is CRITICAL', async () => {
  const [p] = await goodProducts();
  const bad = clone(p);
  bad.variants[1].sku = bad.variants[0].sku;
  const { issues } = validateProducts('p1', [bad], 'shopify');
  const issue = find(issues, 'variant-integrity', /used by two different option combinations/i);
  assert.ok(issue, 'must flag the duplicate SKU');
  assert.equal(issue!.severity, 'CRITICAL');
  assert.match(issue!.message, /Black \/ S/);
  assert.match(issue!.message, /Black \/ M/);
});

test('two variants with the same option combination are an ERROR', async () => {
  const [p] = await goodProducts();
  const bad = clone(p);
  bad.variants[1].options = [...bad.variants[0].options];
  const { issues } = validateProducts('p1', [bad], 'shopify');
  const issue = find(issues, 'variant-integrity', /share the same option combination/i);
  assert.ok(issue);
  assert.equal(issue!.severity, 'ERROR');
});

test('a variant missing an option axis is caught', async () => {
  const [p] = await goodProducts();
  const bad = clone(p);
  bad.variants[2].options = bad.variants[2].options.filter((o) => o.name !== 'Size');
  const { issues } = validateProducts('p1', [bad], 'shopify');
  const issue = find(issues, 'variant-integrity', /missing a value for size/i);
  assert.ok(issue);
  assert.equal(issue!.severity, 'ERROR');
});

test('a variant pointing at a different parent is CRITICAL and blocks export', async () => {
  const [p] = await goodProducts();
  const bad = clone(p);
  bad.variants[0].parentProductId = 'other-product';
  const { issues, summary } = validateProducts('p1', [bad], 'shopify');
  assert.ok(find(issues, 'variant-integrity', /not linked to this product/i));
  assert.ok(find(issues, 'orphan-variants', /parent product that does not exist/i));
  assert.ok(summary.blockingExport > 0);
});

test('identical price and SKU across many variants is called out', async () => {
  const [p] = await goodProducts();
  const bad = clone(p);
  bad.variants.forEach((v) => {
    v.price = 95;
    v.sku = 'SAME';
  });
  const { issues } = validateProducts('p1', [bad], 'shopify');
  assert.ok(find(issues, 'variant-integrity', /same price and the same SKU/i));
});

test('mixed currencies are an ERROR', async () => {
  const [p] = await goodProducts();
  const bad = clone(p);
  bad.variants[0].currency = 'USD';
  bad.variants[1].currency = 'EUR';
  const { issues } = validateProducts('p1', [bad], 'shopify');
  const issue = find(issues, 'price-consistency', /more than one currency/i);
  assert.ok(issue);
  assert.equal(issue!.severity, 'ERROR');
});

test('a compare-at price below the price is flagged, not silently exported', async () => {
  const [p] = await goodProducts();
  const bad = clone(p);
  bad.variants[0].compareAtPrice = 10;
  const { issues } = validateProducts('p1', [bad], 'shopify');
  assert.ok(find(issues, 'variant-integrity', /not higher than its price/i));
});

test('a variant image outside the gallery is flagged for review', async () => {
  const [p] = await goodProducts();
  const bad = clone(p);
  bad.variants[0].imageUrl = 'https://cdn.example.com/somewhere-else.jpg';
  const { issues } = validateProducts('p1', [bad], 'shopify');
  const issue = find(issues, 'variant-images', /not in the product gallery/i);
  assert.ok(issue);
  assert.equal(issue!.severity, 'WARNING');
});

test('every variant sharing one image is flagged', async () => {
  const [p] = await goodProducts();
  const bad = clone(p);
  bad.variants.forEach((v) => (v.imageUrl = bad.images[0].url));
  const { issues } = validateProducts('p1', [bad], 'shopify');
  assert.ok(find(issues, 'variant-images', /same image/i));
});

test('duplicate URLs, handles and SKUs across products are caught', async () => {
  const [p] = await goodProducts();
  const a = clone(p);
  const b = clone(p);
  b.id = 'second';
  b.variants.forEach((v, i) => (v.id = `v${i}-b`));
  const { issues } = validateProducts('p1', [a, b], 'shopify');

  assert.ok(find(issues, 'duplicates', /same address/i));
  assert.ok(find(issues, 'duplicates', /uses the handle/i));
  const skuIssue = find(issues, 'duplicates', /also used by a different product/i);
  assert.ok(skuIssue);
  assert.equal(skuIssue!.severity, 'ERROR');
});

test('a Shopify handle clash is an ERROR because Shopify would merge the rows', async () => {
  const [p] = await goodProducts();
  const a = clone(p);
  const b = clone(p);
  b.id = 'second';
  b.sourceUrl = 'https://atlas-supply.myshopify.com/products/other';
  b.variants.forEach((v, i) => {
    v.id = `x${i}`;
    v.sku = `OTHER-${i}`;
  });
  const shopify = validateProducts('p1', [a, b], 'shopify').issues;
  const woo = validateProducts('p1', [a, b], 'woocommerce').issues;
  assert.equal(find(shopify, 'duplicates', /uses the handle/i)?.severity, 'ERROR');
  assert.equal(find(woo, 'duplicates', /uses the handle/i)?.severity, 'WARNING');
});

test('implausible stock and script-like descriptions are reported', async () => {
  const [p] = await goodProducts();
  const bad = clone(p);
  bad.variants[0].inventoryQuantity = 9_999_999;
  bad.descriptionHtml = '<p onerror="x()">hi</p>';
  const { issues } = validateProducts('p1', [bad], 'shopify');
  assert.ok(find(issues, 'variant-integrity', /implausible stock/i));
  assert.ok(find(issues, 'description-html', /script-like/i));
});

test('missing Merchant Center identifiers are INFO and say they were not invented', async () => {
  const [p] = await goodProducts();
  const { issues } = validateProducts('p1', [p], 'shopify');
  const issue = find(issues, 'google-shopping', /did not publish/i);
  assert.ok(issue);
  assert.equal(issue!.severity, 'INFO');
  assert.match(issue!.message, /left empty rather than guessed/i);
});

test('an invalid image address is an ERROR', async () => {
  const [p] = await goodProducts();
  const bad = clone(p);
  bad.images[0].url = 'not-a-url';
  const { issues } = validateProducts('p1', [bad], 'shopify');
  const issue = find(issues, 'urls', /address the store will not accept/i);
  assert.ok(issue);
  assert.equal(issue!.severity, 'ERROR');
});

test('a variable product with one variant is an ERROR', async () => {
  const [p] = await goodProducts();
  const bad = clone(p);
  bad.variants = [bad.variants[0]];
  const { issues } = validateProducts('p1', [bad], 'shopify');
  assert.ok(find(issues, 'product-type', /fewer than two variants/i));
});

test('a broken rule cannot abort the whole validation run', async () => {
  const [p] = await goodProducts();
  const bad = clone(p);
  // Deliberately corrupt a shape a rule reads.
  (bad as unknown as { options: unknown }).options = null;
  const { issues } = validateProducts('p1', [bad], 'shopify');
  assert.ok(issues.length > 0, 'other rules must still have run');
  assert.ok(severities(issues).length > 0);
});

test('issue text is written for a person, not a developer', async () => {
  const [p] = await goodProducts();
  const bad = clone(p);
  bad.variants[0].price = null;
  const { issues } = validateProducts('p1', [bad], 'shopify');
  for (const i of issues) {
    assert.doesNotMatch(i.message, /undefined|NaN|\[object|Exception|null\b.*\bat\b/i, `unfriendly text: ${i.message}`);
    assert.ok(i.message.length > 10);
    assert.ok(/[.!?]$/.test(i.message), `should read as a sentence: ${i.message}`);
  }
});
