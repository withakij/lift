/**
 * Minimal DOM used by the extraction layers.
 *
 * The application deliberately ships with no third-party runtime dependencies:
 * a scraper's HTML parser is the component most exposed to hostile input, so it
 * is small, readable, and entirely under our control. Nothing here executes
 * scripts, resolves entities into markup, or follows references.
 */

export type NodeType = 'document' | 'element' | 'text' | 'comment' | 'directive';

export interface BaseNode {
  type: NodeType;
  parent: ParentNode | null;
}

export interface TextNode extends BaseNode {
  type: 'text';
  data: string;
}

export interface CommentNode extends BaseNode {
  type: 'comment';
  data: string;
}

export interface DirectiveNode extends BaseNode {
  type: 'directive';
  data: string;
}

export interface ElementNode extends BaseNode {
  type: 'element';
  tagName: string;
  attribs: Record<string, string>;
  children: AnyNode[];
}

export interface DocumentNode extends BaseNode {
  type: 'document';
  children: AnyNode[];
}

export type ParentNode = ElementNode | DocumentNode;
export type AnyNode = ElementNode | TextNode | CommentNode | DirectiveNode | DocumentNode;

export function isElement(n: AnyNode | null | undefined): n is ElementNode {
  return !!n && n.type === 'element';
}

export function isText(n: AnyNode | null | undefined): n is TextNode {
  return !!n && n.type === 'text';
}

export function isParent(n: AnyNode | null | undefined): n is ParentNode {
  return !!n && (n.type === 'element' || n.type === 'document');
}

export function createElement(tagName: string, attribs: Record<string, string> = {}): ElementNode {
  return { type: 'element', tagName, attribs, children: [], parent: null };
}

export function appendChild(parent: ParentNode, child: AnyNode): void {
  child.parent = parent;
  parent.children.push(child);
}

export function removeNode(node: AnyNode): void {
  const p = node.parent;
  if (!p) return;
  const i = p.children.indexOf(node);
  if (i >= 0) p.children.splice(i, 1);
  node.parent = null;
}

export function replaceNode(node: AnyNode, replacements: AnyNode[]): void {
  const p = node.parent;
  if (!p) return;
  const i = p.children.indexOf(node);
  if (i < 0) return;
  for (const r of replacements) r.parent = p;
  p.children.splice(i, 1, ...replacements);
  node.parent = null;
}

export function childElements(n: ParentNode): ElementNode[] {
  return n.children.filter(isElement);
}

/** Depth-first walk over every descendant element. */
export function* walkElements(root: ParentNode): Generator<ElementNode> {
  const stack: AnyNode[] = [...root.children];
  while (stack.length) {
    const n = stack.shift()!;
    if (isElement(n)) {
      yield n;
      if (n.children.length) stack.unshift(...n.children);
    }
  }
}

export function classListOf(el: ElementNode): string[] {
  const c = el.attribs['class'];
  if (!c) return [];
  return c.split(/\s+/).filter(Boolean);
}

export function getAttr(el: ElementNode, name: string): string | undefined {
  return el.attribs[name.toLowerCase()];
}

/* ------------------------------------------------------------------ */
/* Entities                                                            */
/* ------------------------------------------------------------------ */

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', deg: '°', plusmn: '±', times: '×', divide: '÷',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  laquo: '«', raquo: '»', dagger: '†', permil: '‰', prime: '′', Prime: '″',
  larr: '←', rarr: '→', harr: '↔', darr: '↓', uarr: '↑', shy: '­',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '‌', zwj: '‍'
};

export function decodeHtmlEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED[body];
    return named ?? whole;
  });
}

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
