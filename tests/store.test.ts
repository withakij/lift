import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Collection, DocStore, newId } from '../src/main/db/store';
import { Database } from '../src/main/db';
import { ScrapeQueue } from '../src/main/queue';
import { engineWith, fixture } from './helpers';
import { coerceUrl, imageIdentity, normalizeUrl, upscaleShopifyImage, upscaleWordpressImage } from '../src/main/util/url';
import { parseRobots } from '../src/main/scraper/fetcher';
import { currencyFrom, parseMoney } from '../src/main/scraper/merge';
import { sanitiseDescription } from '../src/main/scraper/html';
import { humanizeError } from '../src/main/util/logger';
import type { CanonicalProduct } from '../src/shared/canonical';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'toto-test-'));
}

/** Databases opened by the test currently running, closed in its finally. */
const opened: Database[] = [];

function openDb(dir: string): Database {
  const db = new Database(dir);
  opened.push(db);
  return db;
}

function closeAll(): void {
  while (opened.length) {
    const db = opened.pop()!;
    db.flushAllSync();
    db.close();
  }
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

test('a collection survives a restart and keeps its records', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'items.json');
    const c1 = new Collection<{ id: string; n: number }>(file);
    c1.insert({ id: 'a', n: 1 });
    c1.insert({ id: 'b', n: 2 });
    c1.update('a', { n: 10 });
    c1.flushSync();

    const c2 = new Collection<{ id: string; n: number }>(file);
    assert.equal(c2.count(), 2);
    assert.equal(c2.get('a')!.n, 10);
    assert.equal(c2.get('b')!.n, 2);
    c1.close();
    c2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a truncated data file falls back to the last good backup', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'items.json');
    const c1 = new Collection<{ id: string; n: number }>(file);
    c1.insert({ id: 'a', n: 1 });
    c1.flushSync();
    c1.insert({ id: 'b', n: 2 });
    c1.flushSync(); // writes items.json and keeps items.json.bak

    assert.ok(existsSync(`${file}.bak`));
    writeFileSync(file, '[{"id":"a", tru'); // simulate an interrupted write

    const recovered = new Collection<{ id: string; n: number }>(file);
    assert.ok(recovered.count() >= 1, 'must recover something rather than losing everything');
    assert.ok(recovered.get('a'));
    c1.close();
    recovered.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the document store writes one file per record and indexes them', () => {
  const dir = tmp();
  try {
    interface Doc {
      id: string;
      title: string;
      body: string;
    }
    const store = new DocStore<Doc, { id: string; title: string }>(dir, (d) => ({ id: d.id, title: d.title }));
    store.put({ id: 'x', title: 'One', body: 'a'.repeat(5000) });
    store.put({ id: 'y', title: 'Two', body: 'b' });
    store.flushSync();

    assert.equal(store.count(), 2);
    assert.equal(store.get('x')!.body.length, 5000);
    assert.deepEqual(store.indexAll().map((e) => e.title).sort(), ['One', 'Two']);

    store.put({ id: 'x', title: 'One updated', body: 'c' });
    assert.equal(store.indexOf('x')!.title, 'One updated');
    assert.equal(store.get('x')!.body, 'c');

    store.remove('y');
    assert.equal(store.count(), 1);
    assert.equal(store.get('y'), null);

    store.flushSync();
    const reopened = new DocStore<Doc, { id: string; title: string }>(dir, (d) => ({ id: d.id, title: d.title }));
    assert.equal(reopened.count(), 1);
    assert.equal(reopened.get('x')!.title, 'One updated');
    store.close();
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting a project removes everything that belonged to it', () => {
  const dir = tmp();
  try {
    const db = openDb(dir);
    const p = db.createProject({ name: 'Migration', targetFormat: 'shopify' });
    const c = db.createCategory({ projectId: p.id, name: 'Monitors' });
    db.addUrl(p.id, c.id, 'https://a.com/p/1', 'https://a.com/p/1');
    db.addUrl(p.id, c.id, 'https://a.com/p/2', 'https://a.com/p/2');

    const other = db.createProject({ name: 'Other', targetFormat: 'woocommerce' });
    db.addUrl(other.id, null, 'https://b.com/p/1', 'https://b.com/p/1');

    assert.equal(db.urls.count(), 3);
    db.deleteProject(p.id);
    assert.equal(db.projects.count(), 1);
    assert.equal(db.categories.count(), 0);
    assert.equal(db.urls.count(), 1);
    assert.equal(db.urls.all()[0].projectId, other.id);
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate URLs are rejected per project, ignoring tracking parameters', () => {
  const dir = tmp();
  try {
    const db = openDb(dir);
    const p = db.createProject({ name: 'P', targetFormat: 'shopify' });
    const a = db.addUrl(p.id, null, 'x', 'https://shop.com/products/x?utm_source=news');
    const b = db.addUrl(p.id, null, 'x', 'https://www.shop.com/products/x/');
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(db.urls.count(), 1);

    const q = db.createProject({ name: 'Q', targetFormat: 'shopify' });
    const c = db.addUrl(q.id, null, 'x', 'https://shop.com/products/x');
    assert.equal(c.duplicate, false, 'the same URL is allowed in a different project');
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings persist across restarts', () => {
  const dir = tmp();
  try {
    const db = openDb(dir);
    db.setSettings({ perHostDelayMs: 5000, advancedMode: true });
    const again = openDb(dir);
    assert.equal(again.getSettings().perHostDelayMs, 5000);
    assert.equal(again.getSettings().advancedMode, true);
    assert.equal(again.getSettings().concurrency, 3, 'untouched settings keep their defaults');
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

const SHOPIFY_URL = 'https://atlas-supply.myshopify.com/products/atlas-merino-crew';
const SHOPIFY_JS = 'https://atlas-supply.myshopify.com/products/atlas-merino-crew.js';

function queueFixtureRoutes() {
  return {
    [SHOPIFY_URL]: { body: fixture('shopify-variable.html') },
    [SHOPIFY_JS]: { body: fixture('shopify-product.js.json'), contentType: 'application/json' },
    'https://shop.example.com/product/aster-standing-desk/': { body: fixture('woo-variable.html') }
  };
}

function waitFor(fn: () => boolean, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for the queue'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test('the queue scrapes a category, records state per URL, and one failure does not stop the run', async () => {
  const dir = tmp();
  try {
    const db = openDb(dir);
    db.setSettings({ maxRetries: 0, perHostDelayMs: 0, browserRenderMode: 'never', validateImageUrls: false, respectRobotsTxt: false });
    const project = db.createProject({ name: 'P', targetFormat: 'shopify' });
    const cat = db.createCategory({ projectId: project.id, name: 'Mixed', path: 'Mixed' });
    db.addUrl(project.id, cat.id, '', SHOPIFY_URL);
    db.addUrl(project.id, cat.id, '', 'https://shop.example.com/product/aster-standing-desk/');
    db.addUrl(project.id, cat.id, '', 'https://shop.example.com/product/missing/');

    const { engine } = engineWith(queueFixtureRoutes(), { maxRetries: 0 });
    const queue = new ScrapeQueue({ db, engine });
    const job = queue.createJob({ projectId: project.id, categoryIds: [cat.id] });
    assert.equal(job.total, 3);

    await queue.start(job);
    await waitFor(() => !queue.isBusy());

    const states = db.urls.all().map((u) => u.state).sort();
    assert.deepEqual(states, ['completed', 'completed', 'failed']);
    assert.equal(db.products.count(), 2, 'the two good URLs still produced products');

    const failed = db.urls.all().find((u) => u.state === 'failed')!;
    assert.match(failed.lastError ?? '', /does not exist/i);
    assert.equal(failed.lastErrorCode, 'NOT_FOUND');

    const done = db.urls.all().find((u) => u.state === 'completed')!;
    assert.ok(done.productId);
    assert.ok(done.durationMs !== null);
    assert.ok(db.products.get(done.productId!));

    const finished = db.jobs.get(job.id)!;
    assert.equal(finished.state, 'completed');
    assert.equal(finished.completed, 2);
    assert.equal(finished.failed, 1);
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the category assigned in the app reaches the scraped product', async () => {
  const dir = tmp();
  try {
    const db = openDb(dir);
    db.setSettings({ maxRetries: 0, perHostDelayMs: 0, browserRenderMode: 'never', validateImageUrls: false, respectRobotsTxt: false });
    const project = db.createProject({ name: 'P', targetFormat: 'shopify' });
    const cat = db.createCategory({ projectId: project.id, name: 'Monitors', path: 'Electronics > Monitors' });
    db.addUrl(project.id, cat.id, '', SHOPIFY_URL);

    const { engine } = engineWith(queueFixtureRoutes(), { maxRetries: 0 });
    const queue = new ScrapeQueue({ db, engine });
    await queue.start(queue.createJob({ projectId: project.id, categoryIds: [cat.id] }));
    await waitFor(() => !queue.isBusy());

    const product = db.products.loadMany()[0] as CanonicalProduct;
    assert.equal(product.categoryPath, 'Electronics > Monitors');
    assert.equal(product.categoryId, cat.id);
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a job interrupted by a crash is recovered as paused and resumes where it stopped', async () => {
  const dir = tmp();
  try {
    const db = openDb(dir);
    db.setSettings({ maxRetries: 0, perHostDelayMs: 0, browserRenderMode: 'never', validateImageUrls: false, respectRobotsTxt: false });
    const project = db.createProject({ name: 'P', targetFormat: 'shopify' });
    const cat = db.createCategory({ projectId: project.id, name: 'C' });
    const a = db.addUrl(project.id, cat.id, '', SHOPIFY_URL).entry!;
    const b = db.addUrl(project.id, cat.id, '', 'https://shop.example.com/product/aster-standing-desk/').entry!;

    const { engine } = engineWith(queueFixtureRoutes(), { maxRetries: 0 });
    const queue = new ScrapeQueue({ db, engine });
    const job = queue.createJob({ projectId: project.id, categoryIds: [cat.id] });

    // Simulate the state a hard crash leaves behind.
    db.jobs.update(job.id, { state: 'running', completed: 1 });
    db.setUrlState(a.id, 'completed', { productId: 'kept' });
    db.setUrlState(b.id, 'processing');

    const recovered = new ScrapeQueue({ db, engine });
    recovered.recover();
    assert.equal(db.jobs.get(job.id)!.state, 'paused');
    assert.equal(db.urls.get(b.id)!.state, 'pending', 'the in-flight URL goes back to pending');
    assert.equal(db.urls.get(a.id)!.state, 'completed', 'finished work is not repeated');

    await recovered.resume();
    await waitFor(() => !recovered.isBusy());

    assert.equal(db.urls.get(b.id)!.state, 'completed');
    assert.equal(db.products.count(), 1, 'only the unfinished URL was scraped');
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancelling stops the run and records the job as cancelled', async () => {
  const dir = tmp();
  try {
    const db = openDb(dir);
    db.setSettings({ maxRetries: 0, perHostDelayMs: 0, browserRenderMode: 'never', validateImageUrls: false, respectRobotsTxt: false });
    const project = db.createProject({ name: 'P', targetFormat: 'shopify' });
    for (let i = 0; i < 5; i++) db.addUrl(project.id, null, '', `${SHOPIFY_URL}?i=${i}`);

    const routes = queueFixtureRoutes() as Record<string, { body: string; contentType?: string }>;
    for (let i = 0; i < 5; i++) routes[`${SHOPIFY_URL}?i=${i}`] = { body: fixture('shopify-variable.html') };
    const { engine } = engineWith(routes, { maxRetries: 0 });

    const queue = new ScrapeQueue({ db, engine });
    const job = queue.createJob({ projectId: project.id });
    await queue.start(job);
    queue.cancel();
    await waitFor(() => !queue.isBusy());

    assert.equal(db.jobs.get(job.id)!.state, 'cancelled');
    assert.ok(db.products.count() < 5, 'cancelling should stop work early');
  } finally {
    closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

test('URL coercion accepts what people actually paste', () => {
  assert.equal(coerceUrl('  https://a.com/p/1  '), 'https://a.com/p/1');
  assert.equal(coerceUrl('shop.com/products/x'), 'https://shop.com/products/x');
  assert.equal(coerceUrl('<https://a.com/p>'), 'https://a.com/p');
  assert.equal(coerceUrl('not a url'), null);
  assert.equal(coerceUrl('javascript:alert(1)'), null);
  assert.equal(coerceUrl('ftp://a.com/x'), null);
  assert.equal(coerceUrl(''), null);
});

test('URL normalisation only affects duplicate detection', () => {
  assert.equal(normalizeUrl('https://WWW.Shop.com/products/X/?utm_campaign=a&b=2#frag'), 'https://shop.com/products/X?b=2');
  assert.equal(normalizeUrl('http://shop.com/p'), normalizeUrl('https://shop.com/p'));
  assert.notEqual(normalizeUrl('https://shop.com/p/1'), normalizeUrl('https://shop.com/p/2'));
});

test('image identity ignores CDN size suffixes', () => {
  assert.equal(
    imageIdentity('https://cdn.shopify.com/s/x/a_1024x1024.jpg'),
    imageIdentity('https://cdn.shopify.com/s/x/a.jpg')
  );
  assert.equal(imageIdentity('https://s.com/a-600x600.jpg'), imageIdentity('https://s.com/a.jpg'));
  assert.notEqual(imageIdentity('https://s.com/a.jpg'), imageIdentity('https://s.com/b.jpg'));
  assert.equal(upscaleShopifyImage('https://cdn.shopify.com/s/x/a_grande.jpg?v=1'), 'https://cdn.shopify.com/s/x/a.jpg?v=1');
  assert.equal(upscaleWordpressImage('https://s.com/wp-content/a-300x200.png'), 'https://s.com/wp-content/a.png');
});

test('money parsing copes with international formats', () => {
  assert.equal(parseMoney('$1,299.00'), 1299);
  assert.equal(parseMoney('1.299,00 €'), 1299);
  assert.equal(parseMoney('1 299,50'), 1299.5);
  assert.equal(parseMoney('49.99'), 49.99);
  assert.equal(parseMoney('USD 20'), 20);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('Free'), null);
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney(4999, { centsIfInteger: true }), 49.99);
  assert.equal(currencyFrom('£95.00'), 'GBP');
  assert.equal(currencyFrom('€89'), 'EUR');
  assert.equal(currencyFrom('Price: 100'), null);
});

test('robots.txt rules are honoured, including the most specific match', () => {
  const rules = parseRobots(
    ['User-agent: *', 'Disallow: /cart', 'Disallow: /checkout', 'Allow: /cart/info', '', 'User-agent: BadBot', 'Disallow: /'].join('\n'),
    'TotoMigrator/1.0'
  );
  assert.equal(rules.isAllowed('/products/x'), true);
  assert.equal(rules.isAllowed('/cart'), false);
  assert.equal(rules.isAllowed('/cart/info'), true, 'the longer Allow wins');
  assert.equal(rules.isAllowed('/checkout/pay'), false);

  const targeted = parseRobots(['User-agent: TotoMigrator', 'Disallow: /products'].join('\n'), 'TotoMigrator/1.0');
  assert.equal(targeted.isAllowed('/products/x'), false);
});

test('description sanitising keeps structure and removes danger', () => {
  const r = sanitiseDescription(
    `<div class="theme-wrap"><h2>Spec</h2><p>Nice <b>bold</b> and <a href="/x" onclick="steal()">link</a></p>
     <table><tr><td>A</td></tr></table><script>bad()</script>
     <img src="/img/a.jpg" alt="A"><img src="https://facebook.com/tr?id=1" width="1" height="1">
     <iframe src="https://evil"></iframe><p></p></div>`,
    'https://shop.com/product/x'
  );
  assert.match(r.html, /<h2>Spec<\/h2>/);
  assert.match(r.html, /<b>bold<\/b>/);
  assert.match(r.html, /<table>/);
  assert.match(r.html, /href="https:\/\/shop\.com\/x"/, 'relative links become absolute');
  assert.match(r.html, /src="https:\/\/shop\.com\/img\/a\.jpg"/);
  assert.doesNotMatch(r.html, /script|onclick|iframe|facebook/i);
  assert.ok(r.strippedSomething);
  assert.match(r.text, /Spec/);
});

test('technical errors are translated into something actionable', () => {
  assert.equal(humanizeError(new Error('HTTP 404')).code, 'NOT_FOUND');
  assert.equal(humanizeError(new Error('HTTP 429')).code, 'RATE_LIMITED');
  assert.match(humanizeError(new Error('HTTP 429')).message, /rate-limiting/i);
  assert.equal(humanizeError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })).code, 'DNS_FAILED');
  assert.equal(humanizeError(new Error('The operation was aborted')).code, 'TIMEOUT');
  const unknown = humanizeError(new Error('kaboom'));
  assert.equal(unknown.code, 'UNKNOWN');
  assert.ok(unknown.detail.includes('kaboom'), 'the technical text is kept for the advanced view');
});

test('ids are unique under rapid generation', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 20000; i++) ids.add(newId('x_'));
  assert.equal(ids.size, 20000);
});
