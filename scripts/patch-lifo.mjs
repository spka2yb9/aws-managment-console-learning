/* Lifo 0.10.18 の同梱コードを書き換える（npm install のたびに postinstall で実行）。linux-learning の同名スクリプトから、CLI 版で要るものだけを移植
   ------------------------------------------------------------------
   外から差し替えられない場所だけをここで直す。それ以外は src/cli/shell/lifo.ts で上書きしている。
   パターンが見つからなければ失敗させる。 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CORE = [
  {
    /* grep / sed / head / tail などは拡張子でテキストかどうかを決めていて、拡張子の無いファイル（/etc/passwd …）や
       .bashrc を「binary file, skipping」と読み飛ばす。「わからない拡張子はテキスト」にする。
       教材の仮想Linuxに本物のバイナリは無い */
    name: '拡張子の判定',
    from: 'if (e === -1) return "application/octet-stream";\n  const t = r.slice(e).toLowerCase();\n  return cc.get(t) ?? "application/octet-stream";',
    to: 'if (e === -1) return "text/plain";\n  const t = r.slice(e).toLowerCase();\n  return cc.get(t) ?? "text/plain";',
  },
  {
    /* エイリアス（ll など）を展開したあと、出力先を渡さずに実行しているので、出力が消える（パイプの先にも届かない）。
       そのコマンドが受け取った入力と出力先を渡す */
    name: 'エイリアスの出力先',
    from: '        return this.executeLine(T);\n      }\n    }\n    const m = {};',
    to: '        return this.executeLine(T, t, { ...o, stdout: n ?? (o == null ? void 0 : o.stdout), stderr: i ?? (o == null ? void 0 : o.stderr) });\n      }\n    }\n    const m = {};',
  },
  {
    /* ワイルドカードの * や ? が、. で始まる名前（隠しファイル）にも当たる（echo * に .bashrc が出る）。
       bash と同じく、型そのものが . で始まるとき（.*）だけ隠しファイルに当てる */
    name: 'ワイルドカードと隠しファイル',
    from: '            if (tt(c, f.name)) {',
    to: '            if ((c.startsWith(".") || !f.name.startsWith(".")) && tt(c, f.name)) {',
  },
  {
    /* ワイルドカードの結果から、書いた頭の部分（./ や ../）が消える。rm ./-* が rm -2026-09-30.tar.gz になって、
       オプションと間違えられる。bash と同じく、ワイルドカードより前に書いたとおりの頭を付けて返す */
    name: 'ワイルドカードの頭の ./',
    from: '    const c = e === "/" ? "/" : e + "/";\n    a = o.map((l) => l.startsWith(c) ? l.slice(c.length) : l);',
    to: '    const g = r.split("/"), k = g.findIndex((x) => is(x)), lead = g.slice(0, k).join("/"), b = lead ? se(e, lead) : e, c = b === "/" ? "/" : b + "/";\n    a = o.map((l) => l.startsWith(c) ? (lead ? lead + "/" : "") + l.slice(c.length) : l);',
  },
  {
    /* 単語の分割をしない。$(seq 1 3) や $list が空白・改行を含んでも1つの単語のままで、for が1回しか回らない。
       "$@" も1つにつながる。bash と同じく、引用符の外の展開結果だけを空白・タブ・改行で分け、空になったら消す。
       "$@" は引数ごとに1つの単語にする（引数の配列は e.argv。lifoAdapter の executeFunction が積む）。
       [[ ]] の中は分けない */
    name: '単語の分割',
    from: 'async function os(r, e) {\n  const t = [];\n  for (const n of r) {\n    const s = await fi(n, e);\n    if (wl(n)) {\n      const i = fl(s, e.cwd, e.vfs);\n      t.push(...i);\n    } else\n      t.push(s);\n  }\n  return t;\n}',
    to: `async function os(r, e) {
  const t = [], keep = r.length > 0 && r[0].length === 1 && r[0][0].quoted === "none" && r[0][0].text === "[[";
  for (const n of r)
    for (const f of await __fields(n, e, keep))
      f.glob ? t.push(...fl(f.s, e.cwd, e.vfs)) : t.push(f.s);
  return t;
}
async function __fields(r, e, keep) {
  const out = [], globby = (s) => /[*?[]/.test(s);
  let cur = null;
  const add = (s, g) => { cur ?? (cur = { s: "", glob: !1 }), cur.s += s, g && (cur.glob = !0); }, brk = () => { cur && out.push(cur), cur = null; };
  for (let k = 0; k < r.length; k++) {
    const n = r[k];
    if (n.quoted === "single") { add(n.text, !1); continue; }
    if (n.quoted === "double") {
      const at = n.text.indexOf("$@");
      if (at < 0) { add(await as(n.text, e), !1); continue; }
      const argv = e.argv ?? (e.env["@"] ? e.env["@"].split(" ") : []), pre = await as(n.text.slice(0, at), e), post = await as(n.text.slice(at + 2), e);
      if (!argv.length) { (pre || post || cur || r.length > 1) && add(pre + post, !1); continue; }
      argv.forEach((a, i) => { i > 0 && brk(), add((i === 0 ? pre : "") + a + (i === argv.length - 1 ? post : ""), !1); });
      continue;
    }
    let s = n.text, lit = "";
    if (k === 0 && s.startsWith("~")) {
      const h = e.env.HOME ?? "/home/user";
      s === "~" ? s = h : s.startsWith("~/") && (s = h + s.slice(1));
    }
    for (let i = 0; i < s.length; ) {
      if (s[i] !== "$") { lit += s[i++]; continue; }
      const x = await hl(s, i, e);
      if (x.end === i + 1) { lit += "$", i++; continue; }
      lit && (add(lit, globby(lit)), lit = ""), i = x.end;
      if (keep) { add(x.value, !1); continue; }
      x.value.split(/[ \\t\\n]+/).forEach((p, j) => { j > 0 && brk(), p && add(p, globby(p)); });
    }
    lit && add(lit, globby(lit));
  }
  return brk(), out;
}`,
  },
  {
    /* $* が展開されない（$ と * に分かれて、* がファイル名に化ける）。$@ と同じく引数を空白でつなぐ */
    name: '$* と $@',
    from: '  if (n === "@")\n    return { value: t.env["@"] ?? "", end: e + 2 };',
    to: '  if (n === "@" || n === "*")\n    return { value: t.argv ? t.argv.join(" ") : t.env["@"] ?? "", end: e + 2 };',
  },
  {
    /* if / for / while に付いたリダイレクト（done < file など）を lifoAdapter で扱うため、単語を展開する入口を出しておく */
    name: '単語の展開を外から',
    from: 'const cs = "/home/user/.bash_history", ls = 1e3;',
    to: 'Sl.prototype.__expandWord = function (r) {\n  return Ct(r, this.createExpandContext());\n};\nconst cs = "/home/user/.bash_history", ls = 1e3;',
  },
  {
    /* for / if / while / { } の中に余分な ) があると (for a in x; do echo $a); done)、構文の解析が先へ進まないまま
       同じ場所を読み続け、メモリを使い切ってタブが固まる。トップレベルと同じく、進まなければ unexpected token にする */
    name: '複合コマンドの中の余分な )',
    from: '      t.push(this.parseList()), this.skipSeparators();\n    }\n    return t;',
    to: '      const p = this.pos;\n      if (t.push(this.parseList()), this.skipSeparators(), this.pos === p)\n        throw new Br(`unexpected token \'${this.peek().value}\'`, this.peek().pos);\n    }\n    return t;',
  },
];

function patch(dir, pick, patches) {
  const dist = join(import.meta.dirname, '../node_modules', dir);
  const file = readdirSync(dist).find((f) => /\.js$/.test(f) && pick(f, readFileSync(join(dist, f), 'utf8')));
  if (!file) throw new Error(`patch-lifo: ${dir} が見つかりません`);
  const path = join(dist, file);
  let src = readFileSync(path, 'utf8');
  for (const p of patches) {
    if (src.includes(p.to)) continue;   // 適用済み
    if (!src.includes(p.from)) throw new Error(`patch-lifo: ${dir}/${file} の「${p.name}」が想定と違います`);
    src = src.replace(p.from, p.to);
    console.log(`patch-lifo: ${p.name} を書き換えました`);
  }
  writeFileSync(path, src);
}

patch('@lifo-sh/core/dist', (f, src) => /^index-/.test(f) && src.includes('function lc(r)'), CORE);
