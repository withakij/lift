/**
 * CSS selector engine — the subset the extraction layers actually use:
 *
 *   type, *, #id, .class, [attr], [attr=v], [attr^=v], [attr$=v], [attr*=v],
 *   [attr~=v], [attr|=v], case-insensitive flag [attr=v i],
 *   combinators: descendant, > child, + adjacent, ~ sibling,
 *   pseudo-classes: :not(), :first-child, :last-child, :only-child,
 *                   :first-of-type, :last-of-type, :nth-child(n|odd|even),
 *                   :empty, :root, :has(), :contains()
 *   comma-separated selector lists.
 */
import { classListOf, isElement, walkElements, type ElementNode, type ParentNode } from './nodes';
import { textContent } from './parser';

/* ---------------- tokenising ---------------- */

interface AttrCond {
  name: string;
  op: '=' | '^=' | '$=' | '*=' | '~=' | '|=' | 'exists';
  value: string;
  ci: boolean;
}

interface Simple {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: AttrCond[];
  pseudos: Array<{ name: string; arg: string | null; parsed?: CompiledSelector }>;
}

interface Step {
  simple: Simple;
  combinator: ' ' | '>' | '+' | '~' | null; // relation to the PREVIOUS step
}

export type CompiledSelector = Step[][];

const cache = new Map<string, CompiledSelector>();

export function compile(selector: string): CompiledSelector {
  const hit = cache.get(selector);
  if (hit) return hit;
  const compiled = splitTopLevel(selector, ',')
    .map((part) => parseComplex(part.trim()))
    .filter((s) => s.length > 0);
  if (cache.size > 500) cache.clear();
  cache.set(selector, compiled);
  return compiled;
}

/** Splits on separators that are not inside brackets, parens or quotes. */
export function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote && input[i - 1] !== '\\') quote = null;
      current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (c === sep && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  out.push(current);
  return out;
}

function parseComplex(input: string): Step[] {
  const steps: Step[] = [];
  let i = 0;
  let pendingCombinator: Step['combinator'] = null;

  const skipSpace = (): boolean => {
    let saw = false;
    while (i < input.length && /\s/.test(input[i])) {
      i++;
      saw = true;
    }
    return saw;
  };

  skipSpace();
  while (i < input.length) {
    const c = input[i];
    if (c === '>' || c === '+' || c === '~') {
      pendingCombinator = c as Step['combinator'];
      i++;
      skipSpace();
      continue;
    }
    const start = i;
    const simple = parseSimple(input, i);
    if (simple.next === start) {
      i++;
      continue;
    }
    i = simple.next;
    steps.push({ simple: simple.value, combinator: steps.length === 0 ? null : pendingCombinator ?? ' ' });
    pendingCombinator = null;
    const sawSpace = skipSpace();
    if (sawSpace && i < input.length && !'>+~'.includes(input[i])) pendingCombinator = ' ';
  }
  return steps;
}

function parseSimple(input: string, start: number): { value: Simple; next: number } {
  const simple: Simple = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  let i = start;

  const readIdent = (): string => {
    const s = i;
    while (i < input.length && /[\w -￿-]/.test(input[i])) i++;
    return input.slice(s, i);
  };

  while (i < input.length) {
    const c = input[i];
    if (c === '*') {
      simple.tag = null;
      i++;
    } else if (c === '#') {
      i++;
      simple.id = readIdent();
    } else if (c === '.') {
      i++;
      simple.classes.push(readIdent());
    } else if (c === '[') {
      const end = findClose(input, i, '[', ']');
      simple.attrs.push(parseAttr(input.slice(i + 1, end)));
      i = end + 1;
    } else if (c === ':') {
      i++;
      if (input[i] === ':') i++; // pseudo-elements are ignored
      const name = readIdent().toLowerCase();
      let arg: string | null = null;
      if (input[i] === '(') {
        const end = findClose(input, i, '(', ')');
        arg = input.slice(i + 1, end).trim();
        i = end + 1;
      }
      const pseudo: Simple['pseudos'][number] = { name, arg };
      if ((name === 'not' || name === 'has' || name === 'is' || name === 'where') && arg) {
        pseudo.parsed = compile(arg);
      }
      simple.pseudos.push(pseudo);
    } else if (/[\w -￿*|-]/.test(c)) {
      if (simple.tag !== null || simple.id !== null || simple.classes.length || simple.attrs.length || simple.pseudos.length) break;
      simple.tag = readIdent().toLowerCase();
    } else {
      break;
    }
  }
  return { value: simple, next: i };
}

function findClose(input: string, from: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote && input[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return input.length - 1;
}

function parseAttr(body: string): AttrCond {
  const m = /^\s*([\w -￿:.-]+)\s*(?:([~^$*|]?=)\s*("([^"]*)"|'([^']*)'|[^\s\]]*)\s*(i|I|s|S)?)?\s*$/.exec(body);
  if (!m) return { name: body.trim().toLowerCase(), op: 'exists', value: '', ci: false };
  const name = m[1].toLowerCase();
  if (!m[2]) return { name, op: 'exists', value: '', ci: false };
  const raw = m[4] ?? m[5] ?? m[3] ?? '';
  return { name, op: m[2] as AttrCond['op'], value: raw, ci: (m[6] ?? '').toLowerCase() === 'i' };
}

/* ---------------- matching ---------------- */

function matchAttr(el: ElementNode, cond: AttrCond): boolean {
  const raw = el.attribs[cond.name];
  if (raw === undefined) return false;
  if (cond.op === 'exists') return true;
  const a = cond.ci ? raw.toLowerCase() : raw;
  const b = cond.ci ? cond.value.toLowerCase() : cond.value;
  switch (cond.op) {
    case '=':
      return a === b;
    case '^=':
      return b !== '' && a.startsWith(b);
    case '$=':
      return b !== '' && a.endsWith(b);
    case '*=':
      return b !== '' && a.includes(b);
    case '~=':
      return b !== '' && a.split(/\s+/).includes(b);
    case '|=':
      return a === b || a.startsWith(`${b}-`);
    default:
      return false;
  }
}

function siblingElements(el: ElementNode): ElementNode[] {
  const p = el.parent;
  if (!p) return [el];
  return p.children.filter(isElement);
}

function matchSimple(el: ElementNode, s: Simple): boolean {
  if (s.tag && el.tagName !== s.tag) return false;
  if (s.id && el.attribs['id'] !== s.id) return false;
  if (s.classes.length) {
    const cls = classListOf(el);
    for (const c of s.classes) if (!cls.includes(c)) return false;
  }
  for (const a of s.attrs) if (!matchAttr(el, a)) return false;

  for (const p of s.pseudos) {
    switch (p.name) {
      case 'not':
        if (p.parsed && matchesCompiled(el, p.parsed)) return false;
        break;
      case 'is':
      case 'where':
        if (p.parsed && !matchesCompiled(el, p.parsed)) return false;
        break;
      case 'has': {
        if (!p.parsed) break;
        let found = false;
        for (const d of walkElements(el)) {
          if (matchesCompiled(d, p.parsed)) {
            found = true;
            break;
          }
        }
        if (!found) return false;
        break;
      }
      case 'first-child': {
        const sibs = siblingElements(el);
        if (sibs[0] !== el) return false;
        break;
      }
      case 'last-child': {
        const sibs = siblingElements(el);
        if (sibs[sibs.length - 1] !== el) return false;
        break;
      }
      case 'only-child':
        if (siblingElements(el).length !== 1) return false;
        break;
      case 'first-of-type': {
        const sibs = siblingElements(el).filter((s2) => s2.tagName === el.tagName);
        if (sibs[0] !== el) return false;
        break;
      }
      case 'last-of-type': {
        const sibs = siblingElements(el).filter((s2) => s2.tagName === el.tagName);
        if (sibs[sibs.length - 1] !== el) return false;
        break;
      }
      case 'nth-child': {
        const sibs = siblingElements(el);
        const idx = sibs.indexOf(el) + 1;
        if (!matchNth(idx, p.arg ?? '')) return false;
        break;
      }
      case 'empty':
        if (el.children.some((c) => c.type === 'element' || (c.type === 'text' && c.data.trim() !== ''))) return false;
        break;
      case 'root':
        if (el.tagName !== 'html') return false;
        break;
      case 'contains': {
        const needle = (p.arg ?? '').replace(/^['"]|['"]$/g, '');
        if (!textContent(el).includes(needle)) return false;
        break;
      }
      default:
        // Unknown pseudo-classes (:hover, :focus, …) never match content.
        return false;
    }
  }
  return true;
}

function matchNth(index: number, expr: string): boolean {
  const e = expr.trim().toLowerCase();
  if (e === 'odd') return index % 2 === 1;
  if (e === 'even') return index % 2 === 0;
  const m = /^([+-]?\d*)n\s*([+-]\s*\d+)?$/.exec(e);
  if (m) {
    const aRaw = m[1];
    const a = aRaw === '' || aRaw === '+' ? 1 : aRaw === '-' ? -1 : Number.parseInt(aRaw, 10);
    const b = m[2] ? Number.parseInt(m[2].replace(/\s+/g, ''), 10) : 0;
    if (a === 0) return index === b;
    return (index - b) % a === 0 && (index - b) / a >= 0;
  }
  const n = Number.parseInt(e, 10);
  return Number.isFinite(n) && index === n;
}

/** Matches a compiled selector against a single element (rightmost first). */
export function matchesCompiled(el: ElementNode, sel: CompiledSelector): boolean {
  for (const steps of sel) {
    if (matchSteps(el, steps, steps.length - 1)) return true;
  }
  return false;
}

function matchSteps(el: ElementNode, steps: Step[], idx: number): boolean {
  if (idx < 0) return true;
  const step = steps[idx];
  if (!matchSimple(el, step.simple)) return false;
  if (idx === 0) return true;

  const combinator = step.combinator ?? ' ';
  if (combinator === ' ') {
    let p = el.parent;
    while (p && isElement(p)) {
      if (matchSteps(p, steps, idx - 1)) return true;
      p = p.parent;
    }
    return false;
  }
  if (combinator === '>') {
    const p = el.parent;
    return !!p && isElement(p) && matchSteps(p, steps, idx - 1);
  }
  const sibs = siblingElements(el);
  const myIndex = sibs.indexOf(el);
  if (combinator === '+') {
    const prev = sibs[myIndex - 1];
    return !!prev && matchSteps(prev, steps, idx - 1);
  }
  // '~'
  for (let k = myIndex - 1; k >= 0; k--) {
    if (matchSteps(sibs[k], steps, idx - 1)) return true;
  }
  return false;
}

export function matches(el: ElementNode, selector: string): boolean {
  return matchesCompiled(el, compile(selector));
}

/** All descendants of `root` matching `selector`, in document order. */
export function querySelectorAll(root: ParentNode, selector: string): ElementNode[] {
  const sel = compile(selector);
  const out: ElementNode[] = [];
  for (const el of walkElements(root)) {
    if (matchesCompiled(el, sel)) out.push(el);
  }
  return out;
}
