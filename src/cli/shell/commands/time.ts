/* 時間のコマンド (Lifo の同梱のものを置き換える)
   sleep … 待つ。待つ間もシミュレーターの時計を進める (テストでは timing.sleep が時計を進めるだけなので、一瞬で終わる)
   date  … GNU date のよく使う部分。-u、-d '1 hour ago' / -d @1700000000、+FORMAT、-I。
           CloudWatch の --start-time に $(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ) のように渡すため */
import { useConsole } from '../../../console/store';
import { timing } from '../../aws/aws';
import type { CommandContext } from '../lifo';

async function sleep(ctx: CommandContext): Promise<number> {
  const unit: Record<string, number> = { '': 1000, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  let total = 0;
  for (const x of ctx.args) {
    const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(x);
    if (!m) {
      ctx.stderr.write(`sleep: invalid time interval '${x}'\nTry 'sleep --help' for more information.\n`);
      return 1;
    }
    total += Number(m[1]) * unit[m[2]];
  }
  if (!ctx.args.length) {
    ctx.stderr.write("sleep: missing operand\nTry 'sleep --help' for more information.\n");
    return 1;
  }
  try {
    for (let left = total; left > 0; left -= 1000) {
      await timing.sleep(Math.min(1000, left), ctx.signal);
      useConsole.getState().tick();
    }
  } catch {
    return 130;
  }
  return 0;
}

const UNITS: Record<string, number> = { second: 1000, sec: 1000, minute: 60_000, min: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };

/** -d の文字列 → エポックミリ秒 (読めなければ NaN) */
export function parseDate(s: string, now: number): number {
  const t = s.trim().toLowerCase();
  if (!t || t === 'now' || t === 'today') return now;
  if (t === 'yesterday') return now - UNITS.day;
  if (t === 'tomorrow') return now + UNITS.day;
  const epoch = /^@(-?\d+(?:\.\d+)?)$/.exec(t);
  if (epoch) return Number(epoch[1]) * 1000;
  let total = 0;
  let matched = false;
  const rest = t.replace(/([+-]?\s*\d+)\s*(second|sec|minute|min|hour|day|week)s?(\s+ago)?/g, (_, n: string, u: string, ago?: string) => {
    matched = true;
    total += Number(n.replace(/\s/g, '')) * UNITS[u] * (ago ? -1 : 1);
    return '';
  });
  if (matched && !rest.trim()) return now + total;
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(' ', 'T') : s);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(t: number, fmt: string, utc: boolean): string {
  const d = new Date(t);
  const g = utc
    ? { Y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), H: d.getUTCHours(), M: d.getUTCMinutes(), S: d.getUTCSeconds(), w: d.getUTCDay(), off: 0 }
    : { Y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), H: d.getHours(), M: d.getMinutes(), S: d.getSeconds(), w: d.getDay(), off: -d.getTimezoneOffset() };
  const z = `${g.off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(g.off) / 60))}${pad(Math.abs(g.off) % 60)}`;
  const zone = utc || g.off === 0 ? 'UTC' : g.off === 540 ? 'JST' : z;
  const map: Record<string, string> = {
    Y: String(g.Y), m: pad(g.m + 1), d: pad(g.d), e: String(g.d).padStart(2), H: pad(g.H), M: pad(g.M), S: pad(g.S),
    s: String(Math.floor(t / 1000)), N: pad((t % 1000) * 1_000_000, 9), F: `${g.Y}-${pad(g.m + 1)}-${pad(g.d)}`, T: `${pad(g.H)}:${pad(g.M)}:${pad(g.S)}`,
    a: DAYS[g.w], b: MONTHS[g.m], z, Z: zone, '%': '%',
  };
  return fmt.replace(/%([a-zA-Z%])/g, (all, c: string) => map[c] ?? all);
}

async function date(ctx: CommandContext): Promise<number> {
  let utc = ctx.env.TZ === 'UTC' || ctx.env.TZ === 'UTC0';
  let when: string | undefined;
  let fmt: string | undefined;
  let iso: string | undefined;
  const a = ctx.args;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === '-u' || x === '--utc' || x === '--universal') utc = true;
    else if (x === '-d' || x === '--date') when = a[++i];
    else if (x.startsWith('--date=')) when = x.slice(7);
    else if (x.startsWith('-d') && x.length > 2) when = x.slice(2);
    else if (x === '-I' || x.startsWith('-I') || x.startsWith('--iso-8601')) iso = x.includes('=') ? x.split('=')[1] : x.startsWith('-I') ? x.slice(2) || 'date' : 'date';
    else if (x.startsWith('+')) fmt = x.slice(1);
    else {
      ctx.stderr.write(`date: invalid date '${x}'\n`);
      return 1;
    }
  }
  const t = when === undefined ? Date.now() : parseDate(when, Date.now());
  if (Number.isNaN(t)) {
    ctx.stderr.write(`date: invalid date '${when}'\n`);
    return 1;
  }
  if (iso !== undefined) {
    const zone = formatDate(t, '%z', utc).replace(/(\d{2})(\d{2})$/, '$1:$2');
    fmt = iso === 'date' ? '%F' : iso === 'hours' ? `%FT%H${zone}` : iso === 'minutes' ? `%FT%H:%M${zone}` : `%FT%T${zone}`;
  }
  ctx.stdout.write(formatDate(t, fmt ?? '%a %b %e %T %Z %Y', utc) + '\n');
  return 0;
}

export default { sleep, date };
