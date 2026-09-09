/**
 * Extraction orchestrator.
 *
 * Escalation policy — always use the lightest method that answers correctly:
 *
 *   1. static fetch                  -> parse
 *   2. metadata / JSON-LD / microdata
 *   3. inline product JSON
 *   4. platform extractor (Shopify JSON / Woo Store API + variations payload)
 *   5. headless render                 (only when 1-4 left the product thin)
 *   6. variant interaction             (only when 5 still left variants unpriced)
 *
 * After each stage the result is scored; we stop as soon as the product is
 * complete enough, so a well-behaved Shopify page never opens a browser.
 */
import * as dom from '../dom';
import type { CheerioAPI } from '../dom';
import { createHash } from 'node:crypto';
import { emptyProduct, type CanonicalProduct } from '../../shared/canonical';
import type { AppSettings, ScrapeOutcome } from '../../shared/types';
import { newId } from '../db/store';
import { humanizeError, log } from '../util/logger';
import { normalizeUrl } from '../util/url';
import type { ExtractionContext, ExtractionLayer } from './context';
import { detectPlatform, looksLikeProductPage } from './detect';
import { Fetcher, type FetchLike } from './fetcher';
import { pruneImages, validateImageUrls } from './images';
import { Merger } from './merge';
import { deriveOptionsFromVariants, renumberImages, resolveFeaturedImage } from './productutil';
import { genericHtmlLayer, metaLayer, microdataLayer } from './extractors/generic';
import { interactionLayer } from './extractors/interaction';
import { jsonLdLayer } from './extractors/jsonld';
import { shopifyLayer } from './extractors/shopify';
import { wooLayer } from './extractors/woocommerce';

export interface ScrapeRequest {
  url: string;
  projectId: string;
  categoryId: string | null;
  categoryPath: string | null;
  /** Reuse this id when re-scraping so downstream references stay valid. */
  existingProductId?: string | null;
  onStage?: (stage: string) => void;
}

const STATIC_LAYERS: ExtractionLayer[] = [metaLayer, microdataLayer, jsonLdLayer, shopifyLayer, wooLayer, genericHtmlLayer];

export class ScrapeEngine {
  constructor(private fetcher: FetchLike, private settings: AppSettings) {}

  updateSettings(s: AppSettings): void {
    this.settings = s;
    if (this.fetcher instanceof Fetcher) {
      this.fetcher.updateConfig({
        concurrency: s.concurrency,
        perHostConcurrency: s.perHostConcurrency,
        perHostDelayMs: s.perHostDelayMs,
        respectRobotsTxt: s.respectRobotsTxt,
        maxRetries: s.maxRetries,
        retryBackoffMs: s.retryBackoffMs
      });
    }
  }

  async scrape(req: ScrapeRequest): Promise<ScrapeOutcome> {
    const started = Date.now();
    const stage = (s: string) => req.onStage?.(s);
    const layers: ScrapeOutcome['layers'] = [];
    const warnings: string[] = [];

    const product = emptyProduct(req.existingProductId ?? newId('prd_'), req.projectId, req.url);
    product.categoryId = req.categoryId;
    product.categoryPath = req.categoryPath;
    if (req.categoryPath) {
      product.provenance['categoryPath'] = { source: 'user', confidence: 'high', note: 'assigned in the application' };
    }

    try {
      /* ---------- robots ---------- */
      stage('Checking site rules');
      const permission = await this.fetcher.isAllowed(req.url, this.settings.userAgent);
      if (!permission.allowed) {
        return {
          ok: false,
          url: req.url,
          product: null,
          error: `This site's robots.txt asks automated tools not to read this page. ${permission.reason ?? ''}`.trim(),
          errorCode: 'ROBOTS_DISALLOW',
          warnings,
          layers,
          durationMs: Date.now() - started
        };
      }

      /* ---------- 1. static fetch ---------- */
      stage('Fetching page');
      const t0 = Date.now();
      const res = await this.fetcher.get(req.url, {
        timeoutMs: this.settings.requestTimeoutMs,
        userAgent: this.settings.userAgent
      });
      layers.push({ layer: 'fetch', ran: true, produced: res.body.length, ms: Date.now() - t0 });

      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.body || res.body.trim().length < 200) {
        // Almost certainly a shell rendered by JavaScript.
        warnings.push('The page returned almost no HTML, so it was opened in the built-in browser.');
      }

      let html = res.body;
      let finalUrl = res.finalUrl;
      let $ = dom.load(html);
      let detection = detectPlatform($, html, res.headers);
      let renderedWithBrowser = false;

      const ctx: ExtractionContext = {
        url: req.url,
        finalUrl,
        html,
        $,
        headers: res.headers,
        detection,
        harvest: null,
        interaction: null,
        renderedWithBrowser: false,
        fetcher: this.fetcher,
        settings: this.settings,
        product,
        merger: new Merger(product),
        warnings,
        snippets: {}
      };

      /* ---------- 2-4. static layers ---------- */
      await this.runLayers(ctx, STATIC_LAYERS, layers, stage);

      /* ---------- 5. escalate to the browser when needed ---------- */
      const needsBrowser =
        this.settings.browserRenderMode === 'always' ||
        (this.settings.browserRenderMode === 'auto' &&
          (this.isThin(product) || !looksLikeProductPage($, html) || html.trim().length < 2000));

      if (needsBrowser && this.settings.browserRenderMode !== 'never') {
        stage('Opening page in the built-in browser');
        const t1 = Date.now();
        const wantsInteraction =
          this.settings.enableVariantInteraction && this.variantsIncomplete(product) && this.looksVariable($, product);
        // Loaded lazily: the renderer needs Electron, and a run that never
        // escalates should not pull it in at all.
        const { renderPage } = await import('./renderer.js');
        const rendered = await renderPage(finalUrl, {
          userAgent: this.settings.userAgent,
          timeoutMs: this.settings.renderTimeoutMs,
          interactVariants: wantsInteraction
        });
        layers.push({
          layer: 'browser-render',
          ran: true,
          produced: rendered.ok ? rendered.html.length : 0,
          ms: Date.now() - t1,
          note: rendered.error ?? undefined
        });

        if (rendered.ok && rendered.html.length > html.length / 2) {
          html = rendered.html;
          finalUrl = rendered.finalUrl || finalUrl;
          $ = dom.load(html);
          detection = detectPlatform($, html, res.headers);
          renderedWithBrowser = true;
          ctx.html = html;
          ctx.$ = $;
          ctx.finalUrl = finalUrl;
          ctx.detection = detection;
          ctx.harvest = rendered.harvest;
          ctx.interaction = rendered.interaction;
          ctx.renderedWithBrowser = true;
          this.fetcher.clearCache();
          stage('Re-reading rendered page');
          await this.runLayers(ctx, STATIC_LAYERS, layers, stage, '(rendered)');
        } else if (!rendered.ok) {
          warnings.push('The page could not be fully rendered; data that loads via JavaScript may be missing.');
        }
      }

      /* ---------- 6. interaction ---------- */
      if (ctx.interaction?.length) {
        await this.runLayers(ctx, [interactionLayer], layers, stage);
      }

      /* ---------- finish ---------- */
      stage('Tidying images');
      pruneImages(ctx);
      renumberImages(ctx);
      resolveFeaturedImage(ctx);
      deriveOptionsFromVariants(ctx);
      this.finaliseKind(product);
      this.backfillProductLevelFromSingleVariant(ctx);
      this.reportDescriptionFallback(ctx);

      if (this.settings.validateImageUrls) {
        stage('Checking image links');
        const problems = await validateImageUrls(ctx);
        warnings.push(...problems);
      }

      product.sourcePlatform = detection.platform === 'unknown' ? product.sourcePlatform : detection.platform;
      product.layersUsed = layers.filter((l) => l.ran).map((l) => l.layer);
      product.scrapedAt = new Date().toISOString();
      product.contentHash = createHash('sha256').update(normalizeUrl(finalUrl) + html.length).digest('hex').slice(0, 16);
      product.debug = {
        detectedBy: detection.signals.join(', '),
        httpStatus: res.status,
        renderedWithBrowser,
        rawSnippets: this.settings.keepDebugSnippets ? ctx.snippets : undefined
      };

      if (!product.title) {
        return {
          ok: false,
          url: req.url,
          product: null,
          error: 'No product could be identified on this page. Check that the address points at a product, not a category or search page.',
          errorCode: 'NO_PRODUCT',
          warnings,
          layers,
          durationMs: Date.now() - started
        };
      }

      return { ok: true, url: req.url, product, error: null, errorCode: null, warnings, layers, durationMs: Date.now() - started };
    } catch (err) {
      const h = humanizeError(err);
      log.error('engine', `Failed to scrape ${req.url}`, h.detail);
      return {
        ok: false,
        url: req.url,
        product: null,
        error: h.message,
        errorCode: h.code,
        warnings,
        layers,
        durationMs: Date.now() - started
      };
    }
  }

  private async runLayers(
    ctx: ExtractionContext,
    list: ExtractionLayer[],
    log: ScrapeOutcome['layers'],
    stage: (s: string) => void,
    suffix = ''
  ): Promise<void> {
    for (const layer of list) {
      let applies = false;
      try {
        applies = layer.applies(ctx);
      } catch {
        applies = false;
      }
      if (!applies) {
        log.push({ layer: `${layer.id}${suffix}`, ran: false, produced: 0, ms: 0 });
        continue;
      }
      stage(`${layer.label}${suffix ? ' ' + suffix : ''}`);
      const t = Date.now();
      try {
        const r = await layer.run(ctx);
        log.push({ layer: `${layer.id}${suffix}`, ran: true, produced: r.produced, ms: Date.now() - t, note: r.note });
      } catch (err) {
        const h = humanizeError(err);
        ctx.warnings.push(`${layer.label} could not complete: ${h.message}`);
        log.push({ layer: `${layer.id}${suffix}`, ran: true, produced: 0, ms: Date.now() - t, note: h.message });
      }
    }
  }

  /**
   * Says so only if, after every layer has run, the description is still just
   * the page's meta tag. Checking this inside an early layer would warn on
   * every product.
   */
  private reportDescriptionFallback(ctx: ExtractionContext): void {
    const p = ctx.product;
    if (p.descriptionHtml) return;
    const prov = p.provenance['descriptionText'];
    if (!p.descriptionText) {
      ctx.warnings.push('No product description was found on this page.');
      return;
    }
    if (prov?.source === 'heuristic') {
      ctx.warnings.push(
        "No product description was found on the page, so the page's meta description was used instead."
      );
    }
  }

  /** A product is "thin" when the essentials for an import are still missing. */
  private isThin(p: CanonicalProduct): boolean {
    if (!p.title) return true;
    if (p.price === null && p.priceMin === null && p.variants.every((v) => v.price === null)) return true;
    if (p.images.length === 0) return true;
    if (p.variants.length === 0 && p.sku === null && p.stockStatus === 'unknown') return true;
    return false;
  }

  private variantsIncomplete(p: CanonicalProduct): boolean {
    if (p.variants.length === 0) return true;
    return p.variants.some((v) => v.price === null);
  }

  private looksVariable($: CheerioAPI, p: CanonicalProduct): boolean {
    if (p.options.length > 0) return true;
    return $('form.variations_form select[name^="attribute_"], select[name="options[]"], .single-option-selector, .product-form__input select, input[type="radio"][name*="option" i]').length > 0;
  }

  private finaliseKind(p: CanonicalProduct): void {
    if (p.kind === 'grouped' || p.kind === 'external') return;
    const meaningful = p.variants.filter((v) => v.options.length > 0);
    if (meaningful.length > 1) p.kind = 'variable';
    else if (p.variants.length <= 1) p.kind = 'simple';
    else if (p.variants.length > 1) p.kind = 'variable';
    else if (p.kind === 'unknown') p.kind = 'simple';
  }

  /**
   * When a product has exactly one variant with no option axes, its values ARE
   * the product's values. This never copies between distinct variants.
   */
  private backfillProductLevelFromSingleVariant(ctx: ExtractionContext): void {
    const p = ctx.product;
    if (p.variants.length !== 1) return;
    const v = p.variants[0];
    if (v.options.length > 0) return;
    const src = p.provenance['variants']?.source ?? 'html';
    const m = ctx.merger;
    m.set('price', v.price, src, 'single variant');
    m.set('compareAtPrice', v.compareAtPrice, src, 'single variant');
    m.set('regularPrice', v.regularPrice, src, 'single variant');
    m.set('salePrice', v.salePrice, src, 'single variant');
    m.set('sku', v.sku, src, 'single variant');
    m.set('barcode', v.barcode, src, 'single variant');
    m.set('weight', v.weight, src, 'single variant');
    m.set('weightUnit', v.weightUnit, src, 'single variant');
    m.set('inventoryQuantity', v.inventoryQuantity, src, 'single variant');
    m.set('stockStatus', v.stockStatus === 'unknown' ? null : v.stockStatus, src, 'single variant');
  }
}

export function createEngine(settings: AppSettings): { engine: ScrapeEngine; fetcher: Fetcher } {
  const fetcher = new Fetcher({
    concurrency: settings.concurrency,
    perHostConcurrency: settings.perHostConcurrency,
    perHostDelayMs: settings.perHostDelayMs,
    respectRobotsTxt: settings.respectRobotsTxt,
    maxRetries: settings.maxRetries,
    retryBackoffMs: settings.retryBackoffMs
  });
  return { engine: new ScrapeEngine(fetcher, settings), fetcher };
}
