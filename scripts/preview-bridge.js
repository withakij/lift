/* eslint-disable */
/**
 * In-memory stand-in for the application core, used only by scripts/preview.mjs
 * so the interface can be driven in a plain browser. The shapes here mirror the
 * real IPC contract; the data is obviously fictional sample data.
 */
(function () {
  const now = Date.now();
  const iso = (minsAgo) => new Date(now - minsAgo * 60000).toISOString();

  const projects = [
    {
      id: 'prj_1',
      name: 'Peripherals migration',
      description: 'Moving the accessory range to the new store',
      targetFormat: 'shopify',
      exportProfileId: 'shopify-legacy',
      createdAt: iso(60 * 24 * 6),
      updatedAt: iso(90),
      archived: false
    },
    {
      id: 'prj_2',
      name: 'Furniture catalogue',
      description: '',
      targetFormat: 'woocommerce',
      exportProfileId: 'woocommerce-default',
      createdAt: iso(60 * 24 * 20),
      updatedAt: iso(60 * 24 * 3),
      archived: false
    }
  ];

  const categories = [
    { id: 'cat_1', projectId: 'prj_1', name: 'Monitors', path: 'Electronics > Monitors', googleProductCategory: null, createdAt: iso(500), updatedAt: iso(500), position: 0, urlCount: 24, productCount: 22 },
    { id: 'cat_2', projectId: 'prj_1', name: 'Keyboards', path: 'Electronics > Keyboards', googleProductCategory: null, createdAt: iso(480), updatedAt: iso(480), position: 1, urlCount: 15, productCount: 15 },
    { id: 'cat_3', projectId: 'prj_1', name: 'Mice', path: 'Electronics > Mice', googleProductCategory: null, createdAt: iso(470), updatedAt: iso(470), position: 2, urlCount: 9, productCount: 7 },
    { id: 'cat_4', projectId: 'prj_1', name: 'Wallets', path: 'Accessories > Wallets', googleProductCategory: null, createdAt: iso(460), updatedAt: iso(460), position: 3, urlCount: 6, productCount: 0 }
  ];

  const hosts = ['atlas-supply.myshopify.com', 'shop.northfield.example'];
  const slugs = [
    'ultrawide-34-curved', 'studio-display-27', 'portable-monitor-15', 'gaming-240hz-27',
    'mechanical-tkl-brown', 'low-profile-wireless', 'ergo-split-pro', 'compact-60-percent',
    'precision-mouse-mx', 'vertical-ergo-mouse', 'trackball-classic', 'bifold-leather-wallet'
  ];

  const urls = [];
  let n = 0;
  for (const cat of categories) {
    for (let i = 0; i < cat.urlCount; i++) {
      n++;
      const slug = `${slugs[n % slugs.length]}-${i + 1}`;
      const state =
        cat.id === 'cat_4' ? 'pending'
        : i === 2 ? 'failed'
        : i === 4 ? 'warning'
        : i >= cat.productCount ? 'pending'
        : 'completed';
      urls.push({
        id: `url_${n}`,
        projectId: 'prj_1',
        categoryId: cat.id,
        url: `https://${hosts[n % 2]}/products/${slug}`,
        normalizedUrl: `https://${hosts[n % 2]}/products/${slug}`,
        state,
        attempts: state === 'failed' ? 3 : 1,
        lastError: state === 'failed' ? 'That page does not exist (404). The product may have been removed.' : null,
        lastErrorCode: state === 'failed' ? 'NOT_FOUND' : null,
        productId: state === 'completed' || state === 'warning' ? `prd_${n}` : null,
        note: state === 'warning' ? 'The source page did not identify a primary image; the first gallery image was used.' : null,
        addedAt: iso(600 - n),
        startedAt: state === 'pending' ? null : iso(200 - (n % 100)),
        finishedAt: state === 'pending' ? null : iso(199 - (n % 100)),
        durationMs: state === 'pending' ? null : 2400 + (n % 9) * 900
      });
    }
  }

  const PLACEHOLDER =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#1d2233"/><path d="M40 140l35-40 30 26 25-30 30 44z" fill="#2f3category" /><circle cx="70" cy="66" r="14" fill="#39415c"/><path d="M36 146l38-44 32 28 26-32 32 48z" fill="#39415c"/></svg>`
    );

  const products = urls
    .filter((u) => u.productId)
    .map((u, i) => {
      const cat = categories.find((c) => c.id === u.categoryId);
      const variable = i % 3 !== 0;
      const sev = i % 11 === 0 ? 'ERROR' : i % 7 === 0 ? 'WARNING' : i % 13 === 0 ? 'CRITICAL' : null;
      return {
        id: u.productId,
        title: titleFor(u.url),
        sourceUrl: u.url,
        sourcePlatform: u.url.includes('myshopify') ? 'shopify' : 'woocommerce',
        kind: variable ? 'variable' : 'simple',
        categoryPath: cat ? cat.path : null,
        price: 49 + ((i * 37) % 400),
        currency: u.url.includes('myshopify') ? 'GBP' : 'EUR',
        variantCount: variable ? 2 + (i % 5) : 0,
        imageCount: 1 + (i % 6),
        stockStatus: i % 8 === 0 ? 'out_of_stock' : 'in_stock',
        worstSeverity: sev,
        issueCount: sev ? 1 + (i % 3) : 0,
        scrapedAt: u.finishedAt,
        featuredImageUrl: PLACEHOLDER
      };
    });

  function titleFor(url) {
    const slug = url.split('/').pop();
    return slug
      .replace(/-\d+$/, '')
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  function fullProduct(id) {
    const summary = products.find((p) => p.id === id);
    if (!summary) return null;
    const colours = ['Graphite', 'Silver', 'Midnight'];
    const sizes = ['27"', '32"', '34"'];
    const variants = [];
    for (let i = 0; i < Math.max(1, summary.variantCount); i++) {
      const colour = colours[i % colours.length];
      const size = sizes[Math.floor(i / colours.length) % sizes.length];
      variants.push({
        id: `var_${id}_${i}`,
        sourceVariantId: String(41000000 + i),
        parentProductId: id,
        title: `${colour} / ${size}`,
        sku: `${id.toUpperCase().replace('PRD_', 'SKU-')}-${colour.slice(0, 3).toUpperCase()}-${i}`,
        barcode: i % 2 ? '5060123456789' : null,
        options: summary.kind === 'variable' ? [{ name: 'Colour', value: colour }, { name: 'Size', value: size }] : [],
        price: summary.price + i * 20,
        compareAtPrice: i % 2 === 0 ? summary.price + i * 20 + 40 : null,
        regularPrice: summary.price + i * 20 + 40,
        salePrice: i % 2 === 0 ? summary.price + i * 20 : null,
        costPerItem: null,
        currency: summary.currency,
        available: i !== 1,
        stockStatus: i === 1 ? 'out_of_stock' : 'in_stock',
        inventoryQuantity: i === 1 ? 0 : 4 + i * 3,
        inventoryPolicy: 'deny',
        inventoryTracker: 'shopify',
        backordersAllowed: false,
        weight: 3200 + i * 150,
        weightUnit: 'g',
        length: null, width: null, height: null, dimensionUnit: null,
        requiresShipping: true,
        taxable: true,
        imageUrl: PLACEHOLDER,
        extraAttributes: {},
        position: i + 1
      });
    }
    const images = [];
    for (let i = 0; i < summary.imageCount; i++) {
      images.push({
        url: PLACEHOLDER,
        position: i + 1,
        alt: i === 0 ? `${summary.title} front view` : null,
        title: null, width: 2000, height: 2000,
        isFeatured: i === 0,
        variantIds: i < variants.length ? [variants[i].id] : [],
        source: 'shopify-product-json'
      });
    }
    return {
      id,
      projectId: 'prj_1',
      categoryId: urls.find((u) => u.productId === id)?.categoryId ?? null,
      categoryPath: summary.categoryPath,
      sourceUrl: summary.sourceUrl,
      sourcePlatform: summary.sourcePlatform,
      sourceProductId: '7712233445566',
      handle: summary.sourceUrl.split('/').pop(),
      kind: summary.kind,
      sourceProductType: 'Displays',
      title: summary.title,
      vendor: 'Atlas Supply',
      brand: 'Atlas',
      tags: ['office', 'display', 'usb-c'],
      status: 'active',
      published: true,
      descriptionHtml:
        '<h2>Built for long days</h2><p>A <strong>34-inch</strong> curved panel with a single-cable USB-C connection.</p><ul><li>3440 × 1440 at 144 Hz</li><li>90 W power delivery</li><li>Three-year warranty</li></ul>',
      descriptionText: 'Built for long days. A 34-inch curved panel with a single-cable USB-C connection.',
      shortDescriptionHtml: '<p>Curved ultrawide with USB-C.</p>',
      shortDescriptionText: 'Curved ultrawide with USB-C.',
      purchaseNote: null,
      price: summary.price,
      regularPrice: summary.price + 40,
      salePrice: summary.price,
      compareAtPrice: summary.price + 40,
      costPerItem: null,
      currency: summary.currency,
      priceMin: summary.price,
      priceMax: summary.price + (variants.length - 1) * 20,
      sku: 'ATL-DSP',
      barcode: null,
      stockStatus: summary.stockStatus,
      inventoryQuantity: 12,
      inventoryPolicy: 'deny',
      backordersAllowed: false,
      soldIndividually: null,
      lowStockAmount: null,
      weight: 3200, weightUnit: 'g',
      length: 81, width: 24, height: 46, dimensionUnit: 'cm',
      requiresShipping: true, taxable: true,
      taxStatus: null, taxClass: null, shippingClass: null,
      options: summary.kind === 'variable'
        ? [{ name: 'Colour', values: colours, position: 1 }, { name: 'Size', values: sizes, position: 2 }]
        : [],
      attributes: [{ name: 'Panel type', values: ['VA'], isGlobal: false, isVariation: false, visible: true, position: 1 }],
      variants: summary.kind === 'variable' ? variants : [],
      images,
      featuredImageUrl: PLACEHOLDER,
      seo: {
        title: `${summary.title} — Atlas Supply`,
        description: null,
        metaDescription: 'A curved ultrawide display with single-cable USB-C connection.',
        canonicalUrl: summary.sourceUrl,
        robots: null,
        ogTitle: summary.title,
        ogDescription: null,
        ogImage: PLACEHOLDER,
        keywords: []
      },
      google: {
        googleProductCategory: null, productTypeString: null, brand: 'Atlas',
        gtin: null, mpn: null, condition: 'new', gender: null, ageGroup: null,
        material: null, pattern: null, color: null, size: null, sizeSystem: null,
        itemGroupId: null, identifierExists: null, adsGrouping: null, adsLabels: [],
        customLabel0: null, customLabel1: null, customLabel2: null, customLabel3: null, customLabel4: null,
        shippingWeight: null, multipack: null, isBundle: null
      },
      ratingValue: 4.6, reviewCount: 38, allowReviews: true,
      externalUrl: null, externalButtonText: null,
      provenance: {
        title: { source: 'shopify-product-json', confidence: 'high' },
        price: { source: 'shopify-product-json', confidence: 'high' },
        sku: { source: 'jsonld', confidence: 'high', note: 'Product.sku' },
        categoryPath: { source: 'user', confidence: 'high', note: 'assigned in the application' },
        variants: { source: 'shopify-product-json', confidence: 'high', note: `${variants.length} variants` },
        'google.gtin': { source: 'unavailable', confidence: 'none' },
        'google.mpn': { source: 'unavailable', confidence: 'none' },
        'seo.metaDescription': { source: 'html', confidence: 'medium', note: 'meta[name=description]' },
        stockStatus: { source: 'shopify-product-json', confidence: 'high', conflict: { otherSource: 'opengraph', otherValue: 'out_of_stock' } }
      },
      extractionNotes: [],
      layersUsed: ['fetch', 'meta', 'jsonld', 'shopify'],
      scrapedAt: summary.scrapedAt,
      contentHash: 'a1b2c3d4',
      debug: { detectedBy: 'shopify-cdn, shopify-global', httpStatus: 200, renderedWithBrowser: false }
    };
  }

  const issues = [];
  let iid = 0;
  for (const p of products) {
    if (!p.worstSeverity) continue;
    iid++;
    issues.push({
      id: `iss_${iid}`, projectId: 'prj_1', productId: p.id, variantId: null,
      ruleId: p.worstSeverity === 'CRITICAL' ? 'variant-integrity' : p.worstSeverity === 'ERROR' ? 'required-fields' : 'variant-images',
      severity: p.worstSeverity,
      message:
        p.worstSeverity === 'CRITICAL'
          ? 'SKU “ATL-DSP-GRA-0” is used by two different option combinations (Graphite / 27" and Silver / 27").'
          : p.worstSeverity === 'ERROR'
            ? 'No price could be found for this product.'
            : 'The source did not mark a primary image; the first gallery image was used.',
      hint:
        p.worstSeverity === 'CRITICAL'
          ? 'This usually means variant data was mixed up. Re-scrape before exporting.'
          : p.worstSeverity === 'ERROR'
            ? 'Most imports reject rows without a price. Check the source page, or re-scrape with browser rendering enabled.'
            : 'Check the main image before importing.',
      field: p.worstSeverity === 'ERROR' ? 'price' : 'sku',
      observed: p.worstSeverity === 'CRITICAL' ? 'ATL-DSP-GRA-0' : null,
      createdAt: iso(30), acknowledged: false
    });
  }
  for (let k = 0; k < 6; k++) {
    iid++;
    issues.push({
      id: `iss_${iid}`, projectId: 'prj_1', productId: products[k * 3]?.id ?? null, variantId: null,
      ruleId: 'google-shopping', severity: 'INFO',
      message: 'The source page did not publish: GTIN, MPN, Google product category. These fields are left empty rather than guessed.',
      hint: 'Merchant Center identifiers cannot be derived from a product page; add them in the destination store if you need them.',
      field: 'google', observed: 'GTIN, MPN, Google product category', createdAt: iso(30), acknowledged: false
    });
  }

  const exportsLog = [
    { id: 'exp_1', projectId: 'prj_1', format: 'shopify', profileId: 'shopify-legacy', createdAt: iso(95), productCount: 38, rowCount: 121, skippedCount: 2, status: 'partial', filePath: '/Users/rahul/Documents/ToTo Exports/shopify-export-2026-09-08.csv', message: '2 product(s) were left out.' },
    { id: 'exp_2', projectId: 'prj_1', format: 'shopify', profileId: 'shopify-legacy', createdAt: iso(60 * 26), productCount: 30, rowCount: 96, skippedCount: 0, status: 'success', filePath: '/Users/rahul/Documents/ToTo Exports/shopify-export-2026-09-07.csv', message: null }
  ];

  const settings = {
    perHostDelayMs: 1200, concurrency: 3, perHostConcurrency: 1,
    requestTimeoutMs: 30000, renderTimeoutMs: 45000, maxRetries: 2, retryBackoffMs: 4000,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 TotoMigrator/1.0',
    respectRobotsTxt: true, browserRenderMode: 'auto', enableVariantInteraction: true,
    downloadImages: false, validateImageUrls: true, imageValidationConcurrency: 4,
    advancedMode: false, defaultExportDir: null, theme: 'dark', keepDebugSnippets: true
  };

  const bySeverity = { INFO: 0, WARNING: 0, ERROR: 0, CRITICAL: 0 };
  for (const i of issues) bySeverity[i.severity]++;
  const urlsByState = { pending: 0, processing: 0, completed: 0, warning: 0, failed: 0, retrying: 0, skipped: 0, paused: 0 };
  for (const u of urls) urlsByState[u.state]++;

  const stats = {
    projects: projects.length,
    categories: categories.length,
    urls: urls.length,
    urlsByState,
    products: products.length,
    variants: products.reduce((n, p) => n + p.variantCount, 0),
    productsNeedingReview: new Set(issues.filter((i) => i.severity !== 'INFO').map((i) => i.productId)).size,
    issuesBySeverity: bySeverity,
    lastExport: exportsLog[0],
    activeJob: null
  };

  let progress = {
    jobId: 'job_1', projectId: 'prj_1', state: 'running',
    total: 54, completed: 38, failed: 3, warned: 4, skipped: 0,
    currentUrl: 'https://atlas-supply.myshopify.com/products/ultrawide-34-curved-7',
    currentTitle: 'Ultrawide 34 Curved',
    currentStage: 'Reading variants'
  };

  const listeners = { progress: [], log: [], dataChanged: [] };
  const ok = (v) => Promise.resolve(v);

  window.toto = {
    projects: {
      list: () => ok(projects),
      get: (id) => ok(projects.find((p) => p.id === id) ?? null),
      create: (i) => ok({ ...projects[0], ...i, id: 'prj_new' }),
      update: (id, patch) => ok({ ...projects.find((p) => p.id === id), ...patch }),
      remove: () => ok(undefined)
    },
    categories: {
      list: (pid) => ok(categories.filter((c) => c.projectId === pid)),
      create: (i) => ok({ ...categories[0], ...i, id: 'cat_new' }),
      update: (id, patch) => ok({ ...categories.find((c) => c.id === id), ...patch }),
      remove: () => ok(undefined)
    },
    urls: {
      list: (pid) => ok(urls.filter((u) => u.projectId === pid)),
      add: () => ok({ added: urls[0], duplicate: false, invalid: false }),
      addBulk: () => ok({ added: 3, duplicates: 1, invalid: [] }),
      update: (id, patch) => ok({ ...urls.find((u) => u.id === id), ...patch }),
      remove: () => ok(undefined),
      removeMany: () => ok(undefined),
      move: () => ok(undefined),
      importFile: () => ok({ added: 0, duplicates: 0, invalid: [], cancelled: true }),
      resetState: () => ok(undefined)
    },
    scrape: {
      start: () => ok({ id: 'job_2', total: 6 }),
      pause: () => { progress = { ...progress, state: 'paused' }; emit('progress', progress); return ok(undefined); },
      resume: () => { progress = { ...progress, state: 'running' }; emit('progress', progress); return ok(undefined); },
      cancel: () => ok(undefined),
      retryFailed: () => ok({ id: 'job_3', total: 3 }),
      rescrape: () => ok({ id: 'job_4', total: 1 }),
      active: () => ok(progress),
      jobs: () => ok([
        { id: 'job_1', projectId: 'prj_1', categoryIds: ['cat_1'], urlIds: [], state: 'running', createdAt: iso(20), startedAt: iso(20), finishedAt: null, total: 54, completed: 38, failed: 3, warned: 4, skipped: 0, currentUrl: null, currentStage: null, label: 'Monitors' },
        { id: 'job_0', projectId: 'prj_1', categoryIds: [], urlIds: [], state: 'completed', createdAt: iso(200), startedAt: iso(200), finishedAt: iso(180), total: 15, completed: 15, failed: 0, warned: 1, skipped: 0, currentUrl: null, currentStage: null, label: 'Keyboards' }
      ]),
      testUrl: () => ok({ platform: 'shopify', reachable: true, status: 200, detail: 'Detected shopify (shopify-cdn, shopify-global).' })
    },
    products: {
      list: (q) => {
        let items = products;
        if (q.categoryId) {
          const ids = urls.filter((u) => u.categoryId === q.categoryId).map((u) => u.productId);
          items = items.filter((p) => ids.includes(p.id));
        }
        if (q.kind) items = items.filter((p) => p.kind === q.kind);
        if (q.onlyNeedingReview) items = items.filter((p) => p.worstSeverity && p.worstSeverity !== 'INFO');
        if (q.search) {
          const needle = q.search.toLowerCase();
          items = items.filter((p) => (p.title ?? '').toLowerCase().includes(needle) || p.sourceUrl.includes(needle));
        }
        return ok({ items, total: items.length });
      },
      get: (id) => ok(fullProduct(id)),
      remove: () => ok(undefined),
      trace: () => ok([]),
      patch: (id) => ok(fullProduct(id))
    },
    validation: {
      run: () => ok({ projectId: 'prj_1', ranAt: iso(0), productCount: products.length, issueCount: issues.length, bySeverity, blockingExport: bySeverity.ERROR + bySeverity.CRITICAL }),
      list: (pid, opts) => {
        let list = issues;
        if (opts && opts.severity) list = list.filter((i) => i.severity === opts.severity);
        if (opts && opts.productId) list = list.filter((i) => i.productId === opts.productId);
        return ok(list);
      },
      acknowledge: () => ok(undefined),
      clear: () => ok(undefined)
    },
    exports: {
      run: () => ok(exportsLog[0]),
      preview: () =>
        ok({
          headers: ['Handle', 'Title', 'Body (HTML)', 'Vendor', 'Product Category', 'Type', 'Tags', 'Published', 'Option1 Name', 'Option1 Value', 'Option2 Name', 'Option2 Value', 'Variant SKU', 'Variant Grams', 'Variant Inventory Qty', 'Variant Price', 'Variant Compare At Price', 'Image Src', 'Image Position', 'SEO Title'],
          rows: [
            ['ultrawide-34-curved', 'Ultrawide 34 Curved', '<h2>Built for long days</h2>', 'Atlas Supply', 'Electronics > Monitors', 'Electronics > Monitors', 'office, display', 'TRUE', 'Colour', 'Graphite', 'Size', '27"', 'ATL-DSP-GRA-0', '3200', '12', '499.00', '539.00', 'https://cdn…/a.jpg', '1', 'Ultrawide 34 Curved — Atlas Supply'],
            ['ultrawide-34-curved', '', '', '', '', '', '', '', '', 'Silver', '', '27"', 'ATL-DSP-SIL-1', '3350', '0', '519.00', '', 'https://cdn…/b.jpg', '2', ''],
            ['ultrawide-34-curved', '', '', '', '', '', '', '', '', 'Midnight', '', '32"', 'ATL-DSP-MID-2', '3500', '7', '539.00', '579.00', 'https://cdn…/c.jpg', '3', ''],
            ['studio-display-27', 'Studio Display 27', '<p>Colour-accurate panel.</p>', 'Atlas Supply', 'Electronics > Monitors', 'Electronics > Monitors', 'office', 'TRUE', 'Title', 'Default Title', '', '', 'ATL-SD27', '4100', '5', '899.00', '', 'https://cdn…/d.jpg', '1', 'Studio Display 27 — Atlas Supply']
          ],
          totalRows: 121,
          skipped: [{ productId: 'prd_13', title: 'Gaming 240hz 27', reason: 'A critical data-integrity problem was found. Fix or acknowledge it first.' }]
        }),
      history: () => ok(exportsLog),
      profiles: () =>
        ok([
          { id: 'shopify-legacy', format: 'shopify', label: 'Shopify — product import CSV', description: "Shopify's long-standing product import columns. Accepted by Products → Import.", columns: [] },
          { id: 'shopify-2024', format: 'shopify', label: 'Shopify — current export column names', description: 'The friendlier header names Shopify now uses when it exports products.', columns: [] },
          { id: 'woocommerce-default', format: 'woocommerce', label: 'WooCommerce — product CSV', description: "WooCommerce's built-in product CSV importer format.", columns: [] }
        ]),
      reveal: () => ok(undefined)
    },
    settings: {
      get: () => ok(settings),
      set: (patch) => { Object.assign(settings, patch); return ok(settings); }
    },
    dashboard: { stats: () => ok(stats) },
    logs: {
      list: () =>
        ok([
          { id: 'l1', ts: iso(1), level: 'info', scope: 'queue', message: 'Scraped: Ultrawide 34 Curved' },
          { id: 'l2', ts: iso(2), level: 'warn', scope: 'fetch', message: 'Host asked us to slow down (429); waiting 8s' },
          { id: 'l3', ts: iso(3), level: 'info', scope: 'engine', message: 'Shopify product JSON read from /products/x.js' },
          { id: 'l4', ts: iso(4), level: 'error', scope: 'queue', message: 'Could not scrape https://…/missing: That page does not exist (404).' }
        ])
    },
    system: {
      chooseDirectory: () => ok('/Users/rahul/Documents/ToTo Exports'),
      info: () => ok({ version: '1.0.0', electron: '33.3.1', chrome: '130.0.6723.44', node: '20.18.1', platform: 'darwin', dataDir: '/Users/rahul/Library/Application Support/ToTo Company/data' }),
      openExternal: () => ok(undefined)
    },
    on(channel, cb) {
      listeners[channel].push(cb);
      return () => {
        const i = listeners[channel].indexOf(cb);
        if (i >= 0) listeners[channel].splice(i, 1);
      };
    }
  };

  function emit(channel, payload) {
    for (const cb of listeners[channel]) cb(payload);
  }

  /* Hooks the screenshot script drives the app through. */
  window.__totoSetView = async (view) => {
    const mod = await import('/renderer/lib/state.js');
    mod.setView(view);
    await new Promise((r) => setTimeout(r, 120));
  };
  window.__totoSetProgress = (p) => {
    progress = p;
    emit('progress', p);
  };
})();
