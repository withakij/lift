/**
 * Forgiving HTML parser.
 *
 * Not a spec-complete HTML5 tree builder — a stack machine with implied end
 * tags, which is what real-world storefront markup needs. It never executes
 * anything and never fetches anything; raw-text elements (script/style) are
 * captured verbatim as text so their contents can be read but never parsed as
 * markup.
 */
import {
  appendChild,
  createElement,
  decodeHtmlEntities,
  escapeAttr,
  escapeText,
  isElement,
  type AnyNode,
  type DocumentNode,
  type ElementNode,
  type ParentNode
} from './nodes';

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr', 'basefont', 'bgsound', 'frame', 'keygen'
]);

const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'template', 'textarea', 'title']);

/** tag -> tags it implicitly closes when opened. */
const IMPLIED_END: Record<string, string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  p: ['p'],
  option: ['option'],
  optgroup: ['optgroup', 'option'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  thead: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
  tbody: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
  tfoot: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
  colgroup: ['colgroup', 'col'],
  head: [],
  body: [],
  address: ['p'], article: ['p'], aside: ['p'], blockquote: ['p'], details: ['p'],
  div: [], fieldset: ['p'], figcaption: ['p'], figure: ['p'], footer: ['p'],
  form: ['p'], h1: ['p'], h2: ['p'], h3: ['p'], h4: ['p'], h5: ['p'], h6: ['p'],
  header: ['p'], hr: ['p'], main: ['p'], nav: ['p'], ol: ['p'], pre: ['p'],
  section: ['p'], table: ['p'], ul: ['p']
};

/** A tag inside one of these may not implicitly close past the boundary. */
const SCOPE_BOUNDARY = new Set(['table', 'template', 'html', 'body', 'ul', 'ol', 'select', 'form']);

export interface ParseOptions {
  /** Fragment mode skips the implicit html/head/body scaffolding. */
  fragment?: boolean;
}

export function parseHtml(html: string, opts: ParseOptions = {}): DocumentNode {
  const doc: DocumentNode = { type: 'document', children: [], parent: null };
  const stack: ParentNode[] = [doc];
  const top = (): ParentNode => stack[stack.length - 1];

  let i = 0;
  const len = html.length;

  const pushText = (raw: string, decode = true): void => {
    if (raw === '') return;
    const data = decode ? decodeHtmlEntities(raw) : raw;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === 'text') last.data += data;
    else appendChild(parent, { type: 'text', data, parent: null });
  };

  const openElement = (tagName: string, attribs: Record<string, string>, selfClosing: boolean): void => {
    const implied = IMPLIED_END[tagName];
    if (implied && implied.length) {
      for (let s = stack.length - 1; s > 0; s--) {
        const node = stack[s];
        if (!isElement(node)) break;
        if (implied.includes(node.tagName)) {
          stack.length = s;
          continue;
        }
        if (SCOPE_BOUNDARY.has(node.tagName)) break;
        break;
      }
    }
    const el = createElement(tagName, attribs);
    appendChild(top(), el);
    if (!selfClosing && !VOID_ELEMENTS.has(tagName)) stack.push(el);
  };

  const closeElement = (tagName: string): void => {
    for (let s = stack.length - 1; s > 0; s--) {
      const node = stack[s];
      if (isElement(node) && node.tagName === tagName) {
        stack.length = s;
        return;
      }
    }
    // Stray close tag: ignore it, which is what browsers do.
  };

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    /* comment */
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const stop = end < 0 ? len : end + 3;
      appendChild(top(), { type: 'comment', data: html.slice(lt + 4, end < 0 ? len : end), parent: null });
      i = stop;
      continue;
    }

    /* doctype / processing instruction */
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      const stop = end < 0 ? len : end + 1;
      appendChild(top(), { type: 'directive', data: html.slice(lt + 1, end < 0 ? len : end), parent: null });
      i = stop;
      continue;
    }

    /* close tag */
    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt);
      if (end < 0) {
        pushText(html.slice(lt));
        break;
      }
      const name = html.slice(lt + 2, end).trim().toLowerCase().split(/[\s/]/)[0];
      if (name) closeElement(name);
      i = end + 1;
      continue;
    }

    /* open tag */
    const tagMatch = /^<([a-zA-Z][a-zA-Z0-9:_.-]*)/.exec(html.slice(lt, lt + 64));
    if (!tagMatch) {
      pushText('<');
      i = lt + 1;
      continue;
    }
    const tagName = tagMatch[1].toLowerCase();
    const parsed = parseAttributes(html, lt + tagMatch[0].length);
    openElement(tagName, parsed.attribs, parsed.selfClosing);
    i = parsed.next;

    /* raw text content */
    if (RAW_TEXT.has(tagName) && !parsed.selfClosing && !VOID_ELEMENTS.has(tagName)) {
      const closeRe = new RegExp(`</${tagName}\\s*>`, 'i');
      const rest = html.slice(i);
      const m = closeRe.exec(rest);
      const raw = m ? rest.slice(0, m.index) : rest;
      const decode = tagName === 'title' || tagName === 'textarea';
      if (raw) {
        const el = top();
        appendChild(el, { type: 'text', data: decode ? decodeHtmlEntities(raw) : raw, parent: null });
      }
      closeElement(tagName);
      i += m ? m.index + m[0].length : rest.length;
    }
  }

  if (!opts.fragment) ensureStructure(doc);
  return doc;
}

interface AttrParse {
  attribs: Record<string, string>;
  selfClosing: boolean;
  next: number;
}

function parseAttributes(html: string, start: number): AttrParse {
  const attribs: Record<string, string> = {};
  let i = start;
  let selfClosing = false;
  const len = html.length;

  for (;;) {
    while (i < len && /\s/.test(html[i])) i++;
    if (i >= len) break;
    if (html[i] === '>') {
      i++;
      break;
    }
    if (html[i] === '/' && html[i + 1] === '>') {
      selfClosing = true;
      i += 2;
      break;
    }
    if (html[i] === '/') {
      i++;
      continue;
    }

    let nameStart = i;
    while (i < len && !/[\s=/>]/.test(html[i])) i++;
    const name = html.slice(nameStart, i).toLowerCase();
    if (!name) {
      i++;
      continue;
    }

    while (i < len && /\s/.test(html[i])) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < len && /\s/.test(html[i])) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const end = html.indexOf(q, i + 1);
        const stop = end < 0 ? len : end;
        value = html.slice(i + 1, stop);
        i = end < 0 ? len : end + 1;
      } else {
        const vStart = i;
        while (i < len && !/[\s>]/.test(html[i])) i++;
        value = html.slice(vStart, i);
      }
    } else {
      value = '';
    }
    if (!(name in attribs)) attribs[name] = decodeHtmlEntities(value);
  }
  return { attribs, selfClosing, next: i };
}

/** Guarantees html/head/body exist so selectors like `body` behave. */
function ensureStructure(doc: DocumentNode): void {
  const html = doc.children.find((n) => isElement(n) && n.tagName === 'html') as ElementNode | undefined;
  if (html) {
    if (!html.children.some((n) => isElement(n) && n.tagName === 'body')) {
      const body = createElement('body');
      const head = html.children.find((n) => isElement(n) && n.tagName === 'head');
      const moved = html.children.filter((n) => n !== head);
      for (const m of moved) {
        const idx = html.children.indexOf(m);
        if (idx >= 0) html.children.splice(idx, 1);
        appendChild(body, m);
      }
      appendChild(html, body);
    }
    return;
  }
  const htmlEl = createElement('html');
  const existingHead = doc.children.find((n) => isElement(n) && n.tagName === 'head') as ElementNode | undefined;
  const existingBody = doc.children.find((n) => isElement(n) && n.tagName === 'body') as ElementNode | undefined;
  const head = existingHead ?? createElement('head');
  const body = existingBody ?? createElement('body');
  const existing = [...doc.children];
  doc.children.length = 0;
  const HEAD_TAGS = new Set(['meta', 'title', 'link', 'base', 'style', 'script']);
  for (const n of existing) {
    if (n === head || n === body) continue;
    if (isElement(n) && HEAD_TAGS.has(n.tagName) && body.children.length === 0) appendChild(head, n);
    else appendChild(body, n);
  }
  appendChild(htmlEl, head);
  appendChild(htmlEl, body);
  appendChild(doc, htmlEl);
}

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

export function serializeChildren(node: ParentNode): string {
  return node.children.map(serialize).join('');
}

export function serialize(node: AnyNode): string {
  switch (node.type) {
    case 'text': {
      const parentTag = node.parent && isElement(node.parent) ? node.parent.tagName : '';
      if (RAW_TEXT.has(parentTag) && parentTag !== 'title' && parentTag !== 'textarea') return node.data;
      return escapeText(node.data);
    }
    case 'comment':
      return `<!--${node.data}-->`;
    case 'directive':
      return `<${node.data}>`;
    case 'document':
      return serializeChildren(node);
    case 'element': {
      const attrs = Object.entries(node.attribs)
        .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`))
        .join('');
      if (VOID_ELEMENTS.has(node.tagName)) return `<${node.tagName}${attrs}>`;
      return `<${node.tagName}${attrs}>${serializeChildren(node)}</${node.tagName}>`;
    }
  }
}

export function textContent(node: AnyNode): string {
  if (node.type === 'text') return node.data;
  if (node.type === 'comment' || node.type === 'directive') return '';
  if (node.type === 'element' && (node.tagName === 'script' || node.tagName === 'style')) return '';
  return node.children.map(textContent).join('');
}

export { VOID_ELEMENTS, RAW_TEXT };
