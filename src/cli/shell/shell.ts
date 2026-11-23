/* CliShell — CLI 版の端末の中身 (TerminalController はこのクラスしか知らない)
   ------------------------------------------------------------------
     学習者の PC (learner@my-pc) … Lifo のシェル。aws / curl はシミュレーターにつながる自前のコマンド
     EC2 のインスタンスの中        … aws ec2-instance-connect ssh で入る。1 行ずつ sim/cli.ts の execCli で動かす (コンソール版の EC2 Instance Connect と同じもの)
     Session Manager のセッション   … aws ssm start-session で入る。sim/ext/ssm.ts の sessionCommand (ssm-user のシェル、設定があればログに残る)
   コマンドが終わるたびに onCommand に知らせる (演習の自動判定に使う) */
import { instanceFiles, useConsole } from '../../console/store';
import { prompt as instancePrompt } from '../../sim/cli';
import { mutate } from '../../sim/env';
import { exitSession, sessionCommand, sessionOf, SSM_PROMPT, terminatedMessage } from '../../sim/ext/ssm';
import { completeAws, HOME, runAws } from '../aws/aws';
import { curl } from './curl';
import { Lifo, type CommandContext, type RunOptions, type RunResult } from './lifo';

/* 学習者の PC のコマンドを足すときは commands/*.ts に書く (default で { コマンド名: 関数 } を返す)。dig など */
export type ShellCommand = (ctx: CommandContext) => Promise<number>;
const extra = import.meta.glob<{ default: Record<string, ShellCommand> }>('./commands/*.ts', { eager: true });

export type { RunResult };

export interface Completion {
  start: number;
  end: number;
  items: string[];
  labels: string[];
  common: string;
}

/* 最初から置いておく設定 (aws configure 済みの PC)。アクセスキーは AWS のドキュメントの例と同じ形の偽物 */
export const AWS_CONFIG = '[default]\nregion = ap-northeast-1\noutput = json\n';
export const AWS_CREDENTIALS = '[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n';

const DIM = '\x1b[2m';
const R = '\x1b[0m';
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const MAX_RECORD = 4000;

/* Lifo のエラーの書き方 (cat: x: ENOENT: 'x': no such …) を bash にそろえる */
const tidy = (s: string) =>
  s
    .replace(/^(ENOENT|EISDIR|ENOTDIR|EEXIST|EACCES): '([^'\n]*)': ([a-z])/gm, (_, __, p: string, c: string) => `bash: ${p}: ${c.toUpperCase()}`)
    .replace(/^([\w.-]+): (?:ENOENT|EISDIR|ENOTDIR|EEXIST|EACCES): '([^'\n]*)': ([a-z])/gm, (_, cmd: string, p: string, c: string) => `${cmd}: ${p}: ${c.toUpperCase()}`)
    .replace(/\b(?:ENOENT|EISDIR|ENOTDIR|EEXIST|EACCES): '[^'\n]*': ([a-z])/g, (_, c: string) => c.toUpperCase());

/* 閉じていない引用符。bash なら続きの行を待つが、この端末は 1 行ずつなので知らせて止める (JSON を '...' で囲むときに起きやすい) */
function syntaxError(line: string): string | null {
  let quoteCh = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoteCh) {
      if (c === quoteCh) quoteCh = '';
      else if (c === '\\' && quoteCh === '"') i++;
    } else if (c === '\\') i++;
    else if (c === '"' || c === "'") quoteCh = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
  }
  if (quoteCh) return `bash: unexpected EOF while looking for matching \`${quoteCh}'\n${DIM}(この端末では、コマンドを 1 行で書きます。引用符を閉じ忘れていないか確かめてください)${R}`;
  if (/<<-?\s*['"]?\w+['"]?\s*$/.test(line)) return `${DIM}(この端末はヒアドキュメント (<<EOF) に対応していません。ファイルは echo '...' > file.json や printf で作ってください)${R}`;
  return null;
}

export class CliShell {
  readonly lifo = new Lifo();
  /** EC2 Instance Connect で入っているインスタンス */
  private remote: string | null = null;
  /** aws ssm start-session で入っている Session Manager のセッション ID */
  private ssmSession: string | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;

  async reset(files: Record<string, string> = {}): Promise<void> {
    this.generation++;
    this.remote = null;
    this.ssmSession = null;
    await this.lifo.reset({
      home: HOME,
      env: { HOME, USER: 'learner', LOGNAME: 'learner', SHELL: '/bin/bash', PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8', HOSTNAME: 'my-pc', AWS_PAGER: '' },
      files: {},
    });
    this.lifo.writeFile(`${HOME}/.aws/config`, AWS_CONFIG);
    this.lifo.writeFile(`${HOME}/.aws/credentials`, AWS_CREDENTIALS);
    for (const [name, body] of Object.entries(files)) this.lifo.writeFile(`${HOME}/${name}`, body);
    this.lifo.define('aws', (ctx) => this.aws(ctx));
    this.lifo.define('curl', (ctx) => curl(ctx, (abs, body) => this.lifo.writeFile(abs, body)));
    for (const mod of Object.values(extra)) for (const [name, fn] of Object.entries(mod.default ?? {})) this.lifo.define(name, fn);
    this.lifo.define('ssh', async (ctx) => {
      ctx.stderr.write(`${DIM}(シミュレーター) このレッスンでは、インスタンスには EC2 Instance Connect で入ります:\n  aws ec2-instance-connect ssh --instance-id <インスタンス ID>${R}\n`);
      return 255;
    });
  }

  destroy(): void {
    this.generation++;
    this.lifo.destroy();
  }

  /** 学習者が打ったコマンド。終わったら onCommand へ知らせる */
  async execute(line: string, opts: RunOptions = {}): Promise<RunResult> {
    const generation = this.generation;
    const result = await this.run(line, opts);
    if (generation === this.generation) this.listeners.forEach((fn) => fn());
    return result;
  }

  /** 判定に知らせない実行 (テストや模範解答の再生) */
  async run(line: string, opts: RunOptions = {}): Promise<RunResult> {
    const command = line.trim();
    if (!command) return { stdout: '', stderr: '', exitCode: 0 };
    if (this.ssmSession) return this.runSession(this.ssmSession, command);
    if (this.remote) return this.runRemote(command);
    if (/^(exit|logout)$/.test(command)) return { stdout: '', stderr: `${DIM}[学習環境] ここからはログアウトできません。やり直すときは「最初からやり直す」を使ってください。${R}\n`, exitCode: 1 };
    const syntax = syntaxError(command);
    if (syntax) return { stdout: '', stderr: syntax + '\n', exitCode: 2 };
    try {
      const res = await this.lifo.run(command, { onStdout: opts.onStdout, onStderr: opts.onStderr && ((d) => opts.onStderr!(tidy(d))) });
      return { ...res, stderr: tidy(res.stderr) };
    } catch (e) {
      return { stdout: '', stderr: `${e instanceof Error ? e.message : String(e)}\n`, exitCode: 1 };
    }
  }

  private runRemote(command: string): RunResult {
    const id = this.remote!;
    if (/^(exit|logout)$/.test(command)) {
      const ip = useConsole.getState().env.instances.find((i) => i.instanceId === id)?.publicIpAddress ?? id;
      this.remote = null;
      const output = `logout\nConnection to ${ip} closed.`;
      // 演習が「PC に戻ったか」を判定できるように、インスタンスの記録として残す
      useConsole.getState().recordCommand({ instanceId: id, line: command, output, ok: true, at: Date.now() });
      return { stdout: output + '\n', stderr: '', exitCode: 0 };
    }
    const rec = useConsole.getState().runCommand(id, command);
    const out = rec.output ? rec.output + '\n' : '';
    return rec.ok ? { stdout: out, stderr: '', exitCode: 0 } : { stdout: '', stderr: out, exitCode: 1 };
  }

  /** Session Manager のセッションの中の 1 行。exit は EC2 Instance Connect と同じく記録する (演習が PC に戻ったかを判定できるように) */
  private runSession(sessionId: string, command: string): RunResult {
    const s = useConsole.getState();
    const target = sessionOf(s.env, sessionId)?.target ?? '';
    if (/^(exit|logout)$/.test(command)) {
      this.ssmSession = null;
      const output = `\n\nExiting session with sessionId: ${sessionId}.\n`;
      s.run((d) => exitSession(d, sessionId, Date.now()));
      s.recordCommand({ instanceId: target, line: command, output, ok: true, at: Date.now() });
      return { stdout: output + '\n', stderr: '', exitCode: 0 };
    }
    const [env, r] = mutate(s.env, (d) => sessionCommand(d, sessionId, command, instanceFiles(s.commands, target), Date.now()));
    if (sessionOf(env, sessionId)?.status !== 'Connected') {
      // 別の場所で終了された (terminate-session、インスタンスの停止): PC に戻る
      this.ssmSession = null;
      return { stdout: '', stderr: `\n${terminatedMessage(sessionId)}\n`, exitCode: 1 };
    }
    const rec = { instanceId: target, line: command, at: Date.now(), ...r };
    useConsole.setState({ env, commands: [...s.commands, rec].slice(-200) });
    const out = r.output ? r.output + '\n' : '';
    return r.ok ? { stdout: out, stderr: '', exitCode: 0 } : { stdout: '', stderr: out, exitCode: 1 };
  }

  /** aws ec2-instance-connect ssh はインスタンス ID、aws ssm start-session はセッション ID (learner-0a1b…) を渡す */
  connect(target: string): void {
    if (target.startsWith('i-')) this.remote = target;
    else this.ssmSession = target;
  }

  get instance(): string | null {
    return this.remote;
  }

  onCommand(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  cancel(): void {
    this.lifo.cancel();
  }

  private async aws(ctx: CommandContext): Promise<number> {
    let printed = '';
    const { exitCode, call } = await runAws(ctx.args, {
      stdout: (s) => {
        printed += s;
        ctx.stdout.write(s);
      },
      stderr: (s) => {
        printed += s;
        ctx.stderr.write(s);
      },
      shellEnv: ctx.env,
      cwd: ctx.cwd,
      readFile: (abs) => this.lifo.readFile(abs),
      writeFile: (abs, body) => this.lifo.writeFile(abs, body),
      signal: ctx.signal,
      connect: (id) => this.connect(id),
    });
    const s = useConsole.getState();
    s.recordCommand({
      instanceId: '',
      line: ['aws', ...ctx.args].map(quote).join(' '),
      output: printed.length > MAX_RECORD ? printed.slice(0, MAX_RECORD) + '\n…' : printed,
      ok: exitCode === 0,
      operation: call.operation,
      errorCode: call.errorCode,
      at: Date.now(),
      command: call.command,
      service: call.service,
      params: call.params,
      query: call.query,
      format: call.output,
      region: call.region,
      profile: call.profile,
    });
    return exitCode;
  }

  /* ---- Tab 補完。aws の後ろはサービス・サブコマンド・オプション、それ以外はコマンド名とファイル名 ---- */
  async complete(line: string, cursor: number): Promise<Completion> {
    const head = line.slice(0, cursor);
    const word = /(\S*)$/.exec(head)![1];
    const start = cursor - word.length;
    const done = (list: string[], labels = list): Completion => {
      const items = [...new Set(list)].sort();
      return { start, end: cursor, items, labels: [...new Set(labels)].sort(), common: commonPrefix(items) };
    };
    if (this.remote || this.ssmSession) return done([]);
    const segment = head.slice(0, start).split(/\||;|&&|\|\||\$\(/).at(-1)!.trim();
    const words = segment ? segment.split(/\s+/) : [];
    if (words[0] === 'aws') return done(completeAws(words.slice(1), word));
    if (!words.length && !word.includes('/')) return done(this.lifo.commandNames().filter((n) => n.startsWith(word)));
    const slash = word.lastIndexOf('/');
    const dirPart = slash < 0 ? '' : word.slice(0, slash + 1);
    const prefix = slash < 0 ? word : word.slice(slash + 1);
    const base = dirPart.startsWith('/') ? dirPart : `${this.lifo.cwd}/${dirPart.replace(/^~\//, HOME.slice(this.lifo.cwd.length) + '/')}`;
    const entries = await this.lifo.readdir(dirPart.startsWith('~/') ? HOME + dirPart.slice(1) : base || '.');
    const hits = entries.filter((e) => e.name.startsWith(prefix) && (prefix.startsWith('.') || !e.name.startsWith('.')));
    const suffix = (e: { name: string; type: string }) => e.name + (e.type === 'directory' ? '/' : '');
    return done(
      hits.map((e) => dirPart + suffix(e)),
      hits.map(suffix),
    );
  }

  promptText(): string {
    if (this.ssmSession) return `${SSM_PROMPT} `;
    const i = this.remote && useConsole.getState().env.instances.find((x) => x.instanceId === this.remote);
    if (i) return instancePrompt(i) + ' ';
    return `learner@my-pc:${this.shortCwd()}$ `;
  }

  promptAnsi(): string {
    if (this.ssmSession) return `${SSM_PROMPT} `;
    const i = this.remote && useConsole.getState().env.instances.find((x) => x.instanceId === this.remote);
    if (i) return `\x1b[1;33m${instancePrompt(i)}\x1b[0m `;
    return `\x1b[1;32mlearner@my-pc\x1b[0m:\x1b[1;34m${this.shortCwd()}\x1b[0m$ `;
  }

  private shortCwd(): string {
    const cwd = this.lifo.cwd;
    if (cwd === HOME) return '~';
    return cwd.startsWith(HOME + '/') ? '~' + cwd.slice(HOME.length) : cwd;
  }
}

function commonPrefix(list: string[]): string {
  if (!list.length) return '';
  let p = list[0];
  for (const s of list.slice(1)) while (p && !s.startsWith(p)) p = p.slice(0, -1);
  return p;
}
