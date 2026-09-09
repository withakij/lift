/**
 * RFC 4180 CSV writer.
 *
 * Quotes any field containing a comma, quote, newline or leading/trailing
 * space, doubles embedded quotes, and (optionally) writes a UTF-8 BOM so
 * Excel opens accented product names correctly. A value that begins with
 * =, +, - or @ is prefixed with a single quote so spreadsheet software does
 * not treat imported product text as a formula.
 */

export interface CsvOptions {
  bom?: boolean;
  eol?: '\n' | '\r\n';
  neutraliseFormulas?: boolean;
}

const NEEDS_QUOTE = /[",\r\n]|^\s|\s$/;

export function escapeCsvValue(value: unknown, opts: CsvOptions = {}): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  if (s === '') return '';
  if (opts.neutraliseFormulas !== false && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (NEEDS_QUOTE.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>, opts: CsvOptions = {}): string {
  const eol = opts.eol ?? '\r\n';
  const lines: string[] = [];
  lines.push(headers.map((h) => escapeCsvValue(h, { ...opts, neutraliseFormulas: false })).join(','));
  for (const row of rows) {
    lines.push(row.map((c) => escapeCsvValue(c, opts)).join(','));
  }
  return (opts.bom === false ? '' : '﻿') + lines.join(eol) + eol;
}

/** Minimal reader, used by the tests to verify what we wrote. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inQuotes) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
