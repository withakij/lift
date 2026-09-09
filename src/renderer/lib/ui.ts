import { h, icon, mount, type Attrs, type IconName } from './dom.js';

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

export interface ButtonOptions {
  label?: string;
  icon?: IconName;
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  title?: string;
  disabled?: boolean;
  onClick?: () => void;
}

export function button(o: ButtonOptions): HTMLButtonElement {
  const classes = ['btn'];
  if (o.variant && o.variant !== 'default') classes.push(`btn--${o.variant}`);
  if (o.size === 'sm') classes.push('btn--sm');
  if (!o.label && o.icon) classes.push('btn--icon');
  return h(
    'button',
    {
      class: classes.join(' '),
      type: 'button',
      title: o.title ?? o.label,
      disabled: o.disabled,
      on: { click: () => o.onClick?.() }
    },
    o.icon ? icon(o.icon, o.size === 'sm' ? 14 : 15) : null,
    o.label ?? null
  );
}

/* ------------------------------------------------------------------ */
/* Form fields                                                         */
/* ------------------------------------------------------------------ */

export interface FieldOptions {
  label: string;
  hint?: string;
  value?: string;
  placeholder?: string;
  type?: string;
  min?: string;
  max?: string;
  step?: string;
  onInput?: (value: string) => void;
  ref?: (el: HTMLInputElement) => void;
}

export function textField(o: FieldOptions): HTMLElement {
  let input!: HTMLInputElement;
  const wrap = h(
    'label',
    { class: 'field' },
    h('span', { class: 'field__label' }, o.label),
    h('input', {
      class: 'input',
      type: o.type ?? 'text',
      value: o.value ?? '',
      placeholder: o.placeholder,
      min: o.min,
      max: o.max,
      step: o.step,
      ref: (el) => {
        input = el as HTMLInputElement;
        o.ref?.(input);
      },
      on: { input: () => o.onInput?.(input.value) }
    }),
    o.hint ? h('p', { class: 'field__hint' }, o.hint) : null
  );
  return wrap;
}

export function textArea(o: FieldOptions & { rows?: number }): HTMLElement {
  let ta!: HTMLTextAreaElement;
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field__label' }, o.label),
    h('textarea', {
      class: 'textarea',
      placeholder: o.placeholder,
      rows: String(o.rows ?? 6),
      ref: (el) => {
        ta = el as HTMLTextAreaElement;
        ta.value = o.value ?? '';
      },
      on: { input: () => o.onInput?.(ta.value) }
    }),
    o.hint ? h('p', { class: 'field__hint' }, o.hint) : null
  );
}

export function selectField(o: {
  label: string;
  hint?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}): HTMLElement {
  let sel!: HTMLSelectElement;
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'field__label' }, o.label),
    h(
      'select',
      {
        class: 'select',
        ref: (el) => {
          sel = el as HTMLSelectElement;
        },
        on: { change: () => o.onChange(sel.value) }
      },
      ...o.options.map((opt) =>
        h('option', { value: opt.value, selected: opt.value === o.value }, opt.label)
      )
    ),
    o.hint ? h('p', { class: 'field__hint' }, o.hint) : null
  );
}

export function checkField(o: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): HTMLElement {
  let input!: HTMLInputElement;
  return h(
    'label',
    { class: 'check' },
    h('input', {
      type: 'checkbox',
      checked: o.checked,
      ref: (el) => {
        input = el as HTMLInputElement;
      },
      on: { change: () => o.onChange(input.checked) }
    }),
    h('span', { class: 'check__body' }, h('strong', null, o.label), o.hint ? h('span', null, o.hint) : null)
  );
}

/* ------------------------------------------------------------------ */
/* Badges and indicators                                               */
/* ------------------------------------------------------------------ */

export type Tone = 'neutral' | 'ok' | 'warn' | 'err' | 'crit' | 'info' | 'brand';

export function badge(label: string, tone: Tone = 'neutral', withDot = false): HTMLElement {
  return h(
    'span',
    { class: `badge${tone === 'neutral' ? '' : ` badge--${tone}`}` },
    withDot ? h('i', { class: 'dot' }) : null,
    label
  );
}

export function progressBar(fraction: number, tone: 'brand' | 'ok' = 'brand'): HTMLElement {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100;
  return h(
    'div',
    { class: 'bar' },
    h('div', { class: `bar__fill${tone === 'ok' ? ' bar__fill--ok' : ''}`, style: `width:${pct.toFixed(1)}%` })
  );
}

export function segmentBar(segments: Array<{ value: number; color: string; title: string }>): HTMLElement {
  const total = segments.reduce((n, s) => n + s.value, 0) || 1;
  return h(
    'div',
    { class: 'segbar' },
    ...segments
      .filter((s) => s.value > 0)
      .map((s) =>
        h('span', {
          style: `width:${((s.value / total) * 100).toFixed(2)}%;background:${s.color}`,
          title: `${s.title}: ${s.value}`
        })
      )
  );
}

export function stat(o: {
  label: string;
  value: string | number;
  meta?: string;
  tone?: 'default' | 'accent' | 'alert' | 'good';
  onClick?: () => void;
}): HTMLElement {
  const el = h(
    'div',
    {
      class: `stat${o.tone && o.tone !== 'default' ? ` stat--${o.tone}` : ''}`,
      style: o.onClick ? 'cursor:pointer' : undefined,
      on: o.onClick ? { click: () => o.onClick?.() } : undefined
    },
    h('div', { class: 'stat__label' }, o.label),
    h('div', { class: 'stat__value' }, String(o.value)),
    o.meta ? h('div', { class: 'stat__meta' }, o.meta) : null
  );
  return el;
}

export function emptyState(o: {
  icon: IconName;
  title: string;
  body: string;
  action?: ButtonOptions;
}): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty__icon' }, icon(o.icon, 22)),
    h('h3', null, o.title),
    h('p', null, o.body),
    o.action ? button({ ...o.action, variant: o.action.variant ?? 'primary' }) : null
  );
}

export function banner(tone: 'info' | 'warn' | 'err', body: (Node | string)[]): HTMLElement {
  const iconName: IconName = tone === 'err' ? 'error' : tone === 'warn' ? 'warning' : 'info';
  return h('div', { class: `banner banner--${tone}` }, icon(iconName, 16), h('div', null, ...body));
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

export interface ModalOptions {
  title: string;
  subtitle?: string;
  width?: 'default' | 'wide' | 'xl';
  body: Node | Node[];
  footer?: Node[];
  onClose?: () => void;
}

let openModals = 0;

export function openModal(o: ModalOptions): { close: () => void; setBody: (n: Node | Node[]) => void } {
  const bodyHost = h('div', { class: 'modal__body' });
  mount(bodyHost, Array.isArray(o.body) ? o.body : [o.body]);

  const close = (): void => {
    scrim.remove();
    document.removeEventListener('keydown', onKey);
    openModals = Math.max(0, openModals - 1);
    o.onClose?.();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };

  const modal = h(
    'div',
    { class: `modal${o.width && o.width !== 'default' ? ` modal--${o.width}` : ''}`, role: 'dialog' },
    h(
      'div',
      { class: 'modal__head' },
      h('div', null, h('h2', null, o.title), o.subtitle ? h('p', null, o.subtitle) : null),
      h('div', { class: 'header__spacer' }),
      button({ icon: 'close', variant: 'ghost', size: 'sm', title: 'Close', onClick: close })
    ),
    bodyHost,
    o.footer ? h('div', { class: 'modal__foot' }, ...o.footer) : null
  );

  const scrim = h(
    'div',
    {
      class: 'scrim',
      on: {
        mousedown: (e: MouseEvent) => {
          if (e.target === scrim) close();
        }
      }
    },
    modal
  );

  document.body.appendChild(scrim);
  openModals++;
  document.addEventListener('keydown', onKey);
  // Focus the first control so the dialog is usable from the keyboard.
  requestAnimationFrame(() => {
    const first = modal.querySelector<HTMLElement>('input, textarea, select, button.btn--primary');
    first?.focus();
  });

  return { close, setBody: (n) => mount(bodyHost, Array.isArray(n) ? n : [n]) };
}

export function confirmDialog(o: {
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}): void {
  const modal = openModal({
    title: o.title,
    body: h('p', { class: 'muted', style: 'margin:0;line-height:1.65' }, o.body),
    footer: [
      button({ label: 'Cancel', onClick: () => modal.close() }),
      button({
        label: o.confirmLabel ?? 'Confirm',
        variant: o.danger ? 'danger' : 'primary',
        onClick: () => {
          modal.close();
          o.onConfirm();
        }
      })
    ]
  });
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

let toastHost: HTMLElement | null = null;

export function toast(message: string, tone: 'ok' | 'warn' | 'err' = 'ok', ms = 4600): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts' });
    document.body.appendChild(toastHost);
  }
  const iconName: IconName = tone === 'err' ? 'error' : tone === 'warn' ? 'warning' : 'check';
  const el = h(
    'div',
    { class: `toast toast--${tone}` },
    icon(iconName, 15),
    h('div', null, message),
    h(
      'button',
      { class: 'toast__close', title: 'Dismiss', on: { click: () => el.remove() } },
      icon('close', 13)
    )
  );
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Wraps an async action so a rejected promise always reaches the operator. */
export async function guard<T>(fn: () => Promise<T>, failureMessage?: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    toast(failureMessage ? `${failureMessage} ${message}` : message, 'err', 8000);
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

export function tabs(
  items: Array<{ id: string; label: string; count?: number }>,
  active: string,
  onSelect: (id: string) => void
): HTMLElement {
  return h(
    'div',
    { class: 'tabs' },
    ...items.map((t) =>
      h(
        'button',
        { class: `tab${t.id === active ? ' is-active' : ''}`, type: 'button', on: { click: () => onSelect(t.id) } },
        t.label,
        t.count !== undefined ? h('span', { class: 'tab__count' }, String(t.count)) : null
      )
    )
  );
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

export interface Column<T> {
  header: string;
  className?: string;
  render(row: T, index: number): Node | string | null;
}

export function table<T>(o: {
  columns: Array<Column<T>>;
  rows: T[];
  rowClass?: (row: T) => string | undefined;
  onRowClick?: (row: T) => void;
  scroll?: boolean;
}): HTMLElement {
  const t = h(
    'table',
    { class: 'table' },
    h('thead', null, h('tr', null, ...o.columns.map((c) => h('th', { class: c.className }, c.header)))),
    h(
      'tbody',
      null,
      ...o.rows.map((row, i) =>
        h(
          'tr',
          {
            class: o.rowClass?.(row),
            style: o.onRowClick ? 'cursor:pointer' : undefined,
            on: o.onRowClick
              ? {
                  click: (e: MouseEvent) => {
                    const target = e.target as HTMLElement;
                    // Let buttons and inputs inside the row act on their own.
                    if (target.closest('button, input, a, select')) return;
                    o.onRowClick?.(row);
                  }
                }
              : undefined
          },
          ...o.columns.map((c) => h('td', { class: c.className }, c.render(row, i)))
        )
      )
    )
  );
  return o.scroll === false ? t : h('div', { class: 'table__scroll' }, t);
}

export function sectionHead(o: {
  title: string;
  subtitle?: string;
  actions?: Array<Node | null>;
}): HTMLElement {
  return h(
    'div',
    { class: 'section__head' },
    h('div', null, h('h2', null, o.title), o.subtitle ? h('p', null, o.subtitle) : null),
    o.actions?.length ? h('div', { class: 'section__actions' }, ...o.actions.filter(Boolean)) : null
  );
}

export function keyValue(pairs: Array<[string, Node | string | null | undefined]>): HTMLElement {
  const dl = h('dl', { class: 'kv' });
  for (const [key, value] of pairs) {
    dl.appendChild(h('dt', null, key));
    const empty = value === null || value === undefined || value === '';
    dl.appendChild(h('dd', { class: empty ? 'empty-val' : undefined }, empty ? 'not published' : value));
  }
  return dl;
}

export function attrs(a: Attrs): Attrs {
  return a;
}
