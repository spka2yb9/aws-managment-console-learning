/* AWS CLI の shorthand 構文（Key=Name,Value=web / Name=tag:Name,Values=a,b / [{Key=a,Value=b},{...}]）。
   awscli/shorthand.py の文法を、教材で使う範囲で移植した。
   値はすべて文字列（数値や真偽値への変換は各オペレーションが行う）。値が複数あれば配列になる。 */

export type Shorthand = string | Shorthand[] | { [key: string]: Shorthand };

export class ShorthandError extends Error {}

export function parseShorthand(input: string): Shorthand {
  const p = new Parser(input);
  const v = p.top();
  if (!p.done()) p.fail('予期しない文字があります');
  return v;
}

class Parser {
  private i = 0;
  constructor(private s: string) {}

  done() {
    return this.i >= this.s.length;
  }

  fail(msg: string): never {
    throw new ShorthandError(`Error parsing parameter: Expected: ${msg}, received: "${this.s.slice(this.i, this.i + 20)}" for input:\n${this.s}\n${' '.repeat(this.i)}^`);
  }

  /* 先頭: [ ... ] の明示的なリスト、または key=value,... */
  top(): Shorthand {
    this.ws();
    if (this.s[this.i] === '[') return this.list();
    return this.keyvals('');
  }

  private ws() {
    while (this.s[this.i] === ' ') this.i++;
  }

  private keyvals(close: string): { [key: string]: Shorthand } {
    const out: { [key: string]: Shorthand } = {};
    for (;;) {
      this.ws();
      const key = this.key();
      if (this.s[this.i] !== '=') this.fail('=');
      this.i++;
      if (key in out) throw new ShorthandError(`Second instance of key "${key}" encountered for input:\n${this.s}\n${' '.repeat(this.i - key.length - 1)}^\nThis is often because there is a preceding "," instead of a space.`);
      out[key] = this.values(close);
      this.ws();
      if (this.s[this.i] === ',') {
        this.i++;
        continue;
      }
      return out;
    }
  }

  private key(): string {
    const m = /^[\w.#:/@-]+/.exec(this.s.slice(this.i));
    if (!m) this.fail('key');
    this.i += m[0].length;
    return m[0];
  }

  /* Values=a,b,c の a,b,c。次の key= が始まるところで止める */
  private values(close: string): Shorthand {
    const c = this.s[this.i];
    if (c === '[') return this.list();
    if (c === '{') return this.hash();
    const first = this.value(close);
    const more: string[] = [];
    while (this.s[this.i] === ',' && !this.nextIsKey()) {
      this.i++;
      more.push(this.value(close));
    }
    return more.length ? [first, ...more] : first;
  }

  private nextIsKey(): boolean {
    return /^,\s*[\w.#:/@-]+=/.test(this.s.slice(this.i));
  }

  private list(): Shorthand[] {
    this.i++; // [
    const out: Shorthand[] = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      out.push(c === '{' ? this.hash() : c === '[' ? this.list() : this.value(']'));
      this.ws();
      if (this.s[this.i] === ',') {
        this.i++;
        continue;
      }
      if (this.s[this.i] === ']') {
        this.i++;
        return out;
      }
      this.fail('"," or "]"');
    }
  }

  private hash(): { [key: string]: Shorthand } {
    this.i++; // {
    this.ws();
    if (this.s[this.i] === '}') {
      // Allow={} のような空の構造
      this.i++;
      return {};
    }
    const out = this.keyvals('}');
    this.ws();
    if (this.s[this.i] !== '}') this.fail('"}"');
    this.i++;
    return out;
  }

  /* 1つの値。引用符で囲めば , や = も書ける */
  private value(close: string): string {
    const q = this.s[this.i];
    if (q === '"' || q === "'") {
      const end = this.s.indexOf(q, this.i + 1);
      if (end < 0) this.fail(q);
      const v = this.s.slice(this.i + 1, end);
      this.i = end + 1;
      return v;
    }
    let v = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === ',' || (close && c === close) || c === '}' || c === ']') break;
      if (c === '\\' && this.i + 1 < this.s.length) {
        v += this.s[this.i + 1];
        this.i += 2;
        continue;
      }
      v += c;
      this.i++;
    }
    return v.trim();
  }
}
