export function money(value: number | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  try {
    if (currency) {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
    }
  } catch {
    /* an unknown currency code falls through to a plain number */
  }
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export function number(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat().format(value);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${new Intl.NumberFormat().format(n)} ${n === 1 ? one : many}`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [1000, 'second'],
    [60_000, 'minute'],
    [3_600_000, 'hour'],
    [86_400_000, 'day'],
    [604_800_000, 'week'],
    [2_629_800_000, 'month'],
    [31_557_600_000, 'year']
  ];
  if (abs < 45_000) return 'just now';
  let chosen: [number, Intl.RelativeTimeFormatUnit] = units[1];
  for (const u of units) if (abs >= u[0]) chosen = u;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  return rtf.format(-Math.round(diff / chosen[0]), chosen[1]);
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${s}s`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const STOCK_LABELS: Record<string, string> = {
  in_stock: 'In stock',
  out_of_stock: 'Out of stock',
  on_backorder: 'On backorder',
  preorder: 'Pre-order',
  unknown: 'Unknown'
};

export function stockLabel(status: string): string {
  return STOCK_LABELS[status] ?? titleCase(status);
}

const PLATFORM_LABELS: Record<string, string> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  'wordpress-generic': 'WordPress',
  bigcommerce: 'BigCommerce',
  magento: 'Magento',
  squarespace: 'Squarespace',
  unknown: 'Unrecognised'
};

export function platformLabel(p: string): string {
  return PLATFORM_LABELS[p] ?? titleCase(p);
}

const KIND_LABELS: Record<string, string> = {
  simple: 'Simple',
  variable: 'Variable',
  grouped: 'Grouped',
  external: 'External',
  unknown: 'Unknown'
};

export function kindLabel(k: string): string {
  return KIND_LABELS[k] ?? titleCase(k);
}

const STATE_LABELS: Record<string, string> = {
  pending: 'Waiting',
  processing: 'Working',
  completed: 'Done',
  warning: 'Done, check it',
  failed: 'Failed',
  retrying: 'Retrying',
  skipped: 'Skipped',
  paused: 'Paused'
};

export function urlStateLabel(s: string): string {
  return STATE_LABELS[s] ?? titleCase(s);
}
