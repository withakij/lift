/**
 * A very small view layer.
 *
 * The interface is built from real DOM nodes rather than a framework: it keeps
 * the app dependency-free, the whole rendering path is inspectable, and it is
 * more than enough for a workspace of this size. `h()` is the only primitive.
 */

type Child = Node | string | number | null | undefined | false | Child[];

export interface Attrs {
  class?: string;
  id?: string;
  title?: string;
  type?: string;
  href?: string;
  src?: string;
  alt?: string;
  value?: string;
  placeholder?: string;
  name?: string;
  min?: string;
  max?: string;
  step?: string;
  rows?: string;
  cols?: string;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  readonly?: boolean;
  hidden?: boolean;
  tabIndex?: number;
  style?: string;
  role?: string;
  html?: string;
  dataset?: Record<string, string>;
  aria?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (ev: never) => void>>;
  ref?: (el: HTMLElement) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  append(el, children);
  return el;
}

function applyAttrs(el: HTMLElement, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    switch (key) {
      case 'class':
        el.className = String(value);
        break;
      case 'html':
        el.innerHTML = String(value);
        break;
      case 'dataset':
        for (const [k, v] of Object.entries(value as Record<string, string>)) el.dataset[k] = v;
        break;
      case 'aria':
        for (const [k, v] of Object.entries(value as Record<string, string>)) el.setAttribute(`aria-${k}`, v);
        break;
      case 'on':
        for (const [evt, fn] of Object.entries(value as Record<string, EventListener>)) {
          el.addEventListener(evt, fn);
        }
        break;
      case 'ref':
        (value as (e: HTMLElement) => void)(el);
        break;
      case 'value':
        (el as HTMLInputElement).value = String(value);
        break;
      case 'checked':
      case 'disabled':
      case 'selected':
      case 'readonly':
      case 'hidden':
        (el as unknown as Record<string, boolean>)[key === 'readonly' ? 'readOnly' : key] = Boolean(value);
        break;
      case 'tabIndex':
        el.tabIndex = Number(value);
        break;
      default:
        el.setAttribute(key, String(value));
    }
  }
}

function append(parent: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

/** Replaces everything inside `host` with `content`. */
export function mount(host: HTMLElement, ...content: Child[]): void {
  host.replaceChildren();
  append(host, content);
}

export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  const holder = document.createElement('div');
  append(holder, children);
  while (holder.firstChild) f.appendChild(holder.firstChild);
  return f;
}

export function qs<T extends HTMLElement>(selector: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(selector);
}

/** SVG icons, drawn inline so the app needs no icon font or image assets. */
export function icon(name: IconName, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = ICONS[name];
  return svg;
}

export type IconName = keyof typeof ICONS;

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  projects: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.6.8l.9 1.2H18.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/>',
  categories: '<path d="M4 6h6l1.5 2H20"/><path d="M4 6v12h16V8"/><path d="M8 13h8"/>',
  urls: '<path d="M10 13a4 4 0 0 0 5.66 0l2.83-2.83a4 4 0 0 0-5.66-5.66L11.5 5.9"/><path d="M14 11a4 4 0 0 0-5.66 0L5.5 13.84a4 4 0 0 0 5.66 5.66l1.33-1.33"/>',
  scraping: '<path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><circle cx="12" cy="12" r="4.5"/><path d="M5.6 5.6 7.7 7.7"/><path d="M16.3 16.3l2.1 2.1"/><path d="M18.4 5.6 16.3 7.7"/><path d="M7.7 16.3 5.6 18.4"/>',
  products: '<path d="M21 8.5 12 13 3 8.5 12 4z"/><path d="M3 8.5v7L12 20l9-4.5v-7"/><path d="M12 13v7"/>',
  validation: '<path d="M12 3 20 6.5v5c0 4.5-3.2 8.4-8 9.5-4.8-1.1-8-5-8-9.5v-5z"/><path d="m9 12 2 2 4-4"/>',
  exports: '<path d="M12 15V4"/><path d="m8 8 4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  play: '<path d="M7 4.5 19 12 7 19.5z"/>',
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  retry: '<path d="M3 12a9 9 0 1 1 2.6 6.4"/><path d="M3 20v-5h5"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  warning: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4"/><path d="M12 17.5h.01"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.6.8l.9 1.2H18.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/>',
  upload: '<path d="M12 16V4"/><path d="m8 8 4-4 4 4"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  tag: '<path d="M3 11V5a2 2 0 0 1 2-2h6l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  spinner: '<path d="M12 3a9 9 0 1 0 9 9" />'
} as const;
