import fs from 'node:fs';
import path from 'node:path';
import { outDir } from './config.mjs';

export function ensureOut(sub = '') {
  const dir = path.join(outDir(), sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir(), name), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(name, data) {
  ensureOut();
  const file = path.join(outDir(), name);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

/** Run fn over items with at most n in flight. Results keep input order. */
export async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

export const slug = (s) =>
  String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'x';

export function hostOf(url) {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function hostMatches(host, list) {
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

export function toCsv(rows, cols) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

/** Minimal RFC-4180 CSV parser (header row -> objects). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  const [head = [], ...body] = rows;
  const keys = head.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

export function log(...a) {
  console.error(...a);
}
