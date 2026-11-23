/* --output json / text / table / yaml。text と table は awscli の formatter.py / text.py / table.py と同じ並べ方にする */

type J = unknown;
const isObj = (v: J): v is Record<string, J> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isScalar = (v: J) => !isObj(v) && !Array.isArray(v);
/* Python の str() と同じ書き方（True / False / None） */
const str = (v: J) => (v === true ? 'True' : v === false ? 'False' : v === null || v === undefined ? 'None' : String(v));

export type OutputFormat = 'json' | 'text' | 'table' | 'yaml';
export const OUTPUT_FORMATS: OutputFormat[] = ['json', 'text', 'table', 'yaml'];

export function format(data: J, output: OutputFormat, title: string): string {
  if (output === 'text') return text(data);
  if (output === 'table') return table(data, title);
  if (output === 'yaml') return yaml(data) + '\n';
  return JSON.stringify(data, null, 4) + '\n';
}

/* ---- text ---- */
function text(data: J): string {
  const out: string[] = [];
  textItem(data, out);
  return out.map((l) => l + '\n').join('');
}

function textItem(item: J, out: string[], id?: string, scalarKeys?: string[]) {
  if (isObj(item)) textDict(item, out, id, scalarKeys);
  else if (Array.isArray(item)) textList(item, out, id);
  else out.push(str(item));
}

function textList(item: J[], out: string[], id?: string) {
  if (!item.length) return;
  if (item.some(isObj)) {
    const keys = allScalarKeys(item);
    for (const el of item) textItem(el, out, id, keys);
  } else if (item.some(Array.isArray)) {
    const scalars = item.filter(isScalar);
    if (scalars.length) scalarList(scalars, out, id);
    for (const el of item.filter((x) => !isScalar(x))) textItem(el, out, id);
  } else scalarList(item, out, id);
}

function scalarList(items: J[], out: string[], id?: string) {
  if (id !== undefined) for (const x of items) out.push(`${id.toUpperCase()}\t${str(x)}`);
  else out.push(items.map(str).join('\t'));
}

function textDict(item: Record<string, J>, out: string[], id?: string, scalarKeys?: string[]) {
  const scalars: string[] = [];
  const nested: [string, J][] = [];
  if (!scalarKeys) {
    for (const k of Object.keys(item).sort()) {
      if (isScalar(item[k])) scalars.push(str(item[k]));
      else nested.push([k, item[k]]);
    }
  } else {
    for (const k of scalarKeys) scalars.push(k in item ? str(item[k]) : '');
    for (const k of Object.keys(item).filter((k) => !scalarKeys.includes(k)).sort()) nested.push([k, item[k]]);
  }
  if (scalars.length) out.push((id !== undefined ? [id.toUpperCase(), ...scalars] : scalars).join('\t'));
  for (const [k, v] of nested) textItem(v, out, k);
}

function allScalarKeys(list: J[]): string[] {
  const keys = new Set<string>();
  for (const d of list) if (isObj(d)) for (const [k, v] of Object.entries(d)) if (isScalar(v)) keys.add(k);
  return [...keys].sort();
}

/* ---- table ---- */
interface Section {
  title?: string;
  headers: string[];
  rows: string[][];
  children: Section[];
}

function build(title: string | undefined, v: J): Section {
  const s: Section = { title, headers: [], rows: [], children: [] };
  if (isObj(v)) {
    const keys = Object.keys(v).sort();
    const scalars = keys.filter((k) => isScalar(v[k]));
    if (scalars.length) {
      s.headers = scalars;
      s.rows = [scalars.map((k) => str(v[k]))];
    }
    for (const k of keys.filter((k) => !isScalar(v[k]))) s.children.push(build(k, v[k]));
  } else if (Array.isArray(v)) {
    if (v.some(isObj)) {
      const keys = allScalarKeys(v);
      s.headers = keys;
      for (const el of v) {
        if (!isObj(el)) continue;
        if (keys.length) s.rows.push(keys.map((k) => (k in el ? str(el[k]) : '')));
        for (const k of Object.keys(el).sort().filter((k) => !isScalar(el[k]))) s.children.push(build(k, el[k]));
      }
    } else {
      for (const el of v) {
        if (Array.isArray(el) && el.every(isScalar)) s.rows.push(el.map(str));
        else if (isScalar(el)) s.rows.push([str(el)]);
        else s.children.push(build(undefined, el));
      }
    }
  } else s.rows = [[str(v)]];
  return s;
}

const cols = (s: Section) => Math.max(s.headers.length, ...s.rows.map((r) => r.length), 0);
function natural(s: Section): number[] {
  return Array.from({ length: cols(s) }, (_, i) => Math.max(s.headers[i]?.length ?? 0, ...s.rows.map((r) => r[i]?.length ?? 0)) + 4);
}
function need(s: Section): number {
  const n = natural(s);
  return Math.max(s.title ? s.title.length + 4 : 0, n.length ? n.reduce((a, b) => a + b, 0) + n.length - 1 : 0, ...s.children.map((c) => need(c) + 2));
}
const center = (t: string, w: number) => {
  const left = Math.floor((w - t.length) / 2);
  return ' '.repeat(Math.max(0, left)) + t + ' '.repeat(Math.max(0, w - t.length - left));
};

function render(s: Section, w: number): string[] {
  const n = natural(s);
  if (n.length) {
    const extra = w - (n.reduce((a, b) => a + b, 0) + n.length - 1);
    for (let i = 0; i < n.length; i++) n[i] += Math.floor(extra / n.length) + (i >= n.length - (extra % n.length) ? 1 : 0);
  }
  const sep = '+' + (n.length ? n.map((c) => '-'.repeat(c)).join('+') : '-'.repeat(w)) + '+';
  const lines: string[] = [];
  if (s.title) lines.push('|' + center(s.title, w) + '|');
  if (s.title && (n.length || s.children.length)) lines.push(sep);
  if (s.headers.length) lines.push('|' + s.headers.map((h, i) => center(h, n[i])).join('|') + '|', sep);
  if (s.rows.length) {
    for (const r of s.rows) lines.push('|' + n.map((c, i) => ('  ' + (r[i] ?? '')).padEnd(c)).join('|') + '|');
    lines.push(sep);
  }
  for (const c of s.children) lines.push(...render(c, w - 2).map((l) => '|' + l + '|'));
  return lines;
}

function table(data: J, title: string): string {
  if (data === null || data === undefined || (isObj(data) && !Object.keys(data).length)) return '';
  const s = build(title, data);
  const w = need(s);
  return ['-'.repeat(w + 2), ...render(s, w)].map((l) => l + '\n').join('');
}

/* ---- yaml ---- */
const yamlScalar = (v: J) => (v === null || v === undefined ? 'null' : typeof v === 'string' ? (/^[\w./@:-][\w ./@:+-]*$/.test(v) && !/^(true|false|null|yes|no|\d[\d.]*)$/i.test(v) && !/:\s/.test(v) ? v : JSON.stringify(v)) : String(v));
function yaml(v: J, indent = ''): string {
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return v.map((el) => (isScalar(el) ? `${indent}- ${yamlScalar(el)}` : `${indent}- ${yaml(el, indent + '  ').trimStart()}`)).join('\n');
  }
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    return keys
      .map((k) => {
        const x = v[k];
        if (isScalar(x)) return `${indent}${k}: ${yamlScalar(x)}`;
        if ((Array.isArray(x) && !x.length) || (isObj(x) && !Object.keys(x).length)) return `${indent}${k}: ${Array.isArray(x) ? '[]' : '{}'}`;
        return `${indent}${k}:\n${yaml(x, Array.isArray(x) ? indent : indent + '  ')}`;
      })
      .join('\n');
  }
  return indent + yamlScalar(v);
}
