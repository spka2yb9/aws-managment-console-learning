/* TerminalController — xterm.js と CliShell の間 (linux-learning の TerminalController.ts を移植)
   ------------------------------------------------------------------
   ここにシェルの処理は1行も書かない。やるのは4つだけ。

     キー入力 → 行バッファを組み立てる（実行中の Ctrl+C は shell.cancel へ）
     Enter    → shell.execute(line)
     stdout / stderr を xterm へ書く
     プロンプトを出し直す                                              */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { CliShell } from '../shell/shell';

const CSI = '\x1b[';
/* コマンドの出力の C1 制御文字（U+0080〜U+009F）は、読めない文字にしておく。Shift_JIS を cat すると、たまたま UTF-8 の U+0090（DCS）になる並びがあり、
   端末がそのあとの出力を飲み込んでしまう（本物の端末でも起きるが、演習の画面を壊さないように） */
const safe = (d: string) => d.replace(/[\u0080-\u009f]/g, '\ufffd');
/* 画面上の幅（マス数）。全角の文字は2マス使う（xterm の既定の Unicode 6 と同じ範囲）。
   文字数で数えると、日本語を打ってから Backspace や ← を押したときにカーソルがずれる */
const WIDE = /[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3040-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
const cells = (s: string) => { let n = 0; for (const c of s) n += WIDE.test(c) ? 2 : 1; return n; };

export class TerminalController {
  private term: Terminal;
  private fit = new FitAddon();
  private line = '';
  private cursor = 0;
  private history: string[] = [];
  private histIndex = 0;
  private draft = '';
  private busy = false;
  private pasteQueue: string[] = [];
  private row = 0;
  /* reset() のたびに進む。リセット前に打ったコマンドの結果を、リセット後の画面に書かないため */
  private epoch = 0;
  private cleanup: () => void;

  constructor(el: HTMLElement, private runtime: CliShell, private notify: (msg: string) => void = () => {}) {
    const term = new Terminal({
      fontFamily: '"SFMono-Regular", "JetBrains Mono", "Menlo", "Consolas", "Noto Sans Mono CJK JP", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
      theme: {
        background: '#0b0f14', foreground: '#c9d5e1', cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#1b232c', red: '#f85149', green: '#3fb950', yellow: '#d29922',
        blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
        brightBlack: '#6e7681', brightRed: '#ff7b72', brightGreen: '#56d364',
        brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
      },
    });
    term.loadAddon(this.fit);
    term.open(el);
    this.term = term;
    this.refit();

    const data = term.onData((d) => this.onData(d));

    /* キー入力の横取り。false を返すと xterm は何もせず preventDefault もしない */
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      /* Shift+Insert はブラウザ本来の貼り付けに任せる */
      if (e.shiftKey && e.key === 'Insert') return false;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return true;
      const k = (e.key || '').toLowerCase();
      /* コピー: 選択があるときだけ横取りする。無ければ SIGINT のまま */
      if (k === 'c' && term.hasSelection()) {
        this.copy(term.getSelection());
        return false;
      }
      /* 貼り付け: xterm は Ctrl+V を \x16 に変換して preventDefault するため、
         paste イベントが発生しなくなる。false を返せば textarea へ paste が届き、
         中身が onData にまとめて流れてくる（paste() が処理する） */
      return !(k === 'v' || k === 'insert');
    });

    const onResize = () => this.refit();
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    window.addEventListener('resize', onResize);
    this.cleanup = () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      data.dispose();
      term.dispose();
    };
  }

  dispose(): void { this.cleanup(); }
  focus(): void { this.term.focus(); }

  /* 環境を作り直している間は入力を受け付けない */
  lock(message: string): void {
    this.epoch++;
    this.busy = true;
    this.term.reset();
    this.term.write(`\x1b[2m${message}\x1b[0m`);
  }

  reset(banner = ''): void {
    this.epoch++;
    this.term.reset();
    this.term.write('\x1b[3J\x1b[2J\x1b[H');   // scrollback ごと消す
    this.line = ''; this.cursor = 0; this.busy = false; this.row = 0;
    this.history = []; this.histIndex = 0; this.pasteQueue = [];
    if (banner) this.term.write(banner);
    this.prompt();
  }

  /* 教材UIから「このコマンドを入力欄に入れる」ためのAPI（ヒントの答えなど） */
  insert(cmd: string): void {
    if (this.busy) return;
    this.line = cmd;
    this.cursor = cmd.length;
    this.redraw();
    this.focus();
  }

  private refit(): void {
    try { this.fit.fit(); } catch { /* 非表示のときは測れない */ }
  }

  private prompt(): void {
    this.row = 0;
    this.term.write(this.runtime.promptAnsi());
  }

  private promptWidth(): number {
    return cells(this.runtime.promptText());
  }

  /* 行を描き直す。折り返しても崩れないよう、プロンプト＋入力が何行を占めるかを
     数えてから、先頭行へ戻して画面末尾まで消し、書き直す。
     this.row は「入力行の先頭から見て、カーソルが今どの行にいるか」 */
  private redraw(): void {
    const cols = this.term.cols || 80;
    const pw = this.promptWidth();
    let out = '';
    if (this.row) out += CSI + this.row + 'A';
    out += '\r' + CSI + 'J';
    out += this.runtime.promptAnsi() + this.line;

    const end = pw + cells(this.line);
    let endRow = Math.floor(end / cols);
    const endCol = end % cols;
    /* ちょうど行端で終わると、端末はまだ同じ行に居る。改行して位置を確定させる */
    if (endCol === 0 && this.line.length) { out += '\r\n'; endRow += 1; }

    const at = pw + cells(this.line.slice(0, this.cursor));
    const curRow = Math.floor(at / cols);
    const curCol = at % cols;
    if (endRow > curRow) out += CSI + (endRow - curRow) + 'A';
    out += '\r';
    if (curCol > 0) out += CSI + curCol + 'C';

    this.row = curRow;
    this.term.write(out);
  }

  private onData(data: string): void {
    /* 実行中は Ctrl+C だけ受け付ける（aws ... wait や curl のタイムアウト待ちを止める） */
    if (this.busy) {
      if (data === '\x03') { this.term.write('^C\r\n'); this.runtime.cancel(); }   // bash と同じく ^C と出して止める
      return;
    }

    /* まとめて届いたら貼り付け（または IME の確定）。エスケープ列は除く */
    if (data.length > 1 && data[0] !== '\x1b') { this.paste(data); return; }

    for (let i = 0; i < data.length; i++) {
      const ch = data[i];

      if (ch === '\x1b') {   // 矢印 / Home / End / Delete
        const seq = data.slice(i);
        const at = (s: string) => seq.startsWith(CSI + s);
        if (at('A')) { this.historyUp(); i += 2; continue; }
        if (at('B')) { this.historyDown(); i += 2; continue; }
        if (at('C')) {
          if (this.cursor < this.line.length) { this.term.write(CSI + cells(this.line[this.cursor]) + 'C'); this.cursor++; }
          i += 2; continue;
        }
        if (at('D')) {
          if (this.cursor > 0) { this.cursor--; this.term.write(CSI + cells(this.line[this.cursor]) + 'D'); }
          i += 2; continue;
        }
        if (at('H') || at('1~')) { this.cursor = 0; this.redraw(); i += 2; continue; }
        if (at('F') || at('4~')) { this.cursor = this.line.length; this.redraw(); i += 2; continue; }
        if (at('3~')) {
          if (this.cursor < this.line.length) {
            this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
            this.redraw();
          }
          i += 3; continue;
        }
        break;   // 未対応シーケンスは捨てる
      }

      if (ch === '\r') { this.submit(); return; }
      if (ch === '\t') { void this.complete(); return; }

      if (ch === '\x7f' || ch === '\b') {   // Backspace
        if (this.cursor > 0) {
          this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
          this.cursor--;
          this.redraw();
        }
        continue;
      }

      if (ch === '\x03') {   // Ctrl+C
        this.term.write('^C\r\n');
        this.line = ''; this.cursor = 0; this.histIndex = this.history.length;
        this.prompt();
        continue;
      }
      if (ch === '\x0c') {   // Ctrl+L
        this.term.write(CSI + '2J' + CSI + 'H');
        this.row = 0;
        this.redraw();
        continue;
      }
      if (ch === '\x15') { this.line = this.line.slice(this.cursor); this.cursor = 0; this.redraw(); continue; }  // Ctrl+U
      if (ch === '\x0b') { this.line = this.line.slice(0, this.cursor); this.redraw(); continue; }               // Ctrl+K
      if (ch === '\x01') { this.cursor = 0; this.redraw(); continue; }                                           // Ctrl+A
      if (ch === '\x05') { this.cursor = this.line.length; this.redraw(); continue; }                            // Ctrl+E
      if (ch === '\x17') {                                                                                         // Ctrl+W
        const left = this.line.slice(0, this.cursor).replace(/\S+\s*$/, '');
        this.line = left + this.line.slice(this.cursor);
        this.cursor = left.length;
        this.redraw();
        continue;
      }

      if (ch < ' ') continue;   // その他の制御文字は無視

      this.line = this.line.slice(0, this.cursor) + ch + this.line.slice(this.cursor);
      this.cursor++;
      if (this.cursor === this.line.length) {
        this.term.write(ch);
        this.row = Math.floor((this.promptWidth() + cells(this.line)) / (this.term.cols || 80));
      } else {
        this.redraw();
      }
    }
  }

  private historyUp(): void {
    if (!this.history.length) return;
    if (this.histIndex === this.history.length) this.draft = this.line;
    if (this.histIndex > 0) this.histIndex--;
    this.line = this.history[this.histIndex];
    this.cursor = this.line.length;
    this.redraw();
  }

  private historyDown(): void {
    if (!this.history.length) return;
    if (this.histIndex < this.history.length) this.histIndex++;
    this.line = this.histIndex === this.history.length ? this.draft : this.history[this.histIndex];
    this.cursor = this.line.length;
    this.redraw();
  }

  private submit(): void {
    const cmd = this.line;
    const trimmed = cmd.trim();
    this.term.write('\r\n');
    this.line = ''; this.cursor = 0; this.row = 0;
    if (trimmed && this.history[this.history.length - 1] !== cmd) this.history.push(cmd);
    this.histIndex = this.history.length;

    if (!trimmed) { this.prompt(); this.drainPaste(); return; }
    if (trimmed === 'clear') {
      this.term.write(CSI + '2J' + CSI + 'H');
      this.prompt();
      this.drainPaste();
      return;
    }

    this.busy = true;
    const epoch = this.epoch;
    let streamed = false;
    const live = (fn: () => void) => { if (epoch === this.epoch) { streamed = true; fn(); } };
    void this.runtime.execute(cmd, {
      onStdout: (d) => live(() => this.term.write(safe(d))),
      onStderr: (d) => live(() => this.term.write('\x1b[31m' + safe(d) + '\x1b[0m')),
    }).then((res) => {
      if (epoch !== this.epoch) return;
      if (!streamed) {
        if (res.stdout) this.term.write(safe(res.stdout));
        if (res.stderr) this.term.write('\x1b[31m' + safe(res.stderr) + '\x1b[0m');
      }
      const all = res.stdout + res.stderr;
      if (all && !all.endsWith('\n')) this.term.write('\r\n');
      this.busy = false;
      this.prompt();
      this.term.scrollToBottom();
      this.drainPaste();
    });
  }

  /* 貼り付け: 1行目はカーソル位置へ挿入。改行を含む場合は1行ずつ実行し、最後の行は実行せずに残す */
  private paste(text: string): void {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const first = lines[0];
    this.line = this.line.slice(0, this.cursor) + first + this.line.slice(this.cursor);
    this.cursor += first.length;
    this.redraw();
    if (lines.length > 1) {
      this.pasteQueue = lines.slice(1);
      this.submit();
    }
  }

  private drainPaste(): void {
    const next = this.pasteQueue.shift();
    if (next == null) return;
    this.line = next;
    this.cursor = next.length;
    this.redraw();
    if (this.pasteQueue.length) this.submit();
  }

  private copy(text: string): void {
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => { this.term.clearSelection(); this.notify('クリップボードにコピーしました'); },
      () => this.notify('コピーできませんでした'),
    );
  }

  /* ---- Tab 補完。候補の計算は runtime 側、ここは差し替えと候補の描画だけ ---- */
  private async complete(): Promise<void> {
    if (this.busy) return;
    this.busy = true;   // 計算中の入力を取りこぼさないよう止める
    const epoch = this.epoch;
    const r = await this.runtime.complete(this.line, this.cursor).catch(() => null);
    if (epoch !== this.epoch) return;
    this.busy = false;
    if (!r || !r.items.length) return;
    const word = this.line.slice(r.start, r.end);
    if (r.items.length === 1) {
      const v = r.items[0];
      this.replace(r.start, r.end, v + (v.endsWith('/') ? '' : ' '));
    } else if (r.common.length > word.length) {
      this.replace(r.start, r.end, r.common);
    } else {
      this.printCandidates(r.labels);
    }
  }

  private replace(start: number, end: number, text: string): void {
    this.line = this.line.slice(0, start) + text + this.line.slice(end);
    this.cursor = start + text.length;
    this.redraw();
  }

  private printCandidates(items: string[]): void {
    const MAX = 60;
    const list = items.slice(0, MAX);
    const w = Math.max(...list.map(cells)) + 2;
    const cols = this.term.cols || 80;
    const per = Math.max(1, Math.floor(cols / w));

    /* 入力行が折り返している場合に備えて、まず最終行の下へ出る */
    const endRow = Math.floor((this.promptWidth() + cells(this.line)) / cols);
    const down = endRow - this.row;
    let out = (down > 0 ? CSI + down + 'B' : '') + '\r\n';
    list.forEach((s, i) => {
      out += s + ' '.repeat(w - cells(s));
      if ((i + 1) % per === 0) out += '\r\n';
    });
    if (list.length % per !== 0) out += '\r\n';
    if (items.length > MAX) out += `\x1b[2m…他 ${items.length - MAX} 件\x1b[0m\r\n`;
    this.term.write(out);
    this.row = 0;
    this.redraw();
  }
}
