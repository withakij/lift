import type { CheerioAPI } from '../dom';
import type { SourcePlatform } from '../../shared/canonical';

export interface PlatformDetection {
  platform: SourcePlatform;
  /** 0..1 — how sure we are. */
  score: number;
  signals: string[];
}

/**
 * Platform detection from markup + headers. Multiple weak signals are combined
 * rather than trusting any single one, because WooCommerce themes vary wildly
 * and some Shopify stores are heavily customised.
 */
export function detectPlatform($: CheerioAPI, html: string, headers: Record<string, string>): PlatformDetection {
  const signals: string[] = [];
  let shopify = 0;
  let woo = 0;
  let wp = 0;

  const head = html.slice(0, 400000);

  /* ---- Shopify ---- */
  if (/cdn\.shopify\.com|cdn\/shop\/(files|products)/i.test(head)) {
    shopify += 3;
    signals.push('shopify-cdn');
  }
  if (/Shopify\.(theme|shop|currency|routes)/.test(head)) {
    shopify += 4;
    signals.push('shopify-global');
  }
  if (/ShopifyAnalytics/.test(head)) {
    shopify += 3;
    signals.push('shopify-analytics');
  }
  if ($('script[src*="shopify"]').length) {
    shopify += 2;
    signals.push('shopify-script');
  }
  if (headers['x-shopid'] || headers['x-shopify-stage'] || headers['x-sorting-hat-shopid']) {
    shopify += 5;
    signals.push('shopify-header');
  }
  if ($('meta[name="shopify-checkout-api-token"]').length) {
    shopify += 4;
    signals.push('shopify-checkout-token');
  }
  if (/"product":\s*{[^}]*"variants"/.test(head) && /Shopify/.test(head)) shopify += 1;

  /* ---- WooCommerce ---- */
  if ($('body').attr('class')?.match(/woocommerce/i)) {
    woo += 4;
    signals.push('woo-body-class');
  }
  if (/wp-content\/plugins\/woocommerce/i.test(head)) {
    woo += 4;
    signals.push('woo-plugin-asset');
  }
  if ($('form.variations_form, .woocommerce div.product, .woocommerce-product-gallery').length) {
    woo += 4;
    signals.push('woo-markup');
  }
  if (/woocommerce_params|wc_add_to_cart_params|wc-ajax/i.test(head)) {
    woo += 3;
    signals.push('woo-js-params');
  }
  if ($('meta[name="generator"][content*="WooCommerce" i]').length) {
    woo += 5;
    signals.push('woo-generator');
  }

  /* ---- WordPress (without Woo) ---- */
  if (/wp-content|wp-includes|wp-json/i.test(head)) {
    wp += 3;
    signals.push('wordpress-assets');
  }
  if ($('meta[name="generator"][content*="WordPress" i]').length) {
    wp += 3;
    signals.push('wordpress-generator');
  }
  if ($('link[rel="https://api.w.org/"]').length) {
    wp += 2;
    signals.push('wp-api-link');
  }

  /* ---- others (detected so we can say "unsupported" honestly) ---- */
  let other: SourcePlatform | null = null;
  let otherScore = 0;
  if (/cdn\d*\.bigcommerce\.com|bigcommerce\.com\/s-/i.test(head)) {
    other = 'bigcommerce';
    otherScore = 5;
    signals.push('bigcommerce');
  } else if (/Magento_|mage\/|static\/version\d+\/frontend/i.test(head)) {
    other = 'magento';
    otherScore = 5;
    signals.push('magento');
  } else if (/static1\.squarespace\.com|Static\.SQUARESPACE_CONTEXT/i.test(head)) {
    other = 'squarespace';
    otherScore = 5;
    signals.push('squarespace');
  }

  const scores: Array<[SourcePlatform, number]> = [
    ['shopify', shopify],
    ['woocommerce', woo],
    ['wordpress-generic', woo > 0 ? 0 : wp]
  ];
  if (other) scores.push([other, otherScore]);

  scores.sort((a, b) => b[1] - a[1]);
  const [platform, best] = scores[0];
  if (best <= 0) return { platform: 'unknown', score: 0, signals };
  return { platform, score: Math.min(1, best / 8), signals };
}

/** True when the page looks like a single product detail page at all. */
export function looksLikeProductPage($: CheerioAPI, html: string): boolean {
  if ($('script[type="application/ld+json"]').toArray().some((n) => /"@type"\s*:\s*"?Product/i.test($(n).html() ?? ''))) {
    return true;
  }
  if ($('meta[property="og:type"][content="product"], meta[property="product:price:amount"]').length) return true;
  if ($('[itemtype*="schema.org/Product" i]').length) return true;
  if ($('form.variations_form, form.cart, .single-product, .product-single, .product__info').length) return true;
  if (/\/products\/[^/?#]+/.test(html.slice(0, 3000)) && /"variants"\s*:/.test(html)) return true;
  return false;
}
