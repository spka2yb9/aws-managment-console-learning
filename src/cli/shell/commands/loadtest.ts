/* 負荷テストの道具 (学習者の PC のコマンド)
   hey   … HTTP の負荷発生ツール (https://github.com/rakyll/hey) のふり。-c 並列 × -q 回/秒 の負荷を -z の時間だけ ALB にかける。
           本物は終わるまで戻らないが、ここではシミュレーターの負荷発生ツール (「負荷テスト」タブと同じ env.traffic) に任せてすぐ戻る
   pkill … pkill hey で負荷を止める */
import { useConsole } from '../../../console/store';
import { setTraffic } from '../../../sim/autoscaling';
import { simulateHttp } from '../../../sim/http';
import type { AwsEnv } from '../../../sim/types';
import type { CommandContext } from '../lifo';

const DIM = '\x1b[2m';
const R = '\x1b[0m';

const HEY_USAGE = `Usage: hey [options...] <url>

Options:
  -n  Number of requests to run. Default is 200.
  -c  Number of workers to run concurrently. Default is 50.
  -q  Rate limit, in queries per second (QPS) per worker.
  -z  Duration of application to send requests. When duration is reached,
      application stops and exits. If duration is specified, n is ignored.
      Examples: -z 10s -z 3m.
${DIM}(シミュレーター) 1 秒あたりのリクエスト数は -c × -q です。例: hey -z 10m -c 50 -q 20 http://<ALB の DNS 名>/  (1000 req/s を 10 分)${R}
`;
const VALUE_FLAGS = new Set(['n', 'c', 'q', 'z', 'm', 't', 'o', 'A', 'H', 'd', 'D', 'T', 'a', 'x', 'cpus']);
const BOOL_FLAGS = new Set(['h2', 'disable-compression', 'disable-keepalive', 'disable-redirects']);

/** Go の time.ParseDuration の形 (10s、3m、1m30s、1h) をミリ秒に。NaN なら不正 */
function duration(s: string): number {
  if (!/^(\d+(\.\d+)?(ms|s|m|h))+$/.test(s)) return NaN;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return [...s.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)].reduce((a, m) => a + Number(m[1]) * unit[m[2]], 0);
}

/** いま効いている負荷 (req/s)。undefined = ふだんのアクセス */
const currentLoad = (env: AwsEnv, now = Date.now()) => [...(env.traffic ?? [])].reverse().find((x) => x.at <= now)?.rps;

async function hey(ctx: CommandContext): Promise<number> {
  const flags: Record<string, string> = {};
  let url = '';
  const a = ctx.args;
  for (let i = 0; i < a.length; i++) {
    const m = /^--?([\w-]+)(?:=(.*))?$/.exec(a[i]);
    if (!m) {
      url = a[i];
      continue;
    }
    if (BOOL_FLAGS.has(m[1])) continue;
    if (!VALUE_FLAGS.has(m[1]) || (m[2] === undefined && i + 1 >= a.length)) {
      ctx.stderr.write(`${VALUE_FLAGS.has(m[1]) ? `flag needs an argument: -${m[1]}` : `flag provided but not defined: -${m[1]}`}\n${HEY_USAGE}`);
      return 2;
    }
    flags[m[1]] = m[2] ?? a[++i];
  }
  if (!url) {
    ctx.stderr.write(HEY_USAGE);
    return 1;
  }
  const n = Number(flags.n ?? 200);
  const c = Number(flags.c ?? 50);
  const q = Number(flags.q ?? 0);
  const z = flags.z === undefined ? undefined : duration(flags.z);
  if (z !== undefined && Number.isNaN(z)) {
    ctx.stderr.write(`invalid value "${flags.z}" for flag -z: parse error\n${HEY_USAGE}`);
    return 2;
  }
  if (!(c > 0) || !Number.isInteger(c) || !(n > 0)) {
    ctx.stderr.write(`-n and -c cannot be smaller than 1.\n${HEY_USAGE}`);
    return 1;
  }
  if (!(q > 0)) {
    ctx.stderr.write(`${DIM}(シミュレーター) -q (1 並列あたりの 1 秒の回数) を指定してください。1 秒あたりのリクエスト数は -c × -q です${R}\n`);
    return 1;
  }
  let host = '';
  try {
    host = new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`).hostname.toLowerCase();
  } catch {
    /* host のまま空 */
  }
  const { env } = useConsole.getState();
  if (!env.loadBalancers.some((lb) => lb.dnsName.toLowerCase() === host)) {
    if (!host || simulateHttp(env, url).error === 'ERR_NAME_NOT_RESOLVED') ctx.stderr.write(`Get "${url}": dial tcp: lookup ${host || url}: no such host\n`);
    else ctx.stderr.write(`${DIM}(シミュレーター) 負荷をかけられるのは ALB の DNS 名だけです (aws elbv2 describe-load-balancers の DNSName)${R}\n`);
    return 1;
  }
  const rps = c * q;
  const ms = z ?? Math.round((n / rps) * 1000);
  const now = Date.now();
  useConsole.getState().run((d) => {
    setTraffic(d, rps, now);
    setTraffic(d, undefined, now + ms);
  });
  const shown = z !== undefined ? flags.z : `${(ms / 1000).toFixed(1)}s (${n} requests)`;
  ctx.stdout.write(`${rps} req/s (${c} workers × ${q} req/s) で ${url} への負荷を ${shown} かけ始めました。\n`);
  ctx.stdout.write(`${DIM}(シミュレーター) 本物の hey は終わるまで戻りませんが、この hey は負荷をシミュレーターに任せてすぐ戻ります。止めるときは pkill hey、強さを変えるときは hey を打ち直します${R}\n`);
  return 0;
}

async function pkill(ctx: CommandContext): Promise<number> {
  const name = ctx.args.filter((x) => !x.startsWith('-')).pop();
  if (!name) {
    ctx.stderr.write('pkill: no matching criteria specified\nTry `pkill --help\' for more information.\n');
    return 2;
  }
  if (name !== 'hey' || currentLoad(useConsole.getState().env) === undefined) return 1;
  useConsole.getState().run((d) => setTraffic(d, undefined, Date.now()));
  return 0;
}

export default { hey, pkill };
