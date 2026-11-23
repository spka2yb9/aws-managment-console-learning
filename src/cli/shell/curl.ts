/* curl — コンソール版の「ブラウザ」タブの代わり。実際のネットワークには出ず、sim/http.ts の simulateHttp に聞く。
   結果は useConsole.browse が ctx.browser に残すので、コンソール版と同じ判定 (lastAlbRequest など) がそのまま使える。
   -v を付けると、シミュレーターが経路のどこで止まったかを * の行で教える (本物の curl には無い、学習用のおまけ) */
import { useConsole } from '../../console/store';
import { CURL_CLIENT, type HttpResult } from '../../sim/http';
import { CLIENT_IP } from '../../sim/network';
import type { CommandContext } from './lifo';
import { resolvePath, timing } from '../aws/aws';

export async function curl(ctx: CommandContext, write: (abs: string, body: string) => void): Promise<number> {
  let printed = '';
  const out = ctx.stdout;
  const err = ctx.stderr;
  const tee = (w: typeof out) => ({ ...w, write: (s: string) => { printed += s; w.write(s); } });
  const code = await run({ ...ctx, stdout: tee(out), stderr: tee(err) }, write);
  // 演習が「curl で〜を見たか」を判定できるように、打った curl も記録する (結果は useConsole.browse が ctx.browser にも残す)
  useConsole.getState().recordCommand({ instanceId: '', line: ['curl', ...ctx.args].join(' '), output: printed.slice(0, 4000), ok: code === 0, at: Date.now() });
  return code;
}

async function run(ctx: CommandContext, write: (abs: string, body: string) => void): Promise<number> {
  const o = { include: false, head: false, verbose: false, silent: false, showError: false, fail: false, out: '', writeOut: '', maxTime: 0 };
  let url = '';
  const a = ctx.args;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === '-o' || x === '--output') o.out = a[++i] ?? '';
    else if (x === '-w' || x === '--write-out') o.writeOut = a[++i] ?? '';
    else if (x === '-m' || x === '--max-time' || x === '--connect-timeout') o.maxTime = Number(a[++i]) || 0;
    else if (x === '-H' || x === '--header' || x === '-X' || x === '--request' || x === '-d' || x === '--data' || x === '-A' || x === '--user-agent' || x === '-u') i++;
    else if (x === '--include') o.include = true;
    else if (x === '--head') o.head = true;
    else if (x === '--verbose') o.verbose = true;
    else if (x === '--silent') o.silent = true;
    else if (x === '--fail') o.fail = true;
    else if (/^-[a-zA-Z]+$/.test(x)) {
      for (const f of x.slice(1)) {
        if (f === 'i') o.include = true;
        else if (f === 'I') o.head = true;
        else if (f === 'v') o.verbose = true;
        else if (f === 's') o.silent = true;
        else if (f === 'S') o.showError = true;
        else if (f === 'f') o.fail = true;
      }
    } else if (!x.startsWith('-')) url = x;
  }
  if (!url) {
    ctx.stderr.write("curl: try 'curl --help' or 'curl --manual' for more information\n");
    return 2;
  }
  /* 自分の PC のグローバル IP を調べる定番 (セキュリティグループの「マイ IP」に使う)。シミュレーターの学習者の IP を返す */
  if (/^(https?:\/\/)?checkip\.amazonaws\.com\/?$/.test(url)) {
    ctx.stdout.write(`${CLIENT_IP}\n`);
    return 0;
  }
  const r = useConsole.getState().browse(url, CURL_CLIENT);
  let host = url;
  let port = 80;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`);
    host = u.hostname;
    port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    /* ERR_INVALID_URL */
  }
  if (o.verbose) ctx.stderr.write(trace(r));
  const err = (code: number, msg: string) => {
    if (!o.silent || o.showError) ctx.stderr.write(`curl: (${code}) ${msg}\n`);
    if (o.writeOut) ctx.stdout.write(writeOut(o.writeOut, '000'));
    return code;
  };
  switch (r.error) {
    case 'ERR_INVALID_URL':
      return err(3, 'URL rejected: Malformed input to a URL function');
    case 'ERR_NAME_NOT_RESOLVED':
      return err(6, `Could not resolve host: ${host}`);
    case 'ERR_CONNECTION_TIMED_OUT': {
      /* 本物はもっと待つ。教材なので数秒で切り上げる */
      const wait = Math.min(3000, (o.maxTime || 3) * 1000);
      await timing.sleep(wait, ctx.signal).catch(() => {});
      return err(28, `Failed to connect to ${host} port ${port} after ${wait + 2} ms: Timeout was reached`);
    }
    case 'ERR_CONNECTION_REFUSED':
      return err(7, `Failed to connect to ${host} port ${port} after 3 ms: Couldn't connect to server`);
    case 'ERR_SSL_PROTOCOL_ERROR':
      return err(35, 'OpenSSL/3.0.2: error:0A00010B:SSL routines::wrong version number');
    case 'ERR_CERT_COMMON_NAME_INVALID':
      return err(60, `SSL: no alternative certificate subject name matches target host name '${host}'\nMore details here: https://curl.se/docs/sslcerts.html\n\ncurl failed to verify the legitimacy of the server and therefore could not\nestablish a secure connection to it.`);
  }
  const status = r.status ?? 0;
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(new TextEncoder().encode(r.body).length), Connection: 'keep-alive', ...(status >= 500 ? { Server: 'awselb/2.0' } : {}), ...(r.headers ?? {}) };
  const head = `HTTP/1.1 ${status} ${r.statusText ?? ''}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`;
  if (o.fail && status >= 400) return err(22, `The requested URL returned error: ${status}`);
  let text = o.head ? head : (o.include ? head : '') + r.body + (r.body.endsWith('\n') || !r.body ? '' : '\n');
  if (o.out && o.out !== '-') {
    write(resolvePath(ctx.cwd, o.out), r.body);
    text = o.head || o.include ? head : '';
  }
  ctx.stdout.write(text.replace(/\r\n/g, '\n'));
  if (o.writeOut) ctx.stdout.write(writeOut(o.writeOut, String(status)));
  return 0;
}

const writeOut = (fmt: string, code: string) => fmt.replace(/%\{http_code\}/g, code).replace(/%\{response_code\}/g, code).replace(/\\n/g, '\n');

/* -v: 経路の確認結果 (コンソール版のブラウザタブの「経路」と同じもの) */
function trace(r: HttpResult): string {
  const lines = [`*   (シミュレーター) ${r.url} までの経路:`];
  for (const h of r.hops) {
    lines.push(`* ${h.ok ? '✔' : '✘'} ${h.hop}`);
    for (const c of h.checks) lines.push(`*     ${c.ok ? '✔' : '✘'} ${c.label}: ${c.detail}`);
  }
  return lines.join('\n') + '\n';
}
