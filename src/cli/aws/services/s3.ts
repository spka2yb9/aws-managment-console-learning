/* aws s3 — 高レベルのコマンド (ls / cp / rm / mb / rb)。S3 URI (s3://バケット/キー) と手元のファイルで話す。
   出力は API の JSON ではなく、実物の aws s3 と同じ 1 行ずつの文字 (raw)。中身は s3api.ts と同じ関数で動かす */
import { deleteBucket, getBucket } from '../../../sim/s3';
import type { S3Object } from '../../../sim/types';
import { AwsError, bool, req, service, str, type OpContext, type OperationSpec, type RawResult } from '../types';
import { listObjects, makeBucket, readObject, removeObject, writeObject } from './s3api';

const parseUri = (u: string | undefined) => {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(u ?? '');
  return m ? { bucket: m[1], key: m[2] } : null;
};
/** 2026-09-28 12:34:56 (実物は PC のローカル時刻。ここでは UTC) */
const when = (t: string) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
const human = (n: number) => (n < 1024 ? `${n} Bytes` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`);
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

/** API のエラーを aws s3 の書き方で (fatal error: ... / upload failed: ...) */
function fail(e: unknown, prefix: string, exitCode: number, api: string): RawResult {
  if (!(e instanceof AwsError)) throw e;
  return { text: `${prefix}An error occurred (${e.code}) when calling the ${api} operation: ${e.message}`, exitCode, errorCode: e.code };
}

function ls(ctx: OpContext): RawResult | string {
  const path = str(ctx, 'path');
  if (!path || path === 's3://') return ctx.env.buckets.map((b) => `${when(b.creationDate)} ${b.name}`).join('\n');
  const t = parseUri(path.startsWith('s3://') ? path : `s3://${path}`);
  if (!t) return { text: '\n<S3Uri> の形 (s3://バケット名/プレフィックス) で指定してください', exitCode: 252, errorCode: 'ParamValidation' };
  const recursive = bool(ctx, 'recursive');
  const size = (n: number) => (bool(ctx, 'human-readable') ? human(n) : String(n)).padStart(10);
  let objs: S3Object[];
  try {
    objs = listObjects(ctx.env, t.bucket, t.key);
  } catch (e) {
    return fail(e, '\n', 254, 'ListObjectsV2');
  }
  // 区切り (/) までをフォルダのように PRE でまとめる。表示は指定したプレフィックスの最後の / より後ろ
  const cut = t.key.lastIndexOf('/') + 1;
  const lines: string[] = [];
  const pre = new Set<string>();
  for (const o of objs) {
    const rest = o.key.slice(t.key.length);
    if (!recursive && rest.includes('/')) {
      const dir = o.key.slice(cut, t.key.length + rest.indexOf('/') + 1);
      if (!pre.has(dir)) lines.push(`${'PRE'.padStart(30)} ${dir}`);
      pre.add(dir);
    } else lines.push(`${when(o.lastModified)} ${size(o.size)} ${recursive ? o.key : o.key.slice(cut)}`);
  }
  if (bool(ctx, 'summarize')) {
    const total = objs.reduce((n, o) => n + o.size, 0);
    lines.push('', `Total Objects: ${objs.length}`, `   Total Size: ${bool(ctx, 'human-readable') ? human(total) : total}`);
  }
  return lines.join('\n');
}

function cp(ctx: OpContext): RawResult | string {
  const src = req(ctx, 'source');
  const dst = req(ctx, 'destination');
  const from = parseUri(src);
  const to = parseUri(dst);
  if (!from && !to) return { text: 'usage: aws s3 cp <LocalPath> <S3Uri> or <S3Uri> <LocalPath> or <S3Uri> <S3Uri>\nError: Invalid argument type', exitCode: 252, errorCode: 'ParamValidation' };
  const keyFor = (prefix: string, name: string) => (prefix === '' || prefix.endsWith('/') ? prefix + name : prefix);
  if (!from) {
    const body = ctx.readLocal(src);
    if (body === null) return { text: `\nThe user-provided path ${src} does not exist.`, exitCode: 255, errorCode: 'ParamValidation' };
    const key = keyFor(to!.key, basename(src));
    try {
      writeObject(ctx.env, to!.bucket, key, body, str(ctx, 'content-type'));
      return `upload: ${src.startsWith('/') || src.startsWith('.') || src.startsWith('~') ? src : `./${src}`} to s3://${to!.bucket}/${key}`;
    } catch (e) {
      return fail(e, `upload failed: ${src} to s3://${to!.bucket}/${key} `, 1, 'PutObject');
    }
  }
  // S3 から: 実物はまず HeadObject を呼ぶ。HEAD の応答には本文が無いので、失敗は 403 / 404 としか出ない
  let o: S3Object;
  try {
    getBucket(ctx.env, from.bucket);
    o = readObject(ctx.env, from.bucket, from.key);
  } catch (e) {
    if (!(e instanceof AwsError)) throw e;
    if (e.code === 'NoSuchBucket') return { text: 'fatal error: An error occurred (NoSuchBucket) when calling the HeadObject operation: The specified bucket does not exist', exitCode: 1, errorCode: e.code };
    if (e.code === 'NoSuchKey') return { text: `fatal error: An error occurred (404) when calling the HeadObject operation: Key "${from.key}" does not exist`, exitCode: 1, errorCode: '404' };
    return { text: 'fatal error: An error occurred (403) when calling the HeadObject operation: Forbidden', exitCode: 1, errorCode: '403' };
  }
  if (dst === '-') return o.body ?? '';
  if (to) {
    const key = keyFor(to.key, basename(from.key));
    try {
      writeObject(ctx.env, to.bucket, key, o.body ?? '', o.contentType);
      return `copy: ${src} to s3://${to.bucket}/${key}`;
    } catch (e) {
      return fail(e, `copy failed: ${src} to s3://${to.bucket}/${key} `, 1, 'CopyObject');
    }
  }
  const file = dst === '.' || dst.endsWith('/') ? `${dst === '.' ? '.' : dst.replace(/\/$/, '')}/${basename(from.key)}` : dst;
  ctx.writeLocal(file, o.body ?? '');
  return `download: ${src} to ${file}`;
}

function rm(ctx: OpContext): RawResult | string {
  const t = parseUri(req(ctx, 'path'));
  if (!t) return { text: `\nusage: aws s3 rm <S3Uri>\nError: Invalid argument type`, exitCode: 252, errorCode: 'ParamValidation' };
  try {
    const keys = bool(ctx, 'recursive') ? listObjects(ctx.env, t.bucket, t.key).map((o) => o.key) : [t.key];
    return keys
      .map((k) => {
        removeObject(ctx.env, t.bucket, k);
        return `delete: s3://${t.bucket}/${k}`;
      })
      .join('\n');
  } catch (e) {
    return fail(e, `delete failed: ${req(ctx, 'path')} `, 1, 'DeleteObject');
  }
}

const ops: OperationSpec[] = [
  {
    name: 'ls',
    desc: 'バケットの一覧 / S3 URI の下のオブジェクトの一覧 (/ までをフォルダのように PRE で表示)',
    params: [
      { name: 'path', type: 'string', positional: true, desc: 's3://バケット/プレフィックス (省略するとバケットの一覧)' },
      { name: 'recursive', type: 'boolean', desc: '下の階層もすべて、キーをそのまま表示する' },
      { name: 'human-readable', type: 'boolean', desc: 'サイズを KiB / MiB で' },
      { name: 'summarize', type: 'boolean', desc: '最後に件数と合計サイズ' },
    ],
    readOnly: true,
    raw: true,
    scope: 'global',
    examples: ['aws s3 ls', 'aws s3 ls s3://my-bucket/reports/'],
    run: ls,
  },
  {
    name: 'cp',
    desc: '手元のファイルと S3 の間でコピーする (S3 URI を - にすると画面に出す)',
    params: [
      { name: 'source', type: 'string', required: true, positional: true, desc: 'コピー元 (ファイル か s3://...)' },
      { name: 'destination', type: 'string', required: true, positional: true, desc: 'コピー先 (ファイル・. か s3://...)' },
      { name: 'content-type', type: 'string', desc: '例: text/html' },
    ],
    raw: true,
    scope: 'global',
    examples: ['aws s3 cp hello.txt s3://my-bucket/', 'aws s3 cp s3://my-bucket/hello.txt .', 'aws s3 cp s3://my-bucket/hello.txt -'],
    run: cp,
  },
  {
    name: 'rm',
    desc: 'S3 のオブジェクトを削除する (--recursive でプレフィックスの下をすべて)',
    params: [
      { name: 'path', type: 'string', required: true, positional: true, desc: 's3://バケット/キー' },
      { name: 'recursive', type: 'boolean', desc: 'プレフィックスの下をすべて' },
    ],
    raw: true,
    scope: 'global',
    run: rm,
  },
  {
    name: 'mb',
    desc: 'バケットを作る (make bucket。リージョンは設定どおり)',
    params: [{ name: 'path', type: 'string', required: true, positional: true, desc: 's3://バケット名' }],
    raw: true,
    scope: 'global',
    examples: ['aws s3 mb s3://webapp-assets-123456789012'],
    run(ctx) {
      const t = parseUri(req(ctx, 'path'));
      if (!t) return { text: '\n<S3Uri> の形 (s3://バケット名) で指定してください', exitCode: 252, errorCode: 'ParamValidation' };
      try {
        makeBucket(ctx, t.bucket, ctx.region === 'us-east-1' ? undefined : ctx.region);
        return `make_bucket: ${t.bucket}`;
      } catch (e) {
        return fail(e, `make_bucket failed: s3://${t.bucket} `, 1, 'CreateBucket');
      }
    },
  },
  {
    name: 'rb',
    desc: 'バケットを削除する (remove bucket。--force で中身ごと)',
    params: [
      { name: 'path', type: 'string', required: true, positional: true, desc: 's3://バケット名' },
      { name: 'force', type: 'boolean', desc: '中のオブジェクトをすべて消してから削除する' },
    ],
    raw: true,
    scope: 'global',
    run(ctx) {
      const t = parseUri(req(ctx, 'path'));
      if (!t) return { text: '\n<S3Uri> の形 (s3://バケット名) で指定してください', exitCode: 252, errorCode: 'ParamValidation' };
      try {
        if (bool(ctx, 'force')) getBucket(ctx.env, t.bucket).objects = [];
        deleteBucket(ctx.env, t.bucket);
        return `remove_bucket: ${t.bucket}`;
      } catch (e) {
        return fail(e, `remove_bucket failed: s3://${t.bucket} `, 1, 'DeleteBucket');
      }
    },
  },
];

export default service('s3', 'Amazon S3 (バケットとオブジェクトを S3 URI で扱う高レベルのコマンド)', ops);
