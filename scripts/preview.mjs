/**
 * Runs the interface in a plain browser against an in-memory stand-in for the
 * application core, so the UI can be exercised and screenshotted without
 * launching Electron. Development aid only — never shipped to the operator.
 *
 *   node scripts/preview.mjs            # serve on http://localhost:5273
 *   node scripts/preview.mjs --shot     # drive it with Playwright and capture
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist', 'renderer');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json'
};

/* The stub bridge, injected into the page before the app's own script runs. */
const STUB = await readFile(join(root, 'scripts', 'preview-bridge.js'), 'utf8');

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const target = join(dist, normalize(file).replace(/^(\.\.[/\\])+/, ''));
  try {
    let body = await readFile(target);
    if (file === '/index.html') {
      // Inject the stub and drop the CSP so the inline stub can run.
      body = Buffer.from(
        body
          .toString('utf8')
          .replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')
          .replace('</head>', `<script>${STUB}</script></head>`)
      );
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const PORT = Number(process.env.PORT ?? 5273);
await new Promise((resolve) => server.listen(PORT, resolve));
console.log(`preview on http://localhost:${PORT}`);

if (process.argv.includes('--shot')) {
  // Resolved by explicit path so the tool works from a global Playwright too.
  const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? 'playwright';
  const { chromium } = await import(playwrightPath);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2 });

  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  const shots = (process.env.SHOTS ?? 'dashboard,categories,urls,products,validation,exports,settings').split(',');
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  const outDir = process.env.SHOT_DIR ?? join(root, '.preview');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(outDir, { recursive: true });

  for (const view of shots) {
    await page.evaluate((v) => window.__liftSetView(v), view.trim());
    await page.waitForTimeout(320);
    await page.screenshot({ path: join(outDir, `${view.trim()}.png`), fullPage: false });
    console.log(`captured ${view.trim()}`);
  }

  // Exercise a couple of dialogs too.
  await page.evaluate(() => window.__liftSetView('urls'));
  await page.waitForTimeout(200);
  const addBtn = page.locator('button:has-text("Add URLs")').first();
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, 'dialog-add-urls.png') });
    console.log('captured dialog-add-urls');
    await page.keyboard.press('Escape');
  }

  await page.evaluate(() => window.__liftSetView('products'));
  await page.waitForTimeout(250);
  // Pick a variable product so the variant table is actually exercised.
  const firstRow = page.locator('table.table tbody tr', { has: page.locator('.badge--brand') }).first();
  if (await firstRow.count()) {
    await firstRow.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, 'product-detail.png') });
    console.log('captured product-detail');
    const variantsTab = page.locator('button.tab:has-text("Variants")');
    if (await variantsTab.count()) {
      await variantsTab.click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(outDir, 'product-variants.png') });
      console.log('captured product-variants');
    }
    const sourceTab = page.locator('button.tab:has-text("Where it came from")');
    if (await sourceTab.count()) {
      await sourceTab.click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(outDir, 'product-source.png') });
      console.log('captured product-source');
    }
  }

  await browser.close();
  server.close();

  if (errors.length) {
    console.error('\nPAGE ERRORS:');
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }
  console.log('\nno page errors');
  process.exit(0);
}
