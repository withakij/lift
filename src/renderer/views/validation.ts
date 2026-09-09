import { h, icon } from '../lib/dom.js';
import { badge, banner, button, emptyState, sectionHead, stat, table } from '../lib/ui.js';
import { currentProject, getState, notify, setView } from '../lib/state.js';
import { acknowledgeIssues, runValidation } from '../actions.js';
import { openProduct } from './products.js';
import { plural, truncate } from '../lib/format.js';
import type { Severity, ValidationIssue } from '../../shared/types';

const TONE: Record<Severity, 'crit' | 'err' | 'warn' | 'info'> = {
  CRITICAL: 'crit',
  ERROR: 'err',
  WARNING: 'warn',
  INFO: 'info'
};

const EXPLANATION: Record<Severity, string> = {
  CRITICAL: 'Data integrity is compromised. These products are never exported until you fix or acknowledge them.',
  ERROR: 'The row would import wrong or be rejected. Held back unless you choose to include errors.',
  WARNING: 'The import will work, but something is worth a look.',
  INFO: 'Worth knowing. Nothing to do.'
};

export function renderValidation(): HTMLElement {
  const s = getState();
  if (!currentProject()) {
    return h(
      'div',
      { class: 'view' },
      emptyState({
        icon: 'projects',
        title: 'Choose a project first',
        body: 'Validation runs across the products in a project.',
        action: { label: 'Go to projects', onClick: () => setView('projects') }
      })
    );
  }

  const counts: Record<Severity, number> = { CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0 };
  for (const i of s.issues) counts[i.severity]++;
  const blocking = counts.CRITICAL + counts.ERROR;

  const productTitle = (id: string | null): string => {
    if (!id) return 'Project-wide';
    const found = s.products.find((p) => p.id === id);
    return found?.title ?? 'Untitled product';
  };

  const filtered = s.filters.severity ? s.issues.filter((i) => i.severity === s.filters.severity) : s.issues;

  return h(
    'div',
    { class: 'view view--wide' },
    sectionHead({
      title: 'Validation',
      subtitle: 'Everything that could make an import wrong, checked before you export.',
      actions: [button({ label: 'Run validation', icon: 'validation', variant: 'primary', onClick: () => void runValidation() })]
    }),

    s.issues.length === 0
      ? h(
          'div',
          { class: 'card' },
          emptyState({
            icon: 'validation',
            title: 'Validation has not run yet',
            body:
              'Run it after collecting to check variant integrity, duplicate SKUs, missing prices, currency mismatches, image problems and more.',
            action: { label: 'Run validation', icon: 'validation', onClick: () => void runValidation() }
          })
        )
      : h(
          'div',
          null,
          blocking > 0
            ? banner('warn', [
                h('strong', null, `${plural(blocking, 'finding')} would block an export. `),
                'Products with a critical finding are never written. Products with an error are held back unless you tick “include products with errors” when exporting.'
              ])
            : banner('info', ['Nothing is blocking an export. Any findings below are informational or advisory.']),

          h(
            'div',
            { class: 'stats', style: 'margin-bottom:20px' },
            ...(['CRITICAL', 'ERROR', 'WARNING', 'INFO'] as Severity[]).map((sev) =>
              stat({
                label: sev.charAt(0) + sev.slice(1).toLowerCase(),
                value: counts[sev],
                meta: s.filters.severity === sev ? 'filtering' : 'click to filter',
                tone: sev === 'CRITICAL' || sev === 'ERROR' ? (counts[sev] ? 'alert' : 'default') : sev === 'WARNING' ? (counts[sev] ? 'accent' : 'default') : 'default',
                onClick: () => {
                  s.filters.severity = s.filters.severity === sev ? null : sev;
                  notify();
                }
              })
            )
          ),

          s.filters.severity
            ? h(
                'div',
                { class: 'row', style: 'margin-bottom:12px' },
                badge(`Showing ${s.filters.severity}`, TONE[s.filters.severity as Severity]),
                h('span', { class: 'tiny muted' }, EXPLANATION[s.filters.severity as Severity]),
                h('div', { class: 'header__spacer' }),
                button({
                  label: 'Clear filter',
                  size: 'sm',
                  onClick: () => {
                    s.filters.severity = null;
                    notify();
                  }
                })
              )
            : null,

          h(
            'div',
            { class: 'card' },
            h(
              'div',
              { class: 'card__head' },
              h('h3', null, `${plural(filtered.length, 'finding')}`),
              h('div', { class: 'spacer' }),
              button({
                label: 'Acknowledge all shown',
                size: 'sm',
                title: 'Mark these as reviewed so they stop holding products back',
                onClick: () => void acknowledgeIssues(filtered.map((i) => i.id), true)
              })
            ),
            h('div', { style: 'max-height:calc(100vh - 460px);overflow:auto' }, ...groupIssues(filtered, productTitle))
          )
        )
  );
}

function groupIssues(issues: ValidationIssue[], titleOf: (id: string | null) => string): HTMLElement[] {
  const byProduct = new Map<string, ValidationIssue[]>();
  for (const i of issues) {
    const key = i.productId ?? '__project__';
    const list = byProduct.get(key);
    if (list) list.push(i);
    else byProduct.set(key, [i]);
  }

  const order: Record<Severity, number> = { CRITICAL: 0, ERROR: 1, WARNING: 2, INFO: 3 };
  const groups = [...byProduct.entries()].sort((a, b) => {
    const worstA = Math.min(...a[1].map((i) => order[i.severity]));
    const worstB = Math.min(...b[1].map((i) => order[i.severity]));
    return worstA - worstB;
  });

  return groups.map(([productId, list]) =>
    h(
      'div',
      null,
      h(
        'div',
        {
          class: 'card__head',
          style: 'background:var(--surface-2);position:sticky;top:0;z-index:2;cursor:pointer',
          on: {
            click: () => {
              if (productId !== '__project__') void openProduct(productId);
            }
          }
        },
        icon(productId === '__project__' ? 'projects' : 'products', 14),
        h('h3', null, titleOf(productId === '__project__' ? null : productId)),
        h('div', { class: 'spacer' }),
        ...(['CRITICAL', 'ERROR', 'WARNING', 'INFO'] as Severity[])
          .map((sev) => {
            const n = list.filter((i) => i.severity === sev).length;
            return n ? badge(`${n} ${sev.toLowerCase()}`, TONE[sev]) : null;
          })
          .filter(Boolean),
        productId === '__project__' ? null : icon('chevron', 14)
      ),
      ...list
        .sort((a, b) => order[a.severity] - order[b.severity])
        .map((i) =>
          h(
            'div',
            { class: `issue${i.acknowledged ? ' is-ack' : ''}` },
            h(
              'div',
              { class: `issue__icon sev-${i.severity}` },
              icon(i.severity === 'INFO' ? 'info' : i.severity === 'WARNING' ? 'warning' : 'error', 15)
            ),
            h(
              'div',
              { class: 'issue__body' },
              h('div', { class: 'issue__msg' }, i.message),
              i.hint ? h('div', { class: 'issue__hint' }, i.hint) : null,
              h(
                'div',
                { class: 'issue__meta' },
                badge(i.severity, TONE[i.severity]),
                h('span', { class: 'mono' }, i.ruleId),
                i.field ? h('span', { class: 'mono' }, i.field) : null,
                i.observed ? h('span', null, `saw: ${truncate(i.observed, 80)}`) : null
              )
            ),
            button({
              label: i.acknowledged ? 'Reopen' : 'Acknowledge',
              size: 'sm',
              variant: 'ghost',
              onClick: () => void acknowledgeIssues([i.id], !i.acknowledged)
            })
          )
        )
    )
  );
}
