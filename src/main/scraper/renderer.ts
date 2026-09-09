/**
 * Layer 5/6 — headless rendering.
 *
 * Electron already ships Chromium, so JavaScript-rendered product pages are
 * handled by an offscreen BrowserWindow. There is no separate browser download,
 * no driver to install, and nothing for the operator to configure.
 *
 * The window runs with node integration off, context isolation on, in its own
 * private session partition that is cleared between runs, and it never becomes
 * visible. It only ever *reads* the page.
 */
import { BrowserWindow, session } from 'electron';
import { log } from '../util/logger';

export interface RenderResult {
  ok: boolean;
  html: string;
  finalUrl: string;
  status: number | null;
  error: string | null;
  /** Anything the in-page harvester managed to read out of JS globals. */
  harvest: PageHarvest;
  interaction: VariantObservation[] | null;
  ms: number;
}

export interface PageHarvest {
  shopifyMeta: unknown | null;
  shopifyProductJson: unknown | null;
  wooVariations: unknown | null;
  wooProductId: number | null;
  wooVariationFormAttrs: Record<string, string[]> | null;
  jsonLd: unknown[];
  inlineProductJson: unknown[];
  currency: string | null;
  detected: string[];
}

export interface VariantObservation {
  selection: Array<{ name: string; value: string }>;
  price: string | null;
  comparePrice: string | null;
  sku: string | null;
  availabilityText: string | null;
  imageUrl: string | null;
  variantId: string | null;
}

const PARTITION = 'toto-scrape';

let sharedWindow: BrowserWindow | null = null;

function getWindow(userAgent: string): BrowserWindow {
  if (sharedWindow && !sharedWindow.isDestroyed()) return sharedWindow;
  const ses = session.fromPartition(PARTITION, { cache: false });
  ses.setUserAgent(userAgent);
  // Never let the render window prompt for permissions.
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  sharedWindow = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1000,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      javascript: true,
      images: false,
      webgl: false,
      offscreen: false,
      backgroundThrottling: false
    }
  });
  sharedWindow.on('closed', () => {
    sharedWindow = null;
  });
  return sharedWindow;
}

export function disposeRenderer(): void {
  if (sharedWindow && !sharedWindow.isDestroyed()) sharedWindow.destroy();
  sharedWindow = null;
}

export async function clearRenderSession(): Promise<void> {
  try {
    await session.fromPartition(PARTITION).clearStorageData();
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ */

/** Script injected into the page to read product data out of JS globals. */
const HARVEST_SCRIPT = `(() => {
  const out = {
    shopifyMeta: null, shopifyProductJson: null, wooVariations: null,
    wooProductId: null, wooVariationFormAttrs: null, jsonLd: [],
    inlineProductJson: [], currency: null, detected: []
  };
  const safe = (fn) => { try { return fn(); } catch (e) { return null; } };

  /* --- Shopify globals --- */
  out.shopifyMeta = safe(() => {
    const m = (window.ShopifyAnalytics && window.ShopifyAnalytics.meta) || window.meta || null;
    return m ? JSON.parse(JSON.stringify(m)) : null;
  });
  if (out.shopifyMeta) out.detected.push('shopify-analytics-meta');
  out.currency = safe(() => (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || null);
  if (safe(() => !!window.Shopify)) out.detected.push('shopify-global');

  /* --- JSON blobs printed by themes --- */
  const scripts = Array.from(document.querySelectorAll('script'));
  for (const s of scripts) {
    const type = (s.getAttribute('type') || '').toLowerCase();
    const txt = (s.textContent || '').trim();
    if (!txt) continue;
    if (type === 'application/ld+json') {
      const parsed = safe(() => JSON.parse(txt));
      if (parsed) out.jsonLd.push(parsed);
      continue;
    }
    if (type === 'application/json') {
      const id = (s.id || '') + ' ' + (s.className || '') + ' ' + (s.getAttribute('data-product-json') !== null ? 'data-product-json' : '');
      const looksProduct = /product/i.test(id) || /"variants"\\s*:/.test(txt.slice(0, 4000));
      if (looksProduct && txt.length < 3000000) {
        const parsed = safe(() => JSON.parse(txt));
        if (parsed) out.inlineProductJson.push(parsed);
      }
      continue;
    }
    if (txt.length < 2000000 && /var\\s+meta\\s*=\\s*\\{|__st\\s*=|product\\s*:\\s*\\{/.test(txt)) {
      const m = txt.match(/var\\s+meta\\s*=\\s*(\\{[\\s\\S]*?\\});/);
      if (m) { const parsed = safe(() => JSON.parse(m[1])); if (parsed) out.inlineProductJson.push(parsed); }
    }
  }

  /* --- WooCommerce variation form --- */
  const forms = Array.from(document.querySelectorAll('form.variations_form, form[data-product_variations]'));
  if (forms.length) {
    out.detected.push('woo-variations-form');
    const f = forms[0];
    const raw = f.getAttribute('data-product_variations');
    if (raw && raw !== 'false' && raw !== '') {
      out.wooVariations = safe(() => JSON.parse(raw));
    }
    const pid = f.getAttribute('data-product_id');
    out.wooProductId = pid ? parseInt(pid, 10) : null;
    const attrs = {};
    for (const sel of Array.from(f.querySelectorAll('select[name^="attribute_"]'))) {
      const name = sel.getAttribute('name') || '';
      attrs[name] = Array.from(sel.options).map((o) => o.value).filter((v) => v !== '');
    }
    for (const ul of Array.from(f.querySelectorAll('[data-attribute_name]'))) {
      const name = ul.getAttribute('data-attribute_name') || '';
      if (name && !attrs[name]) {
        attrs[name] = Array.from(ul.querySelectorAll('[data-value]')).map((n) => n.getAttribute('data-value')).filter(Boolean);
      }
    }
    if (Object.keys(attrs).length) out.wooVariationFormAttrs = attrs;
  }
  if (document.querySelector('body.woocommerce, body.woocommerce-page, .woocommerce div.product')) out.detected.push('woo-body-class');

  return out;
})()`;

/** Reads whatever the page is currently displaying for the selected variant. */
const OBSERVE_SCRIPT = `(() => {
  const txt = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : null);
  const first = (sels) => { for (const s of sels) { const e = document.querySelector(s); if (e) return e; } return null; };
  const priceEl = first([
    '.woocommerce-variation-price .amount', '.single_variation .amount',
    '.product .summary .price ins .amount', '.product .summary .price .amount',
    '[data-product-price]', '.price__current', '.price-item--sale', '.price-item--regular',
    '.product__price', '.product-price', '[itemprop="price"]'
  ]);
  const cmpEl = first([
    '.woocommerce-variation-price del .amount', '.product .summary .price del .amount',
    '.price__compare', '.price-item--regular.price-item--sale', '[data-compare-price]',
    '.compare-at-price', 's.price-item'
  ]);
  const skuEl = first(['.woocommerce-variation-sku', '.sku_wrapper .sku', '.sku', '[data-sku]', '[itemprop="sku"]']);
  const availEl = first([
    '.woocommerce-variation-availability', '.stock', '[data-inventory-status]',
    '.product__inventory', '[itemprop="availability"]'
  ]);
  const imgEl = first([
    '.woocommerce-product-gallery__image.flex-active-slide img',
    '.woocommerce-product-gallery__image img',
    '.product__media img', '.product-single__photo img',
    '[data-product-featured-image] img', '.product-gallery img', 'img[itemprop="image"]'
  ]);
  const idEl = document.querySelector('input.variation_id, input[name="id"], select[name="id"]');
  const img = imgEl ? (imgEl.getAttribute('data-large_image') || imgEl.getAttribute('data-src') || imgEl.currentSrc || imgEl.src || null) : null;
  return {
    price: txt(priceEl),
    comparePrice: txt(cmpEl),
    sku: skuEl ? (skuEl.getAttribute('data-sku') || txt(skuEl)) : null,
    availabilityText: availEl ? (availEl.getAttribute('content') || txt(availEl)) : null,
    imageUrl: img,
    variantId: idEl ? (idEl.value || null) : null
  };
})()`;

/* ------------------------------------------------------------------ */

export async function renderPage(
  url: string,
  opts: {
    userAgent: string;
    timeoutMs: number;
    interactVariants: boolean;
    /** Hard ceiling so a 200-combination product cannot stall a run forever. */
    maxCombinations?: number;
  }
): Promise<RenderResult> {
  const started = Date.now();
  const win = getWindow(opts.userAgent);
  const wc = win.webContents;
  let status: number | null = null;

  const onResponse = (_e: unknown, s: number) => {
    if (status === null) status = s;
  };

  try {
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Render timed out')), opts.timeoutMs);
      const done = () => {
        clearTimeout(timer);
        cleanup();
        resolve();
      };
      const fail = (_e: unknown, code: number, desc: string) => {
        // -3 is ERR_ABORTED, which fires for benign in-page navigations.
        if (code === -3) return;
        clearTimeout(timer);
        cleanup();
        reject(new Error(`${desc} (${code})`));
      };
      const cleanup = () => {
        wc.removeListener('did-finish-load', done);
        wc.removeListener('did-fail-load', fail as never);
      };
      wc.once('did-finish-load', done);
      wc.on('did-fail-load', fail as never);
    });

    wc.on('did-get-response-details' as never, onResponse as never);
    await wc.loadURL(url, { userAgent: opts.userAgent });
    await loaded.catch((e) => {
      throw e;
    });

    // Give late XHR-driven themes a moment to paint variant data.
    await waitForQuiet(wc, Math.min(4000, Math.max(800, opts.timeoutMs / 8)));

    const harvest = (await wc.executeJavaScript(HARVEST_SCRIPT, true)) as PageHarvest;
    const html = (await wc.executeJavaScript('document.documentElement.outerHTML', true)) as string;

    let interaction: VariantObservation[] | null = null;
    if (opts.interactVariants) {
      interaction = await interactVariants(wc, opts.maxCombinations ?? 60).catch((e) => {
        log.warn('render', 'Variant interaction stopped early', String(e));
        return null;
      });
    }

    return {
      ok: true,
      html,
      finalUrl: wc.getURL(),
      status,
      error: null,
      harvest,
      interaction,
      ms: Date.now() - started
    };
  } catch (err) {
    return {
      ok: false,
      html: '',
      finalUrl: url,
      status,
      error: err instanceof Error ? err.message : String(err),
      harvest: emptyHarvest(),
      interaction: null,
      ms: Date.now() - started
    };
  } finally {
    wc.removeListener('did-get-response-details' as never, onResponse as never);
    try {
      await wc.loadURL('about:blank');
    } catch {
      /* ignore */
    }
  }
}

function emptyHarvest(): PageHarvest {
  return {
    shopifyMeta: null,
    shopifyProductJson: null,
    wooVariations: null,
    wooProductId: null,
    wooVariationFormAttrs: null,
    jsonLd: [],
    inlineProductJson: [],
    currency: null,
    detected: []
  };
}

async function waitForQuiet(wc: Electron.WebContents, ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  try {
    // A second short settle after any framework hydration.
    await wc.executeJavaScript('new Promise(r => requestAnimationFrame(() => setTimeout(r, 250)))', true);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Layer 6 — drive the variant selectors and observe what changes       */
/* ------------------------------------------------------------------ */

interface SelectorAxis {
  kind: 'select' | 'radio' | 'swatch';
  name: string;
  label: string;
  values: string[];
}

const DISCOVER_AXES = `(() => {
  const axes = [];
  const seen = new Set();
  const labelFor = (el) => {
    const id = el.id;
    if (id) { const l = document.querySelector('label[for="' + CSS.escape(id) + '"]'); if (l) return l.textContent.replace(/\\s+/g,' ').trim(); }
    const wrap = el.closest('tr, .variation, .product-form__input, .selector-wrapper, .swatch, fieldset');
    if (wrap) {
      const l = wrap.querySelector('label, legend, .label, .form__label, .variation-label, th');
      if (l) return l.textContent.replace(/\\s+/g,' ').trim().replace(/:$/,'');
    }
    return el.getAttribute('name') || 'Option';
  };
  for (const sel of Array.from(document.querySelectorAll('select[name^="attribute_"], form.variations_form select, .product-form__input select, select[name="options[]"], select[data-index], .single-option-selector'))) {
    const name = sel.getAttribute('name') || sel.id || '';
    if (!name || seen.has('s:'+name)) continue;
    const values = Array.from(sel.options).map((o) => o.value).filter((v) => v && v !== '');
    if (values.length < 1) continue;
    seen.add('s:'+name);
    axes.push({ kind: 'select', name, label: labelFor(sel), values });
  }
  if (!axes.length) {
    const groups = new Map();
    for (const r of Array.from(document.querySelectorAll('input[type="radio"][name]'))) {
      const n = r.getAttribute('name');
      if (!/option|variant|attribute|swatch|size|color|colour/i.test(n) && !r.closest('form')) continue;
      if (!groups.has(n)) groups.set(n, []);
      groups.get(n).push(r.value);
    }
    for (const [n, vals] of groups) {
      if (vals.length < 1) continue;
      const one = document.querySelector('input[type="radio"][name="' + CSS.escape(n) + '"]');
      axes.push({ kind: 'radio', name: n, label: labelFor(one), values: vals });
    }
  }
  return axes;
})()`;

async function interactVariants(wc: Electron.WebContents, maxCombinations: number): Promise<VariantObservation[] | null> {
  const axes = (await wc.executeJavaScript(DISCOVER_AXES, true)) as SelectorAxis[];
  if (!axes || axes.length === 0) return null;

  const combos = cartesian(axes.map((a) => a.values));
  if (combos.length === 0) return null;
  if (combos.length > maxCombinations) {
    log.warn('render', `Product has ${combos.length} option combinations; observing the first ${maxCombinations}.`);
  }
  const limited = combos.slice(0, maxCombinations);

  const observations: VariantObservation[] = [];
  for (const combo of limited) {
    const assignments = axes.map((a, i) => ({ kind: a.kind, name: a.name, value: combo[i] }));
    const applied = (await wc.executeJavaScript(applyScript(assignments), true)) as boolean;
    if (!applied) continue;
    await new Promise((r) => setTimeout(r, 550));
    const obs = (await wc.executeJavaScript(OBSERVE_SCRIPT, true)) as Omit<VariantObservation, 'selection'>;
    observations.push({
      selection: axes.map((a, i) => ({ name: a.label, value: combo[i] })),
      ...obs
    });
  }
  return observations;
}

function applyScript(assignments: Array<{ kind: string; name: string; value: string }>): string {
  const json = JSON.stringify(assignments);
  return `(() => {
    const list = ${json};
    let ok = true;
    for (const a of list) {
      if (a.kind === 'select') {
        const el = document.querySelector('select[name="' + CSS.escape(a.name) + '"]') || document.getElementById(a.name);
        if (!el) { ok = false; continue; }
        el.value = a.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const el = document.querySelector('input[type="radio"][name="' + CSS.escape(a.name) + '"][value="' + CSS.escape(a.value) + '"]');
        if (!el) { ok = false; continue; }
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.click();
      }
    }
    return ok;
  })()`;
}

function cartesian(lists: string[][]): string[][] {
  return lists.reduce<string[][]>((acc, list) => acc.flatMap((prefix) => list.map((v) => [...prefix, v])), [[]]);
}
