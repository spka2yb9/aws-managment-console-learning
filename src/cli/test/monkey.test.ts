// @vitest-environment node
/* aws コマンドのモンキーテスト: レッスンの初期状態ごとに、ランダムなオペレーションとランダムな引数を打ち続ける。
   落ちたら負け: JS の例外がそのまま出る、[object Object] / NaN / undefined / Invalid Date が出る、終わらない、
   壊れた状態が残って後の describe が落ちる。
   MONKEY_SEED / MONKEY_N で再現・増量できる (既定は小さく、CI でも数秒で終わる量) */
import { completeAws, timing } from '../aws/aws';
import { SERVICES } from '../aws/registry';
import type { OperationSpec, ParamSpec } from '../aws/types';
import { bootShell } from './harness';
import { ALL_LESSONS } from '../../lessons';
import { cliFiles, cliLesson } from '../../lessons/cli';
import type { ConsoleExerciseContent, Lesson, TaskContext } from '../../lesson/types';
import { liveSpec } from '../../diagram/build';
import { layoutDiagram } from '../../diagram/layout';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SEED = Number(ENV.MONKEY_SEED ?? 1);
const N = Number(ENV.MONKEY_N ?? 40);
const ONLY = ENV.MONKEY_LESSONS?.split(',');

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const GARBAGE = ['', ' ', 'x', '-', '0', '-1', '1.5', '99999999999999', 'null', 'true', 'None', '*', '..', '/', 'a,b', 'a=b', '=', ',', '[', ']', '{', '}', '[]', '{}', '"', "'", '\\', '$HOME', '日本語', '😀', 'a'.repeat(300), 'arn:aws:iam::123456789012:root', 'arn:', 's3://', 's3://nope-bucket/k', 'file://nope.json', 'fileb://nope', 'i-0', 'vpc-', 'sg-123', 'subnet-zzz', '10.0.0.0/33', '0.0.0.0/0', '256.1.1.1', '::/0', 'ap-northeast-9', 'us-east-1a', 'Key=', 'Key=Name', 'Name=,Values=', '[{}]', '[{Key=a}]', '{"a":1}', '[1,2]', '{"Key":null}', '1e9', 'Infinity', '2026-13-40', '1970-01-01T00:00:00Z'];
const KEYS = ['Key', 'Value', 'Name', 'Values', 'Id', 'Type', 'Port', 'Protocol', 'CidrIp', 'FromPort', 'ToPort', 'IpProtocol', 'Enabled', 'Arn', 'Weight', 'Priority', 'Action', 'Field', 'Statement', 'Effect', 'Resource', 'Principal', 'TargetGroupArn', 'ContainerPort', 'ResourceType', 'Tags', 'Dimensions', 'MetricName', 'Seconds', 'Days', 'Status', 'Expiration', 'Rules', 'Filter', 'Prefix', 'ID', 'Mode', 'DeviceName', 'Ebs', 'VolumeSize', 'Comparison', 'Criteria'];
const QUERIES = ['[0]', 'length(@)', '*', '*[0]', '@', 'foo', 'Foo.Bar[0]', 'keys(@)', '[]', 'Bad[', '`1`', "sort_by(@, &x)", 'to_string(@)', 'max(@)', '[?x==`1`]', '*.*', 'values(@)[0][0]'];
const OUTPUTS = ['json', 'text', 'table', 'yaml', 'yaml-stream', 'xml'];
const REGIONS = ['us-east-1', 'eu-west-1', 'mars-1', 'ap-northeast-1'];

/* パラメータ名から、それらしい値を選ぶ */
const PREFIX: Record<string, RegExp> = {
  'vpc-id': /^vpc-/, subnet: /^subnet-/, instance: /^i-/, 'group-id': /^sg-/, 'security-group': /^sg-/, 'route-table': /^rtb-/, 'internet-gateway': /^igw-/, 'nat-gateway': /^nat-/, allocation: /^eipalloc-/,
  'launch-template': /^lt-|^[a-z][\w-]*-lt$/, 'load-balancer-arn': /:loadbalancer\//, 'target-group-arn': /:targetgroup\//, 'listener-arn': /:listener\//, 'rule-arn': /:listener-rule\//, arn: /^arn:/,
  bucket: /-\d{12}$/, 'db-': /^webapp-db|^db-|snap/, 'function-name': /^[\w-]+$/, 'queue-url': /^https:\/\/sqs/, 'hosted-zone': /^Z|hostedzone/, 'distribution-id': /^E[A-Z0-9]+$/, 'detector-id': /^[0-9a-f]{20,}$/, 'cluster': /cluster|webapp/, 'log-group': /^\//,
  'user-name': /^[a-z][\w.-]*$/, 'role-name': /role|Role/, 'policy-arn': /:policy\//, 'certificate-arn': /:certificate\//, 'web-acl': /webacl|acl/, 'image-id': /^ami-/, 'volume': /^vol-/, 'snapshot': /snap/,
};

/* 環境の中の文字列 (ID・名前・ARN) を、本物らしい値として使う */
function harvest(env: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || out.size > 600) return;
    if (typeof v === 'string') {
      if (v.length > 0 && v.length < 120 && !/\s/.test(v)) out.add(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(env, 0);
  return [...out];
}

function gen(r: () => number, pool: string[]) {
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const scalar = (name = '') => {
    if (r() < 0.35) return pick(GARBAGE);
    const want = Object.entries(PREFIX).find(([k]) => name.includes(k))?.[1];
    const fit = want ? pool.filter((x) => want.test(x)) : [];
    return fit.length && r() < 0.8 ? pick(fit) : pool.length ? pick(pool) : pick(GARBAGE);
  };
  const shorthand = (depth = 0): string => {
    const n = 1 + Math.floor(r() * 3);
    const kv: string[] = [];
    for (let i = 0; i < n; i++) {
      const k = pick(KEYS);
      const roll = r();
      const v = depth < 1 && roll < 0.15 ? `[{${shorthand(depth + 1)}}]` : depth < 1 && roll < 0.25 ? `{${shorthand(depth + 1)}}` : roll < 0.35 ? `${scalar()},${scalar()}` : scalar();
      kv.push(`${k}=${v}`);
    }
    return kv.join(',');
  };
  const json = (depth = 0): unknown => {
    const roll = r();
    if (depth > 2 || roll < 0.4) return r() < 0.5 ? scalar() : pick([0, -1, 1.5, true, null, 65536]);
    if (roll < 0.6) return [json(depth + 1), json(depth + 1)];
    const o: Record<string, unknown> = {};
    for (let i = 0; i < 1 + Math.floor(r() * 3); i++) o[pick(KEYS)] = json(depth + 1);
    return o;
  };
  const structured = () => {
    const roll = r();
    return roll < 0.45 ? shorthand() : roll < 0.8 ? JSON.stringify(json(1)) : pick(GARBAGE);
  };
  const value = (p: ParamSpec): string[] => {
    if (r() < 0.08) return [pick(GARBAGE)];
    switch (p.type) {
      case 'integer':
        return [pick(['0', '1', '-1', '2', '5', '30', '60', '80', '443', '65535', '65536', '3600', '99999999999', 'abc', '1.5', ' 7'])];
      case 'list':
        if (p.of === 'structure') return Array.from({ length: 1 + Math.floor(r() * 2) }, structured);
        return r() < 0.2 ? [JSON.stringify([scalar(p.name), scalar(p.name)])] : Array.from({ length: 1 + Math.floor(r() * 3) }, () => scalar(p.name));
      case 'structure':
      case 'map':
        return [structured()];
      case 'timestamp':
        return [pick(['2026-01-01', '2026-11-20T00:00:00Z', '1700000000', 'yesterday', '', '2026-02-30'])];
      default:
        return [scalar(p.name)];
    }
  };
  return { pick, scalar, value };
}

/* 模範解答のコマンドを少し壊す (トークンを消す・入れ替える・ゴミに差し替える・複製する) */
function mutate(r: () => number, pool: string[], line: string): string {
  const g = gen(r, pool);
  const toks = [...(line.match(/'[^']*'|"(?:\\.|[^"\\])*"|\S+/g) ?? [])];
  const times = 1 + Math.floor(r() * 2);
  for (let n = 0; n < times && toks.length > 2; n++) {
    const i = 2 + Math.floor(r() * (toks.length - 2));
    const roll = r();
    if (roll < 0.25) toks.splice(i, 1);
    else if (roll < 0.5) toks[i] = q(g.scalar(toks[i - 1]?.replace(/^--/, '') ?? ''));
    else if (roll < 0.6) toks.splice(i, 0, toks[i]);
    else if (roll < 0.7 && i + 1 < toks.length) [toks[i], toks[i + 1]] = [toks[i + 1], toks[i]];
    else if (roll < 0.8) toks[i] = toks[i].slice(0, Math.floor(r() * toks[i].length));
    else if (roll < 0.9) toks.push(`--query ${q(g.pick(QUERIES))}`, `--output ${g.pick(OUTPUTS)}`);
    else toks.splice(i, 0, q(g.pick(GARBAGE)));
  }
  return toks.join(' ');
}

function command(r: () => number, pool: string[], real: string[]): string {
  if (real.length && r() < 0.5) return mutate(r, pool, real[Math.floor(r() * real.length)]);
  const g = gen(r, pool);
  const svcs = [...SERVICES.values()];
  const svc = g.pick(svcs);
  const op: OperationSpec = g.pick([...svc.ops.values()]);
  const parts = ['aws', svc.name, ...op.name.split(' ')];
  for (const p of op.params) {
    const include = p.required ? r() < 0.9 : r() < 0.35;
    if (!include) continue;
    if (p.positional) {
      parts.push(q(r() < 0.3 ? g.pick(['.', 'out.json', 's3://' + g.scalar(), `s3://${g.scalar()}/${g.scalar()}`, '~/x', '/etc/hosts']) : g.scalar()));
      continue;
    }
    if (p.type === 'boolean') {
      parts.push(r() < 0.8 ? `--${p.name}` : `--no-${p.name}`);
      continue;
    }
    const vs = g.value(p).map((v) => (r() < 0.03 ? 'file://' + v : v));
    parts.push(r() < 0.1 && vs.length === 1 ? q(`--${p.name}=${vs[0]}`) : `--${p.name} ${vs.map(q).join(' ')}`);
  }
  if (r() < 0.05) parts.push(`--${g.pick(['bogus', 'page-size', 'max-items', 'starting-token'])} ${q(g.scalar())}`);
  if (r() < 0.05) parts.push(q(g.scalar()));
  if (r() < 0.25) parts.push(`--query ${q(g.pick(QUERIES))}`);
  if (r() < 0.25) parts.push(`--output ${g.pick(OUTPUTS)}`);
  if (r() < 0.07) parts.push(`--region ${g.pick(REGIONS)}`);
  if (r() < 0.03) parts.push(`--profile ${g.pick(['nope', 'default'])}`);
  if (r() < 0.02) parts.push('help');
  let line = parts.join(' ');
  if (r() < 0.04) line += ` | ${g.pick(['head -3', 'wc -l', 'grep a', 'cat'])}`;
  return line;
}

/* JS の例外や、値が抜けたまま書いた跡 */
const CRASH = /TypeError|ReferenceError|RangeError|SyntaxError(?!: (Unexpected token|Expected|JSON|Bad control|Unterminated|Unexpected end|Unexpected non-whitespace|No number))|is not a function|is not iterable|Cannot read propert|Cannot set propert|Cannot assign to read only|object is not extensible|Maximum call stack|\[object Object\]|Invalid time value|Invalid Date|\bNaN\b|(?<![\w"'-])undefined(?![\w"'-])/;
/* 終了コード 255 で出てよいもの (それ以外の 255 は、捕まえていない例外) */
const OK255 = /Error loading SSO Token|The user-provided path .* does not exist|ssh: connect to host|The specified sso-session does not exist|Missing the following required SSO configuration values|Waiter \w+ failed|Could not connect to the endpoint URL|The config profile \(.*\) could not be found|Unable to locate credentials|Error when retrieving token|Token has expired|SSO session/;

/* すべての CLI レッスンの模範解答 (今の環境で組み立てる。組み立てられないものは飛ばす) */
const ALL_TASKS = ALL_LESSONS.flatMap((l) => cliLesson(l)?.steps ?? []).flatMap((s) => (s.type === 'exercise' ? s.tasks : []));
function realCommands(ctx: Parameters<Extract<NonNullable<(typeof ALL_TASKS)[number]['command']>, (...a: never[]) => unknown>>[0]): string[] {
  return ALL_TASKS.flatMap((t) => {
    try {
      const c = typeof t.command === 'function' ? t.command(ctx) : t.command;
      return c ? c.split(/\n/).filter((x) => x.trim()) : [];
    } catch {
      return [];
    }
  });
}

interface Finding {
  lesson: string;
  line: string;
  exitCode: number;
  out: string;
  why: string;
}

const lessons = ALL_LESSONS.filter((l) => cliLesson(l) && (!ONLY || ONLY.includes(String(l.number).padStart(2, '0'))));
const findings: Finding[] = [];

describe('aws Tab completion monkey test', () => {
  it('never throws and only suggests strings', () => {
    const r = rng(SEED);
    const words = ['ec2', 's3', 'wait', 'help', '--output', '--region', '--query', '--profile', 'describe-vpcs', 'instance-running', '--filters', '', '-', '--', 'x', 'aws', 'cloudwatch', 'get-metric-statistics', '--no-paginate'];
    for (let i = 0; i < 3000; i++) {
      const ws = Array.from({ length: Math.floor(r() * 5) }, () => words[Math.floor(r() * words.length)]);
      const cur = words[Math.floor(r() * words.length)].slice(0, Math.floor(r() * 4));
      const out = completeAws(ws, cur);
      expect(Array.isArray(out) && out.every((x) => typeof x === 'string' && x.startsWith(cur)), `${ws.join(' ')} | ${cur}`).toBe(true);
    }
  });
});

describe('aws monkey test', () => {
  let now = Date.now();
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    timing.sleep = async (ms: number) => {
      now += ms;
      vi.setSystemTime(now);
    };
  });
  afterAll(() => vi.useRealTimers());

  it.each(lessons.map((l) => [l.number, l] as const))('lesson %s', async (num, base) => {
    const lesson = cliLesson(base) as Lesson;
    const env = lesson.scenario();
    const { shell, sh, state } = await bootShell(env, cliFiles(lesson, env));
    const r = rng(SEED * 1000 + ALL_LESSONS.indexOf(base));
    const before = findings.length;
    const exercises = lesson.steps.filter((s): s is ConsoleExerciseContent => s.type === 'exercise');
    const note = (line: string, exitCode: number, out: string, why: string) => findings.push({ lesson: String(num), line, exitCode, out: out.slice(0, 3000), why });
    for (let i = 0; i < N; i++) {
      const pool = harvest(state().env);
      const line = command(r, pool, realCommands(state()));
      let res: Awaited<ReturnType<typeof sh>> | 'hang';
      try {
        res = await Promise.race([sh(line), new Promise<'hang'>((ok) => setTimeout(() => ok('hang'), 8000))]);
      } catch (e) {
        note(line, -1, String((e as Error)?.stack ?? e), 'shell threw');
        continue;
      }
      if (res === 'hang') {
        note(line, -1, '', 'hang');
        break;
      }
      const shellState = shell as unknown as { remote: string | null; ssmSession: string | null };
      /* インスタンスの中 (EC2 Instance Connect / Session Manager) でも少し打ってから出る */
      if (shellState.remote || shellState.ssmSession) {
        const real = realCommands(state());
        for (let k = Math.floor(r() * 4); k > 0; k--) {
          const inner = mutate(r, pool, real[Math.floor(r() * real.length)] ?? 'ls');
          const ir = await sh(inner);
          const im = CRASH.exec(ir.out);
          if (im && !line.includes(im[0]) && !inner.includes(im[0])) note(`${line}\n  inside: ${inner}`, ir.exitCode, ir.out, `crash text inside: ${im[0]}`);
          if (!shellState.remote && !shellState.ssmSession) break;
        }
        if (shellState.remote || shellState.ssmSession) await sh('exit');
      }
      const m = CRASH.exec(res.out);
      const echoed = m && /^(NaN|undefined|Invalid Date|\[object Object\])$/.test(m[0]) && line.includes(m[0]);
      if (m && !echoed) note(line, res.exitCode, res.out, `crash text: ${m[0]}`);
      else if (res.exitCode === 255 && !OK255.test(res.out)) note(line, res.exitCode, res.out, 'unexpected 255');
      else if (/^aws /.test(line) && !/[|;&]/.test(line) && ![0, 1, 2, 130, 252, 253, 254, 255].includes(res.exitCode)) note(line, res.exitCode, res.out, 'odd exit code');
      /* 時間を進め (インスタンスの起動など)、CLI 版のレッスン画面が毎回することをする: 演習の判定と構成図 */
      now += Math.floor(r() * 120_000);
      vi.setSystemTime(now);
      try {
        state().tick();
        for (const ex of exercises) {
          for (const t of ex.tasks) t.done(state() as TaskContext);
          ex.validate(state() as TaskContext);
        }
        const spec = liveSpec(state().env);
        if (i % 40 === 39) {
          const laid = await layoutDiagram(spec, { maxAttempts: 1 });
          if (JSON.stringify(laid).includes('null')) note(line, res.exitCode, JSON.stringify(laid).slice(0, 600), 'diagram has NaN coordinates');
        }
      } catch (e) {
        note(line, res.exitCode, String((e as Error)?.stack ?? e).slice(0, 3000), 'lesson page threw after');
      }
      /* 状態が壊れていないか: 引数の要らない参照系を 10 回に 1 回まとめて打つ */
      if (i % 10 === 9) {
        for (const svc of SERVICES.values())
          for (const op of svc.ops.values()) {
            if (!op.readOnly || op.waiter || op.params.some((p) => p.required) || op.name.startsWith('wait ')) continue;
            const probe = `aws ${svc.name} ${op.name} --region ${state().env.region}`;
            const pr = await sh(probe);
            if (pr.exitCode !== 0 && pr.exitCode !== 254 && pr.exitCode !== 252) note(`${line}\n  then: ${probe}`, pr.exitCode, pr.out, 'probe failed after');
            else if (CRASH.test(pr.out)) note(`${line}\n  then: ${probe}`, pr.exitCode, pr.out, `probe crash text: ${CRASH.exec(pr.out)![0]}`);
          }
      }
    }
    shell.destroy();
    expect(findings.slice(before).map((f) => `${f.why}: ${f.line}\n${f.out}`)).toEqual([]);
  });
});
