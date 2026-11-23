/* aws コマンド本体 (AWS CLI v2 のふりをする)。
   引数を解析し、オペレーション (services/*.ts) をシミュレーターの環境に対して動かし、--query / --output で整えて出す。
   変更系は useConsole.cli() の中で動くので、失敗すれば何も変わらず、成功すれば CloudTrail に CLI からの呼び出しとして残る。 */
import jmespath from 'jmespath';
import { useConsole } from '../../console/store';
import { emptyEnv, REGIONS } from '../../sim/env';
import { AwsError, type AwsEnv } from '../../sim/types';
import { format, OUTPUT_FORMATS, type OutputFormat } from './format';
import { SERVICES, serviceNames } from './registry';
import { parseShorthand, ShorthandError } from './shorthand';
import { ParamError, pascal, type Authorizer, type OpContext, type OperationSpec, type ParamSpec, type ParamValue, type RawResult } from './types';

const AUTHORIZERS = Object.values(import.meta.glob<{ default: Authorizer }>('./auth/*.ts', { eager: true })).map((m) => m.default);

export const CLI_VERSION = 'aws-cli/2.17.20 Python/3.11.9 Linux/5.15.0 exe/x86_64.ubuntu.22';
export const HOME = '/home/learner';

export interface AwsIo {
  stdout(s: string): void;
  stderr(s: string): void;
  /** シェルの環境変数 (AWS_REGION / AWS_PROFILE など) */
  shellEnv: Record<string, string>;
  cwd: string;
  readFile(abs: string): string | null;
  writeFile(abs: string, content: string): void;
  signal?: AbortSignal;
  /** aws ec2-instance-connect ssh でインスタンスに入る */
  connect(instanceId: string): void;
}

/** 1 回の aws の呼び出し (演習の判定に使う) */
export interface AwsCall {
  /** 'ec2 create-subnet' */
  command?: string;
  service?: string;
  /** API の名前: 'CreateSubnet' */
  operation?: string;
  params?: Record<string, unknown>;
  query?: string;
  output?: OutputFormat;
  region?: string;
  profile?: string;
  ok: boolean;
  errorCode?: string;
}

const USAGE = `usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]
To see help text, you can run:

  aws help
  aws <command> help
  aws <command> <subcommand> help
`;

export class CliError extends Error {
  constructor(message: string, readonly exitCode: number, readonly usage = false) {
    super(message);
  }
}

const GLOBAL_VALUE = new Set(['region', 'output', 'query', 'profile', 'color', 'cli-read-timeout', 'cli-connect-timeout', 'endpoint-url', 'ca-bundle', 'cli-binary-format']);
/* ページ分けのオプション。オペレーションが自分で持っていなければ読み捨てる (シミュレーターは 1 回で全部返す) */
const PAGINATION = new Set(['page-size', 'max-items', 'starting-token']);
const GLOBAL_FLAG = new Set(['no-cli-pager', 'debug', 'no-paginate', 'no-verify-ssl', 'no-sign-request', 'version', 'cli-auto-prompt', 'no-cli-auto-prompt']);

export const resolvePath = (cwd: string, p: string) => {
  const abs = p === '~' || p.startsWith('~/') ? HOME + p.slice(1) : p.startsWith('/') ? p : `${cwd}/${p}`;
  const out: string[] = [];
  for (const s of abs.split('/')) {
    if (s === '..') out.pop();
    else if (s && s !== '.') out.push(s);
  }
  return '/' + out.join('/');
};

/* ~/.aws/config と ~/.aws/credentials (INI)。[default] / [profile x] / [x] を 1 つの表に */
export function readIni(text: string | null): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let cur: Record<string, string> | null = null;
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim();
    const sec = /^\[\s*(?:profile\s+)?([^\]]+?)\s*\]$/.exec(line);
    if (sec) cur = out[sec[1]] ??= {};
    else if (cur && line.includes('=')) cur[line.slice(0, line.indexOf('=')).trim()] = line.slice(line.indexOf('=') + 1).trim();
  }
  return out;
}

interface Globals {
  region?: string;
  output?: string;
  query?: string;
  profile?: string;
  version?: boolean;
  endpointUrl?: string;
}

function splitGlobals(args: string[]): { globals: Globals; rest: string[] } {
  const globals: Globals = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(a);
    if (m && GLOBAL_FLAG.has(m[1])) {
      if (m[1] === 'version') globals.version = true;
      continue;
    }
    if (m && GLOBAL_VALUE.has(m[1])) {
      const v = m[2] ?? args[++i];
      if (v === undefined || (m[2] === undefined && /^--./.test(v))) throw new CliError(`aws: error: argument --${m[1]}: expected one argument`, 252, true);
      if (m[1] === 'region') globals.region = v;
      else if (m[1] === 'output') globals.output = v;
      else if (m[1] === 'query') globals.query = v;
      else if (m[1] === 'profile') globals.profile = v;
      else if (m[1] === 'endpoint-url') globals.endpointUrl = v;
      continue;
    }
    rest.push(a);
  }
  return { globals, rest };
}

function readParamFile(io: AwsIo, name: string, value: string): string {
  const m = /^fileb?:\/\/(.+)$/.exec(value);
  if (!m) return value;
  const text = io.readFile(resolvePath(io.cwd, m[1]));
  if (text === null) throw new CliError(`\nError parsing parameter '--${name}': Unable to load paramfile ${value}: [Errno 2] No such file or directory: '${m[1]}'`, 252);
  return text;
}

function parseJson(name: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`\nError parsing parameter '--${name}': Invalid JSON: ${(e as Error).message}\nJSON received: ${text}`, 252);
  }
}

function structured(name: string, text: string): unknown {
  const t = text.trim();
  if (t.startsWith('{') || (t.startsWith('[') && !/^\[\s*\{?\s*[\w.#:/@-]+=/.test(t))) return parseJson(name, t);
  try {
    return parseShorthand(t);
  } catch (e) {
    if (e instanceof ShorthandError) throw new CliError(`\n${e.message}`, 252);
    throw e;
  }
}

function convert(io: AwsIo, spec: ParamSpec, values: string[]): ParamValue {
  const vs = values.map((v) => readParamFile(io, spec.name, v));
  switch (spec.type) {
    case 'boolean':
      return true;
    case 'integer': {
      const n = Number(vs[0]);
      if (!/^-?\d+$/.test(vs[0].trim())) throw new CliError(`\nParameter validation failed:\nInvalid type for parameter ${pascal(spec.name)}, value: ${vs[0]}, type: <class 'str'>, valid types: <class 'int'>`, 252);
      return n;
    }
    case 'list': {
      if (spec.of === 'structure') return vs.flatMap((v) => [structured(spec.name, v)].flat()) as ParamValue;
      if (vs.length === 1 && vs[0].trim().startsWith('[')) {
        const arr = parseJson(spec.name, vs[0]);
        const bad = Array.isArray(arr) ? arr.findIndex((x) => x === null || typeof x === 'object') : -1;
        if (!Array.isArray(arr) || bad >= 0) throw new CliError(`\nParameter validation failed:\nInvalid type for parameter ${pascal(spec.name)}${bad >= 0 ? `[${bad}], value: ${JSON.stringify((arr as unknown[])[bad])}` : ''}, valid types: <class 'str'>`, 252);
        return arr.map(String);
      }
      return vs.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
    }
    case 'structure':
    case 'map':
      return structured(spec.name, vs[0]) as ParamValue;
    default:
      return vs[0];
  }
}

function parseParams(io: AwsIo, op: OperationSpec, rest: string[]): Record<string, ParamValue | undefined> {
  const known = new Map(op.params.map((p) => [p.name, p]));
  const positional = op.params.filter((p) => p.positional);
  const p: Record<string, ParamValue | undefined> = {};
  const unknown: string[] = [];
  let pos = 0;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const spec = known.get(name);
      if (!spec && name.startsWith('no-') && known.get(name.slice(3))?.type === 'boolean') {
        p[name.slice(3)] = false;
        continue;
      }
      if (!spec && PAGINATION.has(name)) {
        if (eq < 0 && i + 1 < rest.length && !rest[i + 1].startsWith('--')) i++;
        continue;
      }
      if (!spec || spec.positional) {
        unknown.push(a);
        while (i + 1 < rest.length && !rest[i + 1].startsWith('--')) unknown.push(rest[++i]);
        continue;
      }
      if (spec.type === 'boolean') {
        p[name] = true;
        continue;
      }
      const values: string[] = eq > 0 ? [a.slice(eq + 1)] : [];
      /* list は次のオプションまで全部、それ以外は 1 つだけ取る (後ろの値は位置引数: aws s3api get-object --key k out.csv) */
      while (eq < 0 && i + 1 < rest.length && !(rest[i + 1].startsWith('--') && rest[i + 1].length > 2) && (spec.type === 'list' || !values.length)) values.push(rest[++i]);
      if (!values.length) throw new CliError(`aws: error: argument --${name}: expected one argument`, 252, true);
      p[name] = convert(io, spec, values);
    } else if (pos < positional.length) {
      const spec = positional[pos++];
      p[spec.name] = convert(io, spec, [a]);
    } else unknown.push(a);
  }
  if (unknown.length) throw new CliError(`\nUnknown options: ${unknown.join(', ')}`, 252);
  const missing = op.params.filter((s) => s.required && p[s.name] === undefined);
  if (missing.length) throw new CliError(`aws: error: the following arguments are required: ${missing.map((s) => (s.positional ? s.name : `--${s.name}`)).join(', ')}`, 252, true);
  return p;
}

/* ---- ヘルプ ---- */
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(1, n - s.length));

function topHelp(): string {
  const names = serviceNames();
  return [
    'AWS CLI (学習用シミュレーター)',
    '',
    '使い方: aws [options] <command> <subcommand> [parameters]',
    '',
    'このシミュレーターで使えるサービス (command):',
    ...names.map((n) => `  ${pad(n, 22)}${SERVICES.get(n)!.desc}`),
    '',
    'グローバルオプション:',
    '  --region REGION        リージョン (既定は ~/.aws/config の region)',
    '  --output FORMAT        json | text | table | yaml',
    '  --query EXPRESSION     JMESPath で出力を絞り込む',
    '  --profile NAME         ~/.aws/config のプロファイル',
    '',
    '各サービスのサブコマンドは aws <command> help で見られます。',
    '',
  ].join('\n');
}

function serviceHelp(name: string): string {
  const s = SERVICES.get(name)!;
  const ops = [...s.ops.values()].sort((a, b) => a.name.localeCompare(b.name));
  return [`${name} — ${s.desc}`, '', 'このシミュレーターで使えるサブコマンド:', ...ops.map((o) => `  ${pad(o.name, 34)}${o.desc}`), '', '詳しくは aws ' + name + ' <subcommand> help', ''].join('\n');
}

function opHelp(service: string, op: OperationSpec): string {
  const sig = op.params.map((p) => {
    const v = p.positional ? `<${p.name}>` : p.type === 'boolean' ? `--${p.name} | --no-${p.name}` : `--${p.name} <value>`;
    return `          ${p.required ? v : `[${v}]`}`;
  });
  return [
    'NAME',
    `       ${op.name.replace(/^wait /, '')} -`,
    '',
    'DESCRIPTION',
    `       ${op.desc}`,
    '',
    'SYNOPSIS',
    `            ${op.name}`,
    ...sig,
    '',
    'OPTIONS',
    ...(op.params.length ? op.params.map((p) => `       ${p.positional ? `<${p.name}>` : `--${p.name}`} (${p.type === 'list' && p.of === 'structure' ? 'list (structure)' : p.type})${p.required ? ' [必須]' : ''}\n          ${p.desc ?? ''}`) : ['       None']),
    ...(op.examples?.length ? ['', 'EXAMPLES', ...op.examples.map((e) => `       ${e}`)] : []),
    '',
    `       (aws ${service} ${op.name} — シミュレーターが対応している範囲だけを載せています)`,
    '',
  ].join('\n');
}

/* ---- 実行 ---- */
/** 待機 (aws ... wait、curl のタイムアウト) の待ち方。テストは時計を進めるだけのものに差し替える */
export const timing = {
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new CliError('', 130));
      });
    }),
};

export async function runAws(args: string[], io: AwsIo): Promise<{ exitCode: number; call: AwsCall }> {
  const call: AwsCall = { ok: false };
  try {
    const code = await dispatch(args, io, call);
    call.ok = code === 0;
    return { exitCode: code, call };
  } catch (e) {
    if (e instanceof CliError) {
      if (e.message) io.stderr((e.usage ? USAGE + '\n' : '') + e.message + '\n');
      call.errorCode ??= e.exitCode === 252 ? 'ParamValidation' : undefined;
      return { exitCode: e.exitCode, call };
    }
    if (e instanceof ParamError) {
      io.stderr(`\n${e.message}\n`);
      call.errorCode = 'ParamValidation';
      return { exitCode: 252, call };
    }
    if (e instanceof AwsError) {
      /* ponytail: 構造 (--targets Id=...) の各キーの型を持っていないので、文字列のところに {...} や [{...}] を書かれると、
         オペレーションの String() が [object Object] にして API のエラーになる。ここでまとめて引数の誤り (252) にする。
         キーの型 (shape) を持つようになったら、parseParams で検証してこれを消す */
      if (e.message.includes('[object Object]')) {
        io.stderr(`\nParameter validation failed:\nInvalid type for parameter: 文字列を書くところに、構造 ({...} や [...]) が書かれています。aws ${call.command ?? ''} help で書き方を確かめてください\n`);
        call.errorCode = 'ParamValidation';
        return { exitCode: 252, call };
      }
      io.stderr(`\nAn error occurred (${e.code}) when calling the ${call.operation ?? 'Unknown'} operation: ${e.message}\n`);
      call.errorCode = e.code;
      return { exitCode: 254, call };
    }
    io.stderr(`\n${e instanceof Error ? e.message : String(e)}\n`);
    return { exitCode: 255, call };
  }
}

async function dispatch(args: string[], io: AwsIo, call: AwsCall): Promise<number> {
  const { globals, rest } = splitGlobals(args);
  if (globals.version) {
    io.stdout(CLI_VERSION + '\n');
    return 0;
  }
  const [serviceName, opName, ...more] = rest;
  if (!serviceName) throw new CliError('aws: error: the following arguments are required: command', 252, true);
  if (serviceName === 'help') {
    io.stdout(topHelp());
    return 0;
  }
  const svc = SERVICES.get(serviceName);
  if (!svc) throw new CliError(`aws: error: argument command: Invalid choice, valid choices are:\n\n${serviceNames().join(' | ')}\n\n(このシミュレーターで使えるものだけを挙げています。aws help で一覧を見られます)`, 252, true);
  if (!opName) throw new CliError('aws: error: the following arguments are required: operation', 252, true);
  if (opName === 'help') {
    io.stdout(serviceHelp(serviceName));
    return 0;
  }
  let fullName = opName;
  let params = more;
  if (opName === 'wait') {
    if (!more[0] || more[0] === 'help') {
      const waiters = [...svc.ops.keys()].filter((k) => k.startsWith('wait ')).map((k) => k.slice(5));
      if (more[0] === 'help') {
        io.stdout(`aws ${serviceName} wait — 状態が変わるまで待つ\n\n${waiters.map((w) => '  ' + w).join('\n')}\n`);
        return 0;
      }
      throw new CliError(`aws: error: the following arguments are required: waiter_name`, 252, true);
    }
    fullName = `wait ${more[0]}`;
    params = more.slice(1);
  }
  const op = svc.ops.get(fullName);
  if (!op) {
    const valid = [...svc.ops.keys()].filter((k) => !k.startsWith('wait ')).sort();
    throw new CliError(`aws: error: argument operation: Invalid choice, valid choices are:\n\n${valid.join(' | ')}\n\n(このシミュレーターで使えるものだけを挙げています。aws ${serviceName} help で一覧を見られます)`, 252, true);
  }
  if (params.length === 1 && params[0] === 'help') {
    io.stdout(opHelp(serviceName, op));
    return 0;
  }

  call.command = `${serviceName} ${fullName}`;
  call.service = serviceName;
  call.operation = op.api ?? pascal(fullName.replace(/^wait /, ''));
  call.query = globals.query;

  if (globals.endpointUrl) throw new CliError(`\nこのシミュレーターでは --endpoint-url は使えません (実際の AWS にも LocalStack にもつながっていません)`, 252);
  const profile = globals.profile ?? io.shellEnv.AWS_PROFILE ?? 'default';
  const conf = config(io, profile);
  const output = (globals.output ?? io.shellEnv.AWS_DEFAULT_OUTPUT ?? conf.output ?? 'json') as OutputFormat;
  if (!OUTPUT_FORMATS.includes(output)) throw new CliError(`aws: error: argument --output: Invalid choice, valid choices are:\n\njson | text | table | yaml | yaml-stream`, 252, true);
  call.output = output;

  const p = parseParams(io, op, params);
  call.params = p;
  call.profile = globals.profile ?? io.shellEnv.AWS_PROFILE;
  if (!op.local) {
    if (globals.profile && !readIni(io.readFile(`${HOME}/.aws/config`))[profile] && !readIni(io.readFile(`${HOME}/.aws/credentials`))[profile]) {
      throw new CliError(`\nThe config profile (${profile}) could not be found`, 255);
    }
    if (!hasCredentials(io, profile, conf)) throw new CliError(`\nUnable to locate credentials. You can configure credentials by running "aws configure".`, 253);
  }
  const region = globals.region ?? io.shellEnv.AWS_REGION ?? io.shellEnv.AWS_DEFAULT_REGION ?? conf.region;
  if (!region && !op.local && op.scope !== 'global') throw new CliError('\nYou must specify a region. You can also configure your region by running "aws configure".', 253);
  if (region && !REGIONS.some((r) => r.code === region) && op.scope !== 'global') throw new CliError(`\nCould not connect to the endpoint URL: "https://${serviceName}.${region}.amazonaws.com/"`, 255);
  call.region = region;

  const ctxFor = (env: AwsEnv): OpContext => ({
    env,
    region: region ?? '',
    profile,
    p,
    now: Date.now(),
    readLocal: (path) => io.readFile(resolvePath(io.cwd, path)),
    writeLocal: (path, content) => io.writeFile(resolvePath(io.cwd, path), content),
    shellEnv: io.shellEnv,
    terminal: { connect: io.connect },
  });
  /* リソースはレッスンのリージョンにしか無い。ほかのリージョンは空のアカウントに見える (コンソールでリージョンを切り替えたときと同じ) */
  const view = (env: AwsEnv) => (op.scope === 'global' || op.local || region === env.region ? env : { ...emptyEnv(region), accountId: env.accountId });

  if (!op.local) for (const authorize of AUTHORIZERS) authorize({ ctx: ctxFor(view(useConsole.getState().env)), service: serviceName, command: call.command, operation: call.operation, readOnly: !!op.readOnly, profileConfig: conf });

  if (op.waiter) {
    const { delayMs = 1000, maxAttempts = 60 } = op.waiter;
    for (let n = 1; ; n++) {
      useConsole.getState().tick();
      if (op.waiter.until(ctxFor(view(useConsole.getState().env)))) return 0;
      if (n >= maxAttempts) throw new CliError(`\nWaiter ${op.api ?? pascal(fullName.slice(5))} failed: Max attempts exceeded`, 255);
      await timing.sleep(delayMs, io.signal);
    }
  }

  let result: unknown;
  if (op.readOnly || op.local) result = op.run(ctxFor(view(useConsole.getState().env)));
  else {
    if (op.scope !== 'global' && region !== useConsole.getState().env.region)
      throw new AwsError('UnsupportedOperation', `(シミュレーター) このレッスンのリソースは ${useConsole.getState().env.region} にあります。ほかのリージョンには作成・変更できません。--region を確かめてください`);
    result = useConsole.getState().cli((d) => op.run(ctxFor(d)), call.command);
  }

  if (op.raw) {
    const r: RawResult = typeof result === 'string' ? { text: result } : ((result ?? { text: '' }) as RawResult);
    if (r.text) (r.exitCode ? io.stderr : io.stdout)(r.text.endsWith('\n') ? r.text : r.text + '\n');
    if (r.exitCode) call.errorCode = r.errorCode;
    return r.exitCode ?? 0;
  }
  if (result === undefined && !globals.query) return 0;
  let data = result ?? null;
  if (globals.query) {
    try {
      data = jmespath.search(data as Parameters<typeof jmespath.search>[0], globals.query);
    } catch (e) {
      /* jmespath.js の言い方を、本物 (Python の jmespath) に近づける。i-0abc のような値を引用符なしで書くと、- を数として読んで NaN と言う */
      /* jmespath.js 自身が落ちたとき (Key= のような書き方) は、構文の誤りとして扱う */
      const msg = e instanceof TypeError ? 'Bad jmespath expression: Invalid syntax' : (e as Error).message.replace(/^TypeError: /, '').replace(/^(Unexpected token type: Number, value: NaN|Invalid token \(Number\): "NaN")$/, "Bad jmespath expression: Unknown token '-'");
      throw new CliError(`\nBad value for --query ${globals.query}: ${msg}`, 252);
    }
  }
  io.stdout(format(data, output, call.operation));
  return 0;
}

function config(io: AwsIo, profile: string): Record<string, string> {
  return readIni(io.readFile(`${HOME}/.aws/config`))[profile] ?? {};
}

function hasCredentials(io: AwsIo, profile: string, conf: Record<string, string>): boolean {
  if (io.shellEnv.AWS_ACCESS_KEY_ID && io.shellEnv.AWS_SECRET_ACCESS_KEY) return true;
  if (conf.role_arn || conf.sso_session || conf.sso_start_url) return true;
  const c = readIni(io.readFile(`${HOME}/.aws/credentials`))[profile];
  return !!c?.aws_access_key_id && !!c?.aws_secret_access_key;
}

/* ---- Tab 補完 (aws_completer の代わり) ---- */
export function completeAws(words: string[], current: string): string[] {
  // words: aws より後ろの、確定した単語
  const positional = words.filter((w, i) => !w.startsWith('--') && !(i > 0 && /^--(region|output|query|profile)$/.test(words[i - 1])));
  const prev = words.at(-1);
  if (prev === '--output') return OUTPUT_FORMATS.filter((f) => f.startsWith(current));
  if (prev === '--region') return REGIONS.map((r) => r.code).filter((r) => r.startsWith(current));
  if (positional.length === 0) return [...serviceNames(), 'help'].filter((s) => s.startsWith(current));
  const svc = SERVICES.get(positional[0]);
  if (!svc) return [];
  if (positional.length === 1) return [...new Set([...svc.ops.keys()].map((k) => (k.startsWith('wait ') ? 'wait' : k))), 'help'].filter((s) => s.startsWith(current)).sort();
  if (positional[1] === 'wait' && positional.length === 2) return [...svc.ops.keys()].filter((k) => k.startsWith('wait ')).map((k) => k.slice(5)).filter((s) => s.startsWith(current));
  const op = svc.ops.get(positional[1] === 'wait' ? `wait ${positional[2]}` : positional[1]);
  if (!op || !current.startsWith('-')) return [];
  const used = new Set(words.filter((w) => w.startsWith('--')).map((w) => w.slice(2)));
  return [...op.params.filter((p) => !p.positional && !used.has(p.name)).map((p) => `--${p.name}`), '--query', '--output', '--region'].filter((s) => s.startsWith(current));
}
