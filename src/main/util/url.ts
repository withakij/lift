const TRACKING_PARAMS = [
  /^utm_/i,
  /^gclid$/i,
  /^fbclid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^_ga$/i,
  /^ref$/i,
  /^referrer$/i,
  /^srsltid$/i,
  /^igshid$/i,
  /^ttclid$/i
];

export function isProbablyUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return false;
  return /^https?:\/\/[^/\s]+\.[^/\s]+/i.test(s);
}

/** Adds a scheme when the operator pasted a bare host, then validates. */
export function coerceUrl(raw: string): string | null {
  let s = raw.trim().replace(/^[<"'(]+|[>"')]+$/g, '');
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) {
    if (!/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return null;
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Canonical form used for duplicate detection only — never for fetching.
 * Lowercases the host, drops the fragment, strips tracking params, sorts the
 * remaining query, and removes a single trailing slash.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    u.protocol = 'https:';
    const keep: Array<[string, string]> = [];
    u.searchParams.forEach((v, k) => {
      if (!TRACKING_PARAMS.some((re) => re.test(k))) keep.push([k, v]);
    });
    keep.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
    u.search = '';
    for (const [k, v] of keep) u.searchParams.append(k, v);
    // Trailing slashes are not meaningful for identity; strip from the path so
    // "/p/x/?a=1" and "/p/x?a=1" are recognised as the same product.
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function absoluteUrl(candidate: string | null | undefined, base: string): string | null {
  if (!candidate) return null;
  let c = candidate.trim();
  if (!c) return null;
  if (c.startsWith('//')) c = `https:${c}`;
  try {
    return new URL(c, base).toString();
  } catch {
    return null;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** "https://shop.com/products/x?variant=1" -> "x" */
export function shopifyHandleFromUrl(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/\/products\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

/** Strips Shopify CDN size suffixes so the same photo is not counted twice. */
export function imageIdentity(url: string): string {
  let s = url.split('?')[0];
  s = s.replace(/_(\d{2,4}x\d{0,4}|\d{2,4}x|x\d{2,4}|small|medium|large|grande|compact|pico|icon|thumb|master)(@\dx)?(?=\.[a-z]{3,4}$)/i, '');
  s = s.replace(/-\d{2,4}x\d{2,4}(?=\.[a-z]{3,4}$)/i, ''); // WordPress -800x800.jpg
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  return s.toLowerCase();
}

/** Upgrades a WordPress resized image URL back to the original file. */
export function upscaleWordpressImage(url: string): string {
  return url.replace(/-\d{2,4}x\d{2,4}(\.[a-z]{3,4})(\?.*)?$/i, '$1$2');
}

/** Requests the largest Shopify CDN rendition instead of a thumbnail. */
export function upscaleShopifyImage(url: string): string {
  if (!/cdn\.shopify\.com|\/cdn\/shop\//.test(url)) return url;
  const [base, query] = url.split('?');
  const cleaned = base.replace(
    /_(\d{2,4}x\d{0,4}|\d{2,4}x|x\d{2,4}|small|medium|large|grande|compact|pico|icon|thumb)(@\dx)?(?=\.[a-z]{3,4}$)/i,
    ''
  );
  if (!query) return cleaned;
  const params = new URLSearchParams(query);
  params.delete('width');
  params.delete('height');
  params.delete('crop');
  const rest = params.toString();
  return rest ? `${cleaned}?${rest}` : cleaned;
}
