/* Lifo（ブラウザ内の仮想シェル）に触れてよい場所。linux-learning の lifoAdapter.ts から、CLI 版で要るものだけを移植した。
   ユーザーや権限、ジョブ制御は要らないので持ってこない。Lifo の非公開メンバに触るのはここだけ。 */
import { Sandbox, type Command, type CommandContext } from '@lifo-sh/core';

export type { Command, CommandContext };

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

/* Lifo の同梱コマンドのうち、実際のネットワークに出るもの・教材に関係ないもの。名前ごと消す（curl などは自前のものを入れ直す） */
const REMOVE = ['curl', 'wget', 'dig', 'host', 'ping', 'ifconfig', 'ip', 'netstat', 'route', 'tunnel', 'forward', 'ports', 'lifo', 'browser-metro', 'node', 'npm', 'npx', 'newtab', 'pkg', 'systemctl', 'top', 'watch', 'sl', 'help', 'logout'];
const BUILTINS = ['cd', 'pwd', 'echo', 'export', 'unset', 'alias', 'history', 'source', 'clear', 'exit', 'test', 'type', 'set'];

interface ShellInternals {
  interpreter: object;
  abortController: AbortController | null;
}

export class Lifo {
  private sb: Sandbox | null = null;
  private abort: AbortController | null = null;

  async reset(opts: { home: string; env: Record<string, string>; files: Record<string, string> }): Promise<void> {
    this.destroy();
    const sb = await Sandbox.create({ cwd: '/', env: opts.env, persist: false, files: {} });
    this.sb = sb;
    patchInterpreter((sb.shell as unknown as ShellInternals).interpreter);
    await sb.fs.rm('/home/user', { recursive: true }).catch(() => {});
    await sb.fs.mkdir(opts.home, { recursive: true });
    for (const [name, body] of Object.entries(opts.files)) await sb.fs.writeFile(`${opts.home}/${name}`, body);
    for (const n of REMOVE) sb.shell.getRegistry().unregister(n);
    sb.cwd = opts.home;
  }

  destroy(): void {
    this.cancel();
    this.sb?.destroy();
    this.sb = null;
  }

  /* Lifo は RunOptions.signal をコマンドへ渡さない。コマンドが見ている shell.abortController を毎回差し替え、Ctrl+C はそれを abort する */
  async run(line: string, opts: RunOptions = {}): Promise<RunResult> {
    const ac = new AbortController();
    this.abort = ac;
    (this.box.shell as unknown as ShellInternals).abortController = ac;
    try {
      return await this.box.shell.execute(line, { onStdout: opts.onStdout, onStderr: opts.onStderr });
    } finally {
      if (this.abort === ac) this.abort = null;
    }
  }

  cancel(): void {
    this.abort?.abort();
  }

  define(name: string, fn: Command): void {
    this.box.commands.register(name, fn);
  }

  get cwd(): string {
    return this.sb ? this.sb.cwd : '/';
  }

  env(): Record<string, string> {
    return this.box.shell.getEnv();
  }

  commandNames(): string[] {
    if (!this.sb) return [];
    return [...new Set([...this.sb.shell.getRegistry().list(), ...BUILTINS])].sort();
  }

  async readdir(path: string): Promise<Array<{ name: string; type: 'file' | 'directory' }>> {
    try {
      return await this.box.fs.readdir(path);
    } catch {
      return [];
    }
  }

  readFile(path: string): string | null {
    try {
      return this.box.shell.getVfs().readFileString(path);
    } catch {
      return null;
    }
  }

  writeFile(path: string, content: string): void {
    const vfs = this.box.shell.getVfs();
    vfs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true });
    vfs.writeFile(path, content);
  }

  private get box(): Sandbox {
    if (!this.sb) throw new Error('Lifo: reset() の前に呼ばれました');
    return this.sb;
  }
}

/* ---- Lifo 0.10.18 の不具合の修正（linux-learning の lifoAdapter.ts と同じもの） ----
   for / while / if / { } の中のコマンドは、出力先を受け取っているのに捨てていて、何も出てこない
   （Interpreter.executeCompoundList が executeList に streams を渡していない）。executeLine が受け取った streams を覚えておき、中へ渡し直す。
   あわせて、ループの途中で Ctrl+C が効くよう各コマンドの前に abort を確かめる。 */
type Stream = { write(s: string): void };
type Streams = { stdout?: Stream; stderr?: Stream };
type Word = Array<{ text: string; quoted: 'none' | 'single' | 'double' }>;
interface Compound {
  type: string;
  redirections?: Array<{ operator: string; target: Word }>;
  words?: Word[] | null;
  body?: unknown[];
  condition?: unknown[];
  elseBody?: unknown[] | null;
  clauses?: Array<{ condition: unknown[]; body: unknown[] }>;
  items?: Array<{ body: unknown[] }>;
}
interface InterpreterProto {
  executeLine(this: InterpreterSelf, ...args: unknown[]): Promise<number>;
  executeList(this: InterpreterSelf, item: unknown, stdin: unknown, streams?: Streams): Promise<number>;
  executeCompoundList(this: InterpreterSelf, list: unknown[], stdout?: unknown): Promise<number>;
  executeCommand(this: InterpreterSelf, node: Compound, stdin: unknown, stdout: unknown, term: unknown, stderr: unknown, streams?: Streams): Promise<number>;
  executeFor(this: InterpreterSelf, node: Compound, stdout: unknown): Promise<number>;
  executeFunction(this: InterpreterSelf, body: unknown, args: string[]): Promise<number>;
  createExpandContext(this: InterpreterSelf): object;
  createFileAppender(this: InterpreterSelf, path: string): Stream;
  createFileWriter(this: InterpreterSelf, path: string): Stream;
  createFileReader(this: InterpreterSelf, path: string): unknown;
  __expandWord(this: InterpreterSelf, word: Word): Promise<string>;
}
interface InterpreterSelf extends InterpreterProto {
  _streams?: Streams;
  __argv?: string[][];
  __io?: WeakMap<object, { stdin: unknown; stderr?: Stream }>;
  config: {
    getAbortSignal?: () => AbortSignal;
    getCwd(): string;
    vfs: { writeFile(p: string, c: string): void; exists(p: string): boolean };
  };
}

const listsOf = (n: Compound): unknown[][] => [
  ...(n.clauses ?? []).flatMap((c) => [c.condition, c.body]),
  ...(n.items ?? []).map((i) => i.body),
  ...[n.condition, n.body, n.elseBody].filter((l): l is unknown[] => !!l),
];
const joinPath = (cwd: string, p: string) => {
  const out: string[] = [];
  for (const s of (p.startsWith('/') ? p : `${cwd}/${p}`).split('/')) {
    if (s === '..') out.pop();
    else if (s && s !== '.') out.push(s);
  }
  return '/' + out.join('/');
};

const patched = new WeakSet<object>();
let ticks = 0;
const breathe = () => new Promise((r) => setTimeout(r, 0));
/* Ctrl+C で止めたときに投げる。Error ではないので、executeLine は何も書かずに受け止める */
const INTERRUPT = { interrupted: true };

function patchInterpreter(interpreter: object): void {
  const proto = Object.getPrototypeOf(interpreter) as InterpreterProto;
  if (patched.has(proto) || typeof proto.executeCompoundList !== 'function') return;
  patched.add(proto);

  const executeLine = proto.executeLine;
  proto.executeLine = async function (...args) {
    const prev = this._streams;
    this._streams = args[2] as Streams | undefined;
    try {
      const code = await executeLine.apply(this, args);
      return code === 2 && this.config.getAbortSignal?.().aborted ? 130 : code;
    } finally {
      this._streams = prev;
    }
  };

  proto.executeCompoundList = async function (list, stdout) {
    const io = this.__io?.get(list);
    let streams = stdout ? { ...this._streams, stdout: stdout as Stream } : this._streams;
    if (io?.stderr) streams = { ...streams, stderr: io.stderr };
    let code = 0;
    if (++ticks % 256 === 0) await breathe();
    for (const item of list) {
      if (this.config.getAbortSignal?.().aborted) throw INTERRUPT;
      code = await this.executeList(item, io?.stdin, streams);
    }
    return code;
  };

  /* if / for / while / { } に付いたリダイレクト（done > out.txt）と、パイプから来た入力を中へ渡す */
  const executeCommand = proto.executeCommand;
  proto.executeCommand = async function (node, stdin, stdout, term, stderr, streams) {
    if (node.type === 'simple_command' || node.type === 'function_def') return executeCommand.call(this, node, stdin, stdout, term, stderr, streams);
    let input = stdin ?? term;
    let out = (stdout ?? streams?.stdout ?? this._streams?.stdout) as Stream | undefined;
    let err = (stderr ?? streams?.stderr ?? this._streams?.stderr) as Stream | undefined;
    for (const r of node.redirections ?? []) {
      const op = r.operator;
      if (op === '2>&1') { err = out; continue; }
      if (op === '>&2') { out = err; continue; }
      if (op === '>&1') continue;
      const path = joinPath(this.config.getCwd(), await this.__expandWord(r.target));
      const vfs = this.config.vfs;
      if (op === '<') input = this.createFileReader(path);
      else if (op === '>>' || op === '2>>') {
        if (!vfs.exists(path)) vfs.writeFile(path, '');
        const w = this.createFileAppender(path);
        if (op === '>>') out = w;
        else err = w;
      } else {
        vfs.writeFile(path, '');
        const w = this.createFileWriter(path);
        if (op !== '2>') out = w;
        if (op !== '>') err = w;
      }
    }
    this.__io ??= new WeakMap();
    for (const l of listsOf(node)) this.__io.set(l, { stdin: input, stderr: err });
    return executeCommand.call(this, node, undefined, out, undefined, undefined, streams);
  };

  /* for x; do（in を書かない）は "$@" と同じ */
  const executeFor = proto.executeFor;
  proto.executeFor = function (node, stdout) {
    return executeFor.call(this, node.words === null ? { ...node, words: [[{ text: '$@', quoted: 'double' }]] } : node, stdout);
  };

  /* 関数の引数を配列のまま積む（patch-lifo.mjs の単語の分割が "$@" に使う） */
  const executeFunction = proto.executeFunction;
  proto.executeFunction = async function (body, args) {
    (this.__argv ??= []).push([...args]);
    try {
      return await executeFunction.call(this, body, args);
    } finally {
      this.__argv.pop();
    }
  };

  const createExpandContext = proto.createExpandContext;
  proto.createExpandContext = function () {
    return { ...createExpandContext.call(this), argv: this.__argv?.at(-1) };
  };
}
