/**
 * Provenance-aware field assignment.
 *
 * Extraction layers run weakest-first and each one *offers* values. An offer
 * only lands if the field is still empty, or if the offering layer outranks the
 * layer that filled it. Whenever two layers offer different non-empty values,
 * the disagreement is recorded so the validation engine can flag it and the
 * Advanced view can show it.
 *
 * Nothing here ever invents a value: `set` ignores null, undefined, empty
 * strings and empty arrays.
 */
import {
  SOURCE_CONFIDENCE,
  SOURCE_RANK,
  type CanonicalProduct,
  type CanonicalVariant,
  type ExtractionSource
} from '../../shared/canonical';

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'number') return !Number.isFinite(v);
  return false;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

export class Merger {
  constructor(private readonly product: CanonicalProduct) {}

  /** Offer a value for a top-level product field. */
  set<K extends keyof CanonicalProduct>(
    field: K,
    value: CanonicalProduct[K] | null | undefined,
    source: ExtractionSource,
    note?: string
  ): void {
    this.assign(this.product as unknown as Record<string, unknown>, field as string, field as string, value, source, note);
  }

  /** Offer a value for a nested path such as `seo.title` or `google.gtin`. */
  setPath(path: string, value: unknown, source: ExtractionSource, note?: string): void {
    const parts = path.split('.');
    let holder = this.product as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = holder[parts[i]];
      if (typeof next !== 'object' || next === null) return;
      holder = next as Record<string, unknown>;
    }
    this.assign(holder, parts[parts.length - 1], path, value, source, note);
  }

  /** Offer a value on a variant; provenance is keyed `variants[<id>].<field>`. */
  setVariant<K extends keyof CanonicalVariant>(
    variant: CanonicalVariant,
    field: K,
    value: CanonicalVariant[K] | null | undefined,
    source: ExtractionSource,
    note?: string
  ): void {
    this.assign(
      variant as unknown as Record<string, unknown>,
      field as string,
      `variants[${variant.id}].${String(field)}`,
      value,
      source,
      note
    );
  }

  private assign(
    holder: Record<string, unknown>,
    key: string,
    provenanceKey: string,
    value: unknown,
    source: ExtractionSource,
    note?: string
  ): void {
    if (isEmpty(value)) return;
    const current = holder[key];
    const prior = this.product.provenance[provenanceKey];

    if (isEmpty(current)) {
      holder[key] = value;
      this.product.provenance[provenanceKey] = {
        source,
        confidence: SOURCE_CONFIDENCE[source],
        note
      };
      return;
    }

    if (sameValue(current, value)) {
      // Corroboration: upgrade provenance if this layer is stronger.
      if (!prior || SOURCE_RANK[source] > SOURCE_RANK[prior.source]) {
        this.product.provenance[provenanceKey] = { source, confidence: SOURCE_CONFIDENCE[source], note };
      }
      return;
    }

    const priorRank = prior ? SOURCE_RANK[prior.source] : 0;
    if (SOURCE_RANK[source] > priorRank) {
      holder[key] = value;
      this.product.provenance[provenanceKey] = {
        source,
        confidence: SOURCE_CONFIDENCE[source],
        note,
        conflict: prior ? { otherSource: prior.source, otherValue: current } : undefined
      };
    } else if (prior) {
      // Keep the stronger value but remember that a weaker layer disagreed.
      prior.conflict = { otherSource: source, otherValue: value };
    }
  }

  /** Union of string arrays (tags, keywords) without duplicates. */
  addToStringArray(path: 'tags' | 'seo.keywords' | 'google.adsLabels', values: string[], source: ExtractionSource): void {
    const clean = values.map((v) => v.trim()).filter((v) => v !== '');
    if (!clean.length) return;
    const parts = path.split('.');
    let holder = this.product as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) holder = holder[parts[i]] as Record<string, unknown>;
    const key = parts[parts.length - 1];
    const existing = (holder[key] as string[]) ?? [];
    const merged = [...existing];
    for (const v of clean) if (!merged.some((e) => e.toLowerCase() === v.toLowerCase())) merged.push(v);
    holder[key] = merged;
    if (!this.product.provenance[path]) {
      this.product.provenance[path] = { source, confidence: SOURCE_CONFIDENCE[source] };
    }
  }

  note(message: string): void {
    if (!this.product.extractionNotes.includes(message)) this.product.extractionNotes.push(message);
  }

  markUnavailable(paths: string[]): void {
    for (const p of paths) {
      if (!this.product.provenance[p]) {
        this.product.provenance[p] = { source: 'unavailable', confidence: 'none' };
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Value coercion helpers shared by every extractor                     */
/* ------------------------------------------------------------------ */

/**
 * Parses a money string into a number, or returns null.
 * Handles "1.299,00 €", "$1,299.00", "1 299,00", "USD 49.99", "4999" (cents
 * only when the caller says so).
 */
export function parseMoney(input: unknown, opts?: { centsIfInteger?: boolean }): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    if (opts?.centsIfInteger && Number.isInteger(input)) return input / 100;
    return input;
  }
  let s = String(input).trim();
  if (!s) return null;
  s = s.replace(/[  \s]/g, '');
  s = s.replace(/[^0-9.,\-]/g, '');
  if (!s || s === '-' || s === '.' || s === ',') return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    const decimals = s.length - lastComma - 1;
    s = decimals === 3 && s.split(',').length === 2 && s.length > 4 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot > -1) {
    const groups = s.split('.');
    if (groups.length > 2) s = s.replace(/\./g, '');
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
}

export function parseNumber(input: unknown): number | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const m = String(input).replace(/[ ,\s]/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number.parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

export function parseBool(input: unknown): boolean | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'boolean') return input;
  const s = String(input).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on', 'instock', 'in stock'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'off', 'outofstock', 'out of stock'].includes(s)) return false;
  return null;
}

export function cleanText(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s === '' ? null : s;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)));
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₽': 'RUB',
  '₩': 'KRW', '₺': 'TRY', '₪': 'ILS', '₦': 'NGN', '₫': 'VND', '₱': 'PHP',
  'R$': 'BRL', 'A$': 'AUD', 'C$': 'CAD', '৳': 'BDT', '฿': 'THB', 'CHF': 'CHF'
};

export function currencyFrom(input: unknown): string | null {
  if (!input) return null;
  const s = String(input).trim();
  const iso = s.match(/\b([A-Z]{3})\b/);
  if (iso && /^(USD|EUR|GBP|JPY|INR|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|BGN|TRY|RUB|BRL|MXN|ARS|CLP|COP|ZAR|NGN|KES|EGP|AED|SAR|QAR|KWD|ILS|SGD|HKD|TWD|KRW|CNY|THB|MYR|IDR|PHP|VND|BDT|PKR|LKR|NPR)$/.test(iso[1])) {
    return iso[1];
  }
  for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (s.includes(sym)) return code;
  }
  return null;
}
