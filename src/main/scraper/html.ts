/**
 * Description handling.
 *
 * The goal is to keep everything that makes a description *useful* after
 * import — headings, paragraphs, lists, tables, emphasis, links, images — and
 * to strip everything that is dangerous or store-specific: scripts, styles,
 * event handlers, javascript: URLs, tracking pixels, and the source theme's
 * own layout wrappers.
 */
import * as dom from '../dom';
import type { AnyNode, Element } from '../dom';
import { absoluteUrl } from '../util/url';

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'div', 'span', 'section', 'article',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'q', 'cite', 'abbr',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'img', 'figure', 'figcaption', 'picture', 'source',
  'video', 'audio'
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title', 'width', 'height', 'srcset', 'loading']),
  source: new Set(['src', 'srcset', 'type', 'media']),
  video: new Set(['src', 'controls', 'poster', 'width', 'height']),
  audio: new Set(['src', 'controls']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  '*': new Set(['title'])
};

/** Nodes removed outright, contents and all. */
const DROP_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'object', 'embed', 'form', 'input', 'button',
  'select', 'textarea', 'svg', 'canvas', 'template', 'link', 'meta',
  '[id*="gtm" i]', '[class*="gtm" i]', '[class*="analytics" i]', '[id*="analytics" i]',
  '[class*="tracking" i]', '[class*="pixel" i]', '[class*="cookie" i]',
  '[class*="add-to-cart" i]', '[class*="addtocart" i]', '[class*="share" i]',
  '[class*="breadcrumb" i]', '[class*="review-form" i]', '[class*="wishlist" i]',
  'img[width="1"][height="1"]', 'img[src*="facebook.com/tr"]', 'img[src*="google-analytics"]'
];

const DANGEROUS_URL = /^\s*(javascript|vbscript|data:text\/html)/i;

export interface SanitiseResult {
  html: string;
  text: string;
  /** True when we removed something meaningful (reported as an INFO issue). */
  strippedSomething: boolean;
  imageUrls: string[];
}

export function sanitiseDescription(rawHtml: string | null | undefined, baseUrl: string): SanitiseResult {
  if (!rawHtml || !rawHtml.trim()) {
    return { html: '', text: '', strippedSomething: false, imageUrls: [] };
  }

  const $ = dom.load(`<div id="__toto_root">${rawHtml}</div>`, null, false);
  const root = $('#__toto_root');
  let stripped = false;

  for (const sel of DROP_SELECTORS) {
    const found = root.find(sel);
    if (found.length) stripped = true;
    found.remove();
  }

  // Comments carry theme cruft and occasionally conditional scripts.
  root
    .find('*')
    .contents()
    .filter((_, n) => (n as AnyNode).type === 'comment')
    .remove();

  const imageUrls: string[] = [];

  root.find('*').each((_, node) => {
    const el = node as Element;
    const tag = el.tagName?.toLowerCase();
    if (!tag) return;

    if (!ALLOWED_TAGS.has(tag)) {
      // Keep the words, drop the wrapper.
      stripped = true;
      $(el).replaceWith($(el).contents());
      return;
    }

    const allowed = ALLOWED_ATTRS[tag] ?? new Set<string>();
    const universal = ALLOWED_ATTRS['*'];
    for (const attr of Object.keys(el.attribs ?? {})) {
      const lower = attr.toLowerCase();
      if (lower.startsWith('on')) {
        delete el.attribs[attr];
        stripped = true;
        continue;
      }
      if (!allowed.has(lower) && !universal.has(lower)) {
        delete el.attribs[attr];
        continue;
      }
      const value = el.attribs[attr];
      if ((lower === 'href' || lower === 'src' || lower === 'srcset' || lower === 'poster') && DANGEROUS_URL.test(value)) {
        delete el.attribs[attr];
        stripped = true;
      }
    }

    if (tag === 'a') {
      const href = el.attribs?.href;
      const abs = absoluteUrl(href, baseUrl);
      if (abs) el.attribs.href = abs;
      else if (href) delete el.attribs.href;
      if (el.attribs?.target === '_blank') el.attribs.rel = 'noopener noreferrer';
    }

    if (tag === 'img') {
      const lazy = el.attribs?.['data-src'] ?? el.attribs?.['data-lazy-src'] ?? el.attribs?.['data-original'];
      const src = el.attribs?.src && !el.attribs.src.startsWith('data:image/gif') ? el.attribs.src : lazy;
      const abs = absoluteUrl(src, baseUrl);
      if (abs) {
        el.attribs.src = abs;
        imageUrls.push(abs);
      } else {
        $(el).remove();
        return;
      }
      if (el.attribs?.srcset) delete el.attribs.srcset;
    }
  });

  // Collapse wrappers that ended up empty.
  root.find('div,span,section,article,p').each((_, node) => {
    const $n = $(node as Element);
    if (!$n.text().trim() && $n.find('img,video,audio,br,hr,table').length === 0) $n.remove();
  });

  const html = (root.html() ?? '').trim();
  const text = htmlToText(html);
  return { html, text, strippedSomething: stripped, imageUrls };
}

export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const $ = dom.load(html, null, false);
  $('br').replaceWith('\n');
  $('p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote').each((_, el) => {
    $(el).append('\n');
  });
  $('li').each((_, el) => {
    $(el).prepend('• ');
  });
  return $.root()
    .text()
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

/** Rough well-formedness check used by the validation engine. */
export function looksMalformed(html: string | null): string | null {
  if (!html) return null;
  const opens = (html.match(/<([a-z][a-z0-9]*)\b[^>]*(?<!\/)>/gi) ?? []).length;
  const closes = (html.match(/<\/([a-z][a-z0-9]*)\s*>/gi) ?? []).length;
  const voidish = (html.match(/<(br|hr|img|input|meta|link|source|col)\b[^>]*>/gi) ?? []).length;
  if (opens - voidish - closes > 4) return 'Unclosed HTML tags detected in the description.';
  if (/<\s*script|onerror\s*=|onload\s*=/i.test(html)) return 'Description still contains script-like content.';
  if (/&[a-z]+(?![a-z;])/i.test(html.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, ''))) {
    return 'Description contains malformed HTML entities.';
  }
  return null;
}
