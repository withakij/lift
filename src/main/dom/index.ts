/**
 * A small jQuery-shaped façade over the in-house DOM, exposing only the
 * traversal and mutation the extraction and sanitising code needs.
 */
import {
  appendChild,
  classListOf,
  createElement,
  isElement,
  removeNode,
  replaceNode,
  walkElements,
  type AnyNode,
  type DocumentNode,
  type ElementNode,
  type ParentNode
} from './nodes';
import { parseHtml, serialize, serializeChildren, textContent } from './parser';
import { matches, querySelectorAll } from './selector';

export type { AnyNode, ElementNode, ParentNode, DocumentNode } from './nodes';
export type Element = ElementNode;

type Selectable = string | AnyNode | AnyNode[] | Query | null | undefined;

export class Query {
  readonly nodes: AnyNode[];

  constructor(nodes: AnyNode[], private readonly root: DocumentNode) {
    this.nodes = nodes;
  }

  get length(): number {
    return this.nodes.length;
  }

  private wrap(nodes: AnyNode[]): Query {
    return new Query(dedupe(nodes), this.root);
  }

  private elements(): ElementNode[] {
    return this.nodes.filter(isElement);
  }

  toArray(): AnyNode[] {
    return [...this.nodes];
  }

  get(): AnyNode[];
  get(i: number): AnyNode | undefined;
  get(i?: number): AnyNode[] | AnyNode | undefined {
    return i === undefined ? [...this.nodes] : this.nodes[i];
  }

  eq(i: number): Query {
    const n = i < 0 ? this.nodes[this.nodes.length + i] : this.nodes[i];
    return this.wrap(n ? [n] : []);
  }

  first(): Query {
    return this.eq(0);
  }

  last(): Query {
    return this.eq(-1);
  }

  find(selector: string): Query {
    const out: AnyNode[] = [];
    for (const n of this.nodes) {
      if (n.type === 'element' || n.type === 'document') {
        out.push(...querySelectorAll(n, selector));
      }
    }
    return this.wrap(out);
  }

  children(selector?: string): Query {
    const out: ElementNode[] = [];
    for (const n of this.nodes) {
      if (n.type !== 'element' && n.type !== 'document') continue;
      for (const c of n.children) {
        if (isElement(c) && (!selector || matches(c, selector))) out.push(c);
      }
    }
    return this.wrap(out);
  }

  contents(): Query {
    const out: AnyNode[] = [];
    for (const n of this.nodes) {
      if (n.type === 'element' || n.type === 'document') out.push(...n.children);
    }
    return new Query(out, this.root);
  }

  parent(): Query {
    return this.wrap(this.nodes.map((n) => n.parent).filter((p): p is ParentNode => !!p));
  }

  closest(selector: string): Query {
    const out: ElementNode[] = [];
    for (const n of this.nodes) {
      let cur: AnyNode | null = n;
      while (cur) {
        if (isElement(cur) && matches(cur, selector)) {
          out.push(cur);
          break;
        }
        cur = cur.parent;
      }
    }
    return this.wrap(out);
  }

  is(selector: string): boolean {
    return this.elements().some((e) => matches(e, selector));
  }

  hasClass(name: string): boolean {
    return this.elements().some((e) => classListOf(e).includes(name));
  }

  filter(pred: string | ((index: number, el: AnyNode) => boolean)): Query {
    if (typeof pred === 'string') {
      return this.wrap(this.elements().filter((e) => matches(e, pred)));
    }
    return new Query(this.nodes.filter((n, i) => pred(i, n)), this.root);
  }

  not(selector: string): Query {
    return this.wrap(this.elements().filter((e) => !matches(e, selector)));
  }

  each(cb: (index: number, el: AnyNode) => void | false): Query {
    for (let i = 0; i < this.nodes.length; i++) {
      if (cb(i, this.nodes[i]) === false) break;
    }
    return this;
  }

  map<T>(cb: (index: number, el: AnyNode) => T): MappedQuery<T> {
    return new MappedQuery(this.nodes.map((n, i) => cb(i, n)));
  }

  attr(name: string): string | undefined;
  attr(name: string, value: string): Query;
  attr(name: string, value?: string): string | undefined | Query {
    if (value === undefined) {
      const el = this.elements()[0];
      return el ? el.attribs[name.toLowerCase()] : undefined;
    }
    for (const e of this.elements()) e.attribs[name.toLowerCase()] = value;
    return this;
  }

  removeAttr(name: string): Query {
    for (const e of this.elements()) delete e.attribs[name.toLowerCase()];
    return this;
  }

  text(): string {
    return this.nodes.map(textContent).join('');
  }

  html(): string | null;
  html(content: string): Query;
  html(content?: string): string | null | Query {
    if (content === undefined) {
      const n = this.nodes[0];
      if (!n) return null;
      if (n.type === 'element' || n.type === 'document') return serializeChildren(n);
      return null;
    }
    for (const n of this.nodes) {
      if (n.type !== 'element' && n.type !== 'document') continue;
      n.children.length = 0;
      const frag = parseHtml(content, { fragment: true });
      for (const c of [...frag.children]) appendChild(n, c);
    }
    return this;
  }

  toString(): string {
    return this.nodes.map(serialize).join('');
  }

  append(content: string | Query | AnyNode): Query {
    for (const n of this.nodes) {
      if (n.type !== 'element' && n.type !== 'document') continue;
      for (const c of toNodes(content)) appendChild(n, c);
    }
    return this;
  }

  prepend(content: string | Query | AnyNode): Query {
    for (const n of this.nodes) {
      if (n.type !== 'element' && n.type !== 'document') continue;
      const incoming = toNodes(content);
      for (const c of incoming) c.parent = n;
      n.children.unshift(...incoming);
    }
    return this;
  }

  remove(): Query {
    for (const n of this.nodes) removeNode(n);
    return this;
  }

  replaceWith(content: string | Query | AnyNode): Query {
    for (const n of this.nodes) {
      replaceNode(n, toNodes(content));
    }
    return this;
  }

  clone(): Query {
    return new Query(this.nodes.map(cloneNode), this.root);
  }

  addClass(name: string): Query {
    for (const e of this.elements()) {
      const list = classListOf(e);
      if (!list.includes(name)) e.attribs['class'] = [...list, name].join(' ');
    }
    return this;
  }
}

export class MappedQuery<T> {
  constructor(private readonly values: T[]) {}
  get(): T[] {
    return [...this.values];
  }
  toArray(): T[] {
    return [...this.values];
  }
  get length(): number {
    return this.values.length;
  }
}

function dedupe(nodes: AnyNode[]): AnyNode[] {
  const seen = new Set<AnyNode>();
  const out: AnyNode[] = [];
  for (const n of nodes) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function toNodes(content: string | Query | AnyNode): AnyNode[] {
  if (typeof content === 'string') {
    if (!/[<&]/.test(content)) return [{ type: 'text', data: content, parent: null }];
    return [...parseHtml(content, { fragment: true }).children];
  }
  if (content instanceof Query) return [...content.nodes];
  return [content];
}

function cloneNode(node: AnyNode): AnyNode {
  switch (node.type) {
    case 'text':
      return { type: 'text', data: node.data, parent: null };
    case 'comment':
      return { type: 'comment', data: node.data, parent: null };
    case 'directive':
      return { type: 'directive', data: node.data, parent: null };
    case 'document': {
      const d: DocumentNode = { type: 'document', children: [], parent: null };
      for (const c of node.children) appendChild(d, cloneNode(c));
      return d;
    }
    case 'element': {
      const e = createElement(node.tagName, { ...node.attribs });
      for (const c of node.children) appendChild(e, cloneNode(c));
      return e;
    }
  }
}

export interface CheerioAPI {
  (selector: Selectable): Query;
  root(): Query;
  html(): string;
  document: DocumentNode;
}

/**
 * `load(html)` parses a full document; `load(html, null, false)` parses a
 * fragment (matching the signature the extraction code was written against).
 */
export function load(html: string, _options?: unknown, isDocument = true): CheerioAPI {
  const doc = parseHtml(html ?? '', { fragment: !isDocument });

  const api = ((selector: Selectable): Query => {
    if (selector === null || selector === undefined) return new Query([], doc);
    if (typeof selector === 'string') {
      const trimmed = selector.trim();
      if (trimmed.startsWith('<')) return new Query([...parseHtml(trimmed, { fragment: true }).children], doc);
      return new Query(querySelectorAll(doc, trimmed), doc);
    }
    if (selector instanceof Query) return new Query(selector.toArray(), doc);
    if (Array.isArray(selector)) return new Query(selector, doc);
    return new Query([selector], doc);
  }) as CheerioAPI;

  api.root = () => new Query([doc], doc);
  api.html = () => serializeChildren(doc);
  api.document = doc;
  return api;
}

export { walkElements, isElement, serialize, serializeChildren, textContent, matches, querySelectorAll, parseHtml };
