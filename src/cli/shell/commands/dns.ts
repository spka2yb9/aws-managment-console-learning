/* dig / nslookup / host — 学習者の PC から DNS を引く。実際のネットワークには出ず、シミュレーターの Route 53 (ホストゾーン) を見る。
   ALB・CloudFront・EC2 など AWS が付けた名前は、そのリソースがあれば (それらしい) IP アドレスに解決する。
   打ったコマンドと結果は aws と同じく commands に残す (command は付けないので aws の呼び出しとは区別できる) */
import { useConsole } from '../../../console/store';
import { hash } from '../../../sim/ids';
import type { AwsEnv, DnsRecord, HostedZone } from '../../../sim/types';
import type { CommandContext } from '../lifo';

interface Rr {
  name: string;
  ttl: number;
  type: string;
  data: string;
}
interface Answer {
  status: 'NOERROR' | 'NXDOMAIN';
  answer: Rr[];
  authority: Rr[];
}

const bare = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');
const dot = (s: string) => (s.endsWith('.') ? s : `${s}.`);
const TYPES = ['A', 'AAAA', 'CNAME', 'NS', 'SOA', 'TXT', 'MX', 'ANY'];
const RESOLVER = '127.0.0.53';

/** 名前から決まる、それらしい IP アドレス */
const ip = (seed: string, prefix: number[]) => [...prefix, ...[0, 1, 2, 3].map((k) => (hash(`${seed}#${k}`) % 254) + 1)].slice(0, 4).join('.');

/** AWS が付けた名前 (ホストゾーンの外) の A レコード。無い名前は undefined */
function awsAddresses(env: AwsEnv, name: string): string[] | undefined {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return [name];
  const host = name.replace(/^dualstack\./, '');
  if (env.loadBalancers.some((l) => l.dnsName === host && l.state === 'active')) return [ip(`${host}a`, [52, 68]), ip(`${host}c`, [13, 112])];
  if (env.distributions.some((d) => d.domainName === host)) return [0, 1, 2, 3].map((k) => ip(`${host}${k}`, [18, 65]));
  const ec2 = /^ec2-(\d+)-(\d+)-(\d+)-(\d+)\.[a-z0-9-]+\.compute\.amazonaws\.com$/.exec(host);
  if (ec2 && env.instances.some((i) => i.publicIpAddress === ec2.slice(1).join('.'))) return [ec2.slice(1).join('.')];
  if (/\.s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/.test(host)) return [ip(host, [52, 219])];
  return undefined;
}

const zoneOf = (env: AwsEnv, name: string): HostedZone | undefined => env.hostedZones.filter((z) => name === z.name || name.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];

const soa = (z: HostedZone): Rr[] => z.records.filter((r) => r.type === 'SOA').map((r) => ({ name: dot(z.name), ttl: r.ttl ?? 900, type: 'SOA', data: r.values[0] }));

const rrOf = (name: string, r: DnsRecord): Rr[] => r.values.map((v) => ({ name: dot(name), ttl: r.ttl ?? 300, type: r.type, data: ['CNAME', 'NS'].includes(r.type) ? dot(v) : v }));

/** リゾルバーが返す答え (CNAME はたどる。エイリアスは向き先の IP アドレスを A として返す) */
export function lookup(env: AwsEnv, qname: string, qtype: string): Answer {
  const answer: Rr[] = [];
  let name = bare(qname);
  for (let depth = 0; depth < 8; depth++) {
    const z = zoneOf(env, name);
    if (!z) {
      const ips = awsAddresses(env, name);
      if (!ips) return { status: 'NXDOMAIN', answer, authority: [] };
      if (qtype === 'A' || qtype === 'ANY') answer.push(...ips.map((data) => ({ name: dot(name), ttl: 60, type: 'A', data })));
      return { status: 'NOERROR', answer, authority: [] };
    }
    let records = z.records.filter((r) => r.name === name);
    // ワイルドカード (*.example.com) は、その名前のレコードが無いときだけ使う
    if (!records.length && name !== z.name) records = z.records.filter((r) => r.name === `*.${name.split('.').slice(1).join('.')}`);
    if (!records.length) return { status: 'NXDOMAIN', answer, authority: soa(z) };
    const cname = records.find((r) => r.type === 'CNAME');
    if (cname && qtype !== 'CNAME') {
      answer.push(...rrOf(name, cname));
      name = bare(cname.values[0]);
      continue;
    }
    const hits = records.filter((r) => qtype === 'ANY' || r.type === qtype);
    for (const r of hits) {
      if (r.aliasTarget) answer.push(...(awsAddresses(env, r.aliasTarget) ?? []).map((data) => ({ name: dot(name), ttl: 60, type: 'A', data })));
      else answer.push(...rrOf(name, r));
    }
    return { status: 'NOERROR', answer, authority: hits.length ? [] : soa(z) };
  }
  return { status: 'NOERROR', answer, authority: [] };
}

const line = (r: Rr) => `${r.name}${r.name.length < 16 ? '\t\t' : '\t'}${r.ttl}\tIN\t${r.type}\t${r.data}`;
const when = () => new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (\S+) GMT$/, '$1 $3 $2 $5 UTC $4');

function dig(env: AwsEnv, args: string[]): { out: string; code: number } {
  let name = '';
  let type = 'A';
  let server = RESOLVER;
  const opt = { short: false, cmd: true, answer: true, rest: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-t') type = (args[++i] ?? 'A').toUpperCase();
    else if (a.startsWith('@')) server = a.slice(1);
    else if (a === '+short') opt.short = true;
    else if (a === '+noall') [opt.cmd, opt.answer, opt.rest] = [false, false, false];
    else if (a === '+answer') opt.answer = true;
    else if (a === '+nocmd') opt.cmd = false;
    else if (a.startsWith('+')) continue;
    else if (TYPES.includes(a.toUpperCase()) && name) type = a.toUpperCase();
    else if (!a.startsWith('-')) name = a;
  }
  if (!name) name = '.';
  if (!TYPES.includes(type)) return { out: `dig: '${type}' is not a valid type\n`, code: 1 };
  const r = lookup(env, name, type);
  if (opt.short) return { out: r.answer.map((x) => `${x.data}\n`).join(''), code: 0 };
  const out: string[] = [];
  if (opt.cmd) out.push('', `; <<>> DiG 9.18.28-0ubuntu0.22.04.1-Ubuntu <<>> ${args.join(' ')}`, ';; global options: +cmd');
  if (opt.rest)
    out.push(
      ';; Got answer:',
      `;; ->>HEADER<<- opcode: QUERY, status: ${r.status}, id: ${hash(name + Date.now()) % 65536}`,
      `;; flags: qr rd ra; QUERY: 1, ANSWER: ${r.answer.length}, AUTHORITY: ${r.authority.length}, ADDITIONAL: 1`,
      '',
      ';; OPT PSEUDOSECTION:',
      '; EDNS: version: 0, flags:; udp: 65494',
      ';; QUESTION SECTION:',
      `;${dot(bare(name))}\t\tIN\t${type}`,
      '',
    );
  if (opt.answer && r.answer.length) out.push(...(opt.rest ? [';; ANSWER SECTION:'] : []), ...r.answer.map(line), ...(opt.rest ? [''] : []));
  if (opt.rest && r.authority.length) out.push(';; AUTHORITY SECTION:', ...r.authority.map(line), '');
  if (opt.rest) out.push(`;; Query time: ${(hash(name) % 40) + 3} msec`, `;; SERVER: ${server}#53(${server}) (UDP)`, `;; WHEN: ${when()}`, `;; MSG SIZE  rcvd: ${60 + r.answer.length * 40 + r.authority.length * 80}`, '');
  return { out: out.join('\n') + '\n', code: 0 };
}

function nslookup(env: AwsEnv, args: string[]): { out: string; code: number } {
  let type = 'A';
  const names = args.filter((a) => {
    const m = /^-(?:type|query|q)=(\w+)$/i.exec(a);
    if (m) type = m[1].toUpperCase();
    return !a.startsWith('-');
  });
  const name = names[0];
  if (!name) return { out: '(この端末では対話モードは使えません。nslookup <名前> のように打ってください)\n', code: 1 };
  const head = `Server:\t\t${RESOLVER}\nAddress:\t${RESOLVER}#53\n\n`;
  const r = lookup(env, name, type);
  if (r.status === 'NXDOMAIN') return { out: `${head}** server can't find ${bare(name)}: NXDOMAIN\n\n`, code: 1 };
  if (!r.answer.length) return { out: `${head}Non-authoritative answer:\n*** Can't find ${bare(name)}: No answer\n\n`, code: 0 };
  const body = r.answer.map((x) => {
    const n = bare(x.name);
    if (x.type === 'CNAME') return `${n}\tcanonical name = ${x.data}`;
    if (x.type === 'A') return `Name:\t${n}\nAddress: ${x.data}`;
    if (x.type === 'NS') return `${n}\tnameserver = ${x.data}`;
    return `${n}\t${x.type === 'SOA' ? 'origin' : 'text'} = ${x.data}`;
  });
  return { out: `${head}Non-authoritative answer:\n${body.join('\n')}\n\n`, code: 0 };
}

function host(env: AwsEnv, args: string[]): { out: string; code: number } {
  let type = 'A';
  let name = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-t') type = (args[++i] ?? 'A').toUpperCase();
    else if (!args[i].startsWith('-')) name ||= args[i];
  }
  if (!name) return { out: 'Usage: host [-t type] hostname [server]\n', code: 1 };
  const r = lookup(env, name, type);
  if (r.status === 'NXDOMAIN') return { out: `Host ${bare(name)} not found: 3(NXDOMAIN)\n`, code: 1 };
  if (!r.answer.length) return { out: `${bare(name)} has no ${type} record\n`, code: 0 };
  const text = (x: Rr) => {
    const n = bare(x.name);
    if (x.type === 'CNAME') return `${n} is an alias for ${x.data}`;
    if (x.type === 'A') return `${n} has address ${x.data}`;
    if (x.type === 'NS') return `${n} name server ${x.data}`;
    if (x.type === 'MX') return `${n} mail is handled by ${x.data}`;
    if (x.type === 'TXT') return `${n} descriptive text ${x.data}`;
    return `${n} has ${x.type} record ${x.data}`;
  };
  return { out: r.answer.map(text).join('\n') + '\n', code: 0 };
}

const command =
  (name: string, fn: (env: AwsEnv, args: string[]) => { out: string; code: number }) =>
  async (ctx: CommandContext): Promise<number> => {
    const s = useConsole.getState();
    const { out, code } = fn(s.env, ctx.args);
    ctx.stdout.write(out);
    s.recordCommand({ instanceId: '', line: [name, ...ctx.args].join(' '), output: out, ok: code === 0, at: Date.now() });
    return code;
  };

export default { dig: command('dig', dig), nslookup: command('nslookup', nslookup), host: command('host', host) };
