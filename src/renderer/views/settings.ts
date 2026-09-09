import { h, icon } from '../lib/dom.js';
import { badge, banner, button, checkField, sectionHead, selectField, textField } from '../lib/ui.js';
import { getState } from '../lib/state.js';
import { chooseExportFolder, saveSettings } from '../actions.js';
import { api } from '../lib/api.js';
import type { AppInfo } from '../../shared/ipc';

let info: AppInfo | null = null;

export function renderSettings(): HTMLElement {
  const s = getState();
  const cfg = s.settings;

  if (!cfg) {
    return h('div', { class: 'view' }, h('p', { class: 'muted' }, 'Loading settings…'));
  }

  if (!info) void loadInfo();

  const num = (label: string, key: keyof typeof cfg, hint: string, min = '0', max = '600000', step = '1'): HTMLElement =>
    textField({
      label,
      hint,
      type: 'number',
      min,
      max,
      step,
      value: String(cfg[key]),
      onInput: (v) => {
        const n = Number(v);
        if (Number.isFinite(n)) void saveSettings({ [key]: n });
      }
    });

  return h(
    'div',
    { class: 'view' },
    sectionHead({ title: 'Settings' }),

    card(
      'Being a good visitor',
      'These control how gently the app treats the sites it reads. Slower is safer — accuracy matters more than speed.',
      [
        num('Pause between requests to the same site (ms)', 'perHostDelayMs', 'A larger gap is politer and less likely to be rate-limited. 1200 ms is a sensible default.', '0', '60000', '100'),
        num('Sites in flight at once', 'concurrency', 'How many URLs may be processed simultaneously across all sites.', '1', '10'),
        num('Requests in flight per site', 'perHostConcurrency', 'Keep this at 1 unless you know the site can take more.', '1', '5'),
        num('Request timeout (ms)', 'requestTimeoutMs', 'How long to wait for a page before giving up.', '5000', '180000', '1000'),
        num('Retries after a failure', 'maxRetries', 'Timeouts and server errors are retried; a missing page is not.', '0', '5'),
        num('Wait before retrying (ms)', 'retryBackoffMs', 'Doubles with each further attempt.', '0', '60000', '500'),
        checkField({
          label: 'Respect robots.txt',
          hint: 'When a site asks automated tools not to read a page, the app skips it and tells you why. Leave this on.',
          checked: cfg.respectRobotsTxt,
          onChange: (v) => void saveSettings({ respectRobotsTxt: v })
        })
      ]
    ),

    card('Reading JavaScript pages', 'Some stores build their product page in the browser. The app opens those pages in its own built-in browser.', [
      selectField({
        label: 'When to use the built-in browser',
        hint:
          'Automatic is right for almost everything: plain pages stay fast, and only pages that came back incomplete are opened in the browser.',
        value: cfg.browserRenderMode,
        options: [
          { value: 'auto', label: 'Automatic — only when needed (recommended)' },
          { value: 'always', label: 'Always — slowest, most thorough' },
          { value: 'never', label: 'Never — fastest, may miss variant data' }
        ],
        onChange: (v) => void saveSettings({ browserRenderMode: v })
      }),
      num('Page render timeout (ms)', 'renderTimeoutMs', 'How long to let a page finish loading in the built-in browser.', '5000', '180000', '1000'),
      checkField({
        label: 'Click through variant selectors when data is still missing',
        hint:
          'A last resort: the app selects each option combination and reads what the page shows. Slow, and the values are recorded as lower confidence.',
        checked: cfg.enableVariantInteraction,
        onChange: (v) => void saveSettings({ enableVariantInteraction: v })
      })
    ]),

    card('Images', 'Image handling affects how long a product takes and how much is verified.', [
      checkField({
        label: 'Check that every image address loads',
        hint: 'Catches broken images before you import them. Adds a little time per product.',
        checked: cfg.validateImageUrls,
        onChange: (v) => void saveSettings({ validateImageUrls: v })
      }),
      num('Image checks at once', 'imageValidationConcurrency', '', '1', '8')
    ]),

    card('Exports', '', [
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field__label' }, 'Default export folder'),
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'mono tiny' }, cfg.defaultExportDir ?? 'Documents / Lift Exports'),
          h('div', { class: 'header__spacer' }),
          button({
            label: 'Choose…',
            icon: 'folder',
            size: 'sm',
            onClick: async () => {
              const dir = await chooseExportFolder();
              if (dir) void saveSettings({ defaultExportDir: dir });
            }
          }),
          cfg.defaultExportDir
            ? button({ label: 'Reset', size: 'sm', onClick: () => void saveSettings({ defaultExportDir: null }) })
            : null
        )
      )
    ]),

    card('Appearance and diagnostics', '', [
      selectField({
        label: 'Theme',
        value: cfg.theme,
        options: [
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' }
        ],
        onChange: (v) => void saveSettings({ theme: v })
      }),
      checkField({
        label: 'Advanced mode',
        hint: 'Shows the technical log, extraction layers and per-field sources. Nothing is hidden from you — this just keeps the everyday view calm.',
        checked: cfg.advancedMode,
        onChange: (v) => void saveSettings({ advancedMode: v })
      }),
      checkField({
        label: 'Keep raw source snippets for inspection',
        hint: 'Stores the JSON each product was read from, so you can see exactly what the site published. Uses more disk.',
        checked: cfg.keepDebugSnippets,
        onChange: (v) => void saveSettings({ keepDebugSnippets: v })
      }),
      textField({
        label: 'Identify as',
        hint: 'The user-agent string sent with each request. Leave it alone unless a site needs something specific.',
        value: cfg.userAgent,
        onInput: (v) => void saveSettings({ userAgent: v })
      })
    ]),

    h(
      'section',
      { class: 'section' },
      sectionHead({ title: 'About' }),
      h(
        'div',
        { class: 'card card__pad' },
        h(
          'div',
          { class: 'row', style: 'gap:14px;margin-bottom:14px' },
          h('div', { class: 'brand__mark' }, 'T'),
          h(
            'div',
            null,
            h('div', { style: 'font-weight:640;font-size:15px' }, 'Lift'),
            h('div', { class: 'tiny muted' }, 'Product collection and migration · Made by Rahul Raj')
          ),
          h('div', { class: 'header__spacer' }),
          info ? badge(`v${info.version}`, 'brand') : null
        ),
        info
          ? h(
              'div',
              { class: 'tiny muted', style: 'line-height:1.8' },
              h('div', null, `Electron ${info.electron} · Chromium ${info.chrome} · Node ${info.node} · ${info.platform}`),
              h('div', { class: 'mono', style: 'margin-top:4px;word-break:break-all' }, `Your data: ${info.dataDir}`)
            )
          : null,
        banner('info', [
          h('strong', null, 'Everything stays on this computer. '),
          'Projects, URLs, collected products and exports are stored in the folder above. Nothing is sent anywhere except the requests made to the product pages you listed.'
        ])
      )
    )
  );
}

function card(title: string, subtitle: string, children: Array<Node | null>): HTMLElement {
  return h(
    'section',
    { class: 'section' },
    sectionHead({ title, subtitle: subtitle || undefined }),
    h('div', { class: 'card card__pad' }, ...children.filter(Boolean))
  );
}

async function loadInfo(): Promise<void> {
  try {
    info = await api.system.info();
    const { notify } = await import('../lib/state.js');
    notify();
  } catch {
    /* the About panel simply shows less */
  }
}

export { icon };
