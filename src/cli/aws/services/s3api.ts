/* aws s3api — S3 の API をほぼそのまま呼ぶ低レベルのコマンド (バケットの設定・オブジェクト・バケットポリシー・ブロックパブリックアクセス)。
   バケットの設定はコンソールと同じ sim/s3.ts の関数で変える。オブジェクトの読み書きは、学習者 (IAM ユーザー learner) として
   バケットポリシーも含めて認可してから行う (明示的な Deny は管理者にも効く)。 */
import { accessDeniedMessage, evaluateIamPermission } from '../../../sim/iam';
import { CLIENT_IP } from '../../../sim/network';
import { bucketArn, createBucket, currentObjects, deleteBucket, deleteBucketPolicy, deleteObject, getBucket, isPolicyPublic, latestObject, objectArn, putBucketEncryption, putBucketPolicy, putBucketVersioning, putObject, putPublicAccessBlock } from '../../../sim/s3';
import type { AwsEnv, BlockPublicAccess, Bucket, S3Object } from '../../../sim/types';
import { AwsError, int, iso, req, service, str, struct, type OpContext, type OperationSpec, ParamError } from '../types';

/* ---- s3.ts (aws s3 ls / cp / ...) と共用 ---- */

const ADMIN = [{ source: 'AdministratorAccess (AWS 管理)', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow' as const, Action: '*', Resource: '*' }] } }];
export const learnerArn = (env: AwsEnv) => `arn:aws:iam::${env.accountId}:user/learner`;

/** 学習者の PC (IAM ユーザー learner) からの S3 のデータ操作を認可する。learner がいないシナリオでは管理者として扱う */
export function authorizePc(env: AwsEnv, action: string, resource: string, b?: Bucket) {
  const d = evaluateIamPermission(
    env,
    { principal: { type: 'user', userName: 'learner' }, action, resource, resourcePolicy: b?.policy, context: { 'aws:SecureTransport': true, 'aws:SourceIp': CLIENT_IP } },
    env.iamUsers.some((u) => u.userName === 'learner') ? undefined : ADMIN,
  );
  if (d.decision !== 'Allow') throw new AwsError('AccessDenied', accessDeniedMessage(action, resource, d));
}

/** 認可してから、キーの最新の (削除されていない) オブジェクト。--version-id があればそのバージョン */
export function readObject(env: AwsEnv, bucket: string, key: string, versionId?: string): S3Object {
  const b = getBucket(env, bucket);
  authorizePc(env, versionId ? 's3:GetObjectVersion' : 's3:GetObject', objectArn(bucket, key), b);
  if (versionId) {
    const v = b.objects.find((o) => o.key === key && o.versionId === versionId);
    if (!v) throw new AwsError('NoSuchVersion', 'The specified version does not exist.');
    if (v.deleteMarker) throw new AwsError('MethodNotAllowed', 'The specified method is not allowed against this resource.');
    return v;
  }
  const o = latestObject(b, key);
  if (!o) throw new AwsError('NoSuchKey', 'The specified key does not exist.');
  return o;
}

export function writeObject(env: AwsEnv, bucket: string, key: string, body: string, contentType?: string): S3Object {
  const b = getBucket(env, bucket);
  authorizePc(env, 's3:PutObject', objectArn(bucket, key), b);
  return putObject(env, bucket, key, { size: new TextEncoder().encode(body).length, body, contentType });
}

export function removeObject(env: AwsEnv, bucket: string, key: string) {
  const b = getBucket(env, bucket);
  authorizePc(env, 's3:DeleteObject', objectArn(bucket, key), b);
  deleteObject(env, bucket, key);
}

/** ListObjectsV2 の中身 (認可つき) */
export function listObjects(env: AwsEnv, bucket: string, prefix = ''): S3Object[] {
  const b = getBucket(env, bucket);
  authorizePc(env, 's3:ListBucket', bucketArn(bucket), b);
  return currentObjects(b)
    .filter((o) => o.key.startsWith(prefix))
    .sort((x, y) => x.key.localeCompare(y.key));
}

/** create-bucket と aws s3 mb の共通部分 */
export function makeBucket(ctx: OpContext, name: string, locationConstraint: string | undefined) {
  if (locationConstraint === undefined && ctx.region !== 'us-east-1') throw new AwsError('IllegalLocationConstraintException', 'The unspecified location constraint is incompatible for the region specific endpoint this request was sent to.');
  if (locationConstraint !== undefined && locationConstraint !== ctx.region) throw new AwsError('IllegalLocationConstraintException', `The ${locationConstraint} location constraint is incompatible for the region specific endpoint this request was sent to.`);
  return createBucket(ctx.env, { name, region: locationConstraint ?? 'us-east-1' }, ctx.now);
}

const bucketOf = (ctx: OpContext) => getBucket(ctx.env, req(ctx, 'bucket'));
const objectHead = (o: S3Object) => ({
  AcceptRanges: 'bytes',
  LastModified: iso(o.lastModified),
  ContentLength: o.size,
  ETag: o.etag,
  ...(o.versionId !== 'null' ? { VersionId: o.versionId } : {}),
  ContentType: o.contentType,
  ServerSideEncryption: o.serverSideEncryption,
  Metadata: {},
});
const contentsOut = (o: S3Object) => ({ Key: o.key, LastModified: iso(o.lastModified), ETag: o.etag, Size: o.size, StorageClass: o.storageClass });
const bpaOut = (x: BlockPublicAccess) => ({ BlockPublicAcls: x.blockPublicAcls, IgnorePublicAcls: x.ignorePublicAcls, BlockPublicPolicy: x.blockPublicPolicy, RestrictPublicBuckets: x.restrictPublicBuckets });
const truthy = (v: unknown) => v === true || String(v).toLowerCase() === 'true';

const bucketParam = { name: 'bucket', type: 'string' as const, required: true, desc: 'バケット名' };
const keyParam = { name: 'key', type: 'string' as const, required: true, desc: 'オブジェクトのキー' };

const ops: OperationSpec[] = [
  /* ---- バケット ---- */
  {
    name: 'list-buckets',
    desc: 'バケットの一覧 (全リージョン分)',
    params: [{ name: 'prefix', type: 'string', desc: '名前の頭で絞る' }],
    readOnly: true,
    scope: 'global',
    run: (ctx) => ({
      Buckets: ctx.env.buckets.filter((b) => b.name.startsWith(str(ctx, 'prefix') ?? '')).map((b) => ({ Name: b.name, CreationDate: iso(b.creationDate), BucketRegion: b.region })),
      Owner: { ID: `${ctx.env.accountId}c0ffee`.padEnd(64, '0') },
    }),
  },
  {
    name: 'create-bucket',
    desc: 'バケットを作る (us-east-1 以外では --create-bucket-configuration LocationConstraint=リージョン が必要)',
    params: [bucketParam, { name: 'create-bucket-configuration', type: 'structure', desc: 'LocationConstraint=ap-northeast-1' }],
    scope: 'global',
    examples: ['aws s3api create-bucket --bucket webapp-assets-123456789012 --create-bucket-configuration LocationConstraint=ap-northeast-1'],
    run(ctx) {
      const lc = struct(ctx, 'create-bucket-configuration')?.LocationConstraint;
      const name = makeBucket(ctx, req(ctx, 'bucket'), lc === undefined ? undefined : String(lc));
      return { Location: lc === undefined ? `/${name}` : `http://${name}.s3.amazonaws.com/` };
    },
  },
  {
    name: 'delete-bucket',
    desc: 'バケットを削除する (空にしてから)',
    params: [bucketParam],
    scope: 'global',
    run(ctx) {
      deleteBucket(ctx.env, req(ctx, 'bucket'));
      return undefined;
    },
  },
  {
    name: 'head-bucket',
    desc: 'バケットがあり、アクセスできるかを確かめる',
    params: [bucketParam],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const b = ctx.env.buckets.find((x) => x.name === req(ctx, 'bucket'));
      if (!b) throw new AwsError('404', 'Not Found');
      return { BucketRegion: b.region, AccessPointAlias: false };
    },
  },
  {
    name: 'get-bucket-location',
    desc: 'バケットのリージョン (us-east-1 は null)',
    params: [bucketParam],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const b = bucketOf(ctx);
      return { LocationConstraint: b.region === 'us-east-1' ? null : b.region };
    },
  },
  {
    name: 'get-bucket-versioning',
    desc: 'バージョニングの状態 (一度も有効にしていなければ何も出ない)',
    params: [bucketParam],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const b = bucketOf(ctx);
      return b.versioning === 'Disabled' ? undefined : { Status: b.versioning, MFADelete: 'Disabled' };
    },
  },
  {
    name: 'put-bucket-versioning',
    desc: 'バージョニングを有効にする / 停止する',
    params: [bucketParam, { name: 'versioning-configuration', type: 'structure', required: true, desc: 'Status=Enabled か Status=Suspended' }],
    scope: 'global',
    examples: ['aws s3api put-bucket-versioning --bucket my-bucket --versioning-configuration Status=Enabled'],
    run(ctx) {
      const status = String(struct(ctx, 'versioning-configuration')?.Status ?? '');
      if (status !== 'Enabled' && status !== 'Suspended') throw new AwsError('MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema');
      putBucketVersioning(ctx.env, bucketOf(ctx).name, status);
      return undefined;
    },
  },
  {
    name: 'get-bucket-encryption',
    desc: 'デフォルトの暗号化の設定',
    params: [bucketParam],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const b = bucketOf(ctx);
      return { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: b.encryption.sseAlgorithm }, BucketKeyEnabled: b.encryption.bucketKeyEnabled }] } };
    },
  },
  {
    name: 'put-bucket-encryption',
    desc: 'デフォルトの暗号化を設定する (AES256 = SSE-S3 / aws:kms = SSE-KMS)',
    params: [bucketParam, { name: 'server-side-encryption-configuration', type: 'structure', required: true, desc: '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' }],
    scope: 'global',
    run(ctx) {
      const rule = ([struct(ctx, 'server-side-encryption-configuration')?.Rules].flat()[0] ?? {}) as Record<string, Record<string, unknown> | undefined>;
      const alg = String(rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? '');
      if (alg !== 'AES256' && alg !== 'aws:kms') throw new AwsError('MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema');
      putBucketEncryption(ctx.env, bucketOf(ctx).name, alg, rule.BucketKeyEnabled === undefined ? true : truthy(rule.BucketKeyEnabled));
      return undefined;
    },
  },

  /* ---- ブロックパブリックアクセス・バケットポリシー ---- */
  {
    name: 'get-public-access-block',
    desc: 'バケットのブロックパブリックアクセスの 4 つの設定',
    params: [bucketParam],
    readOnly: true,
    scope: 'global',
    run: (ctx) => ({ PublicAccessBlockConfiguration: bpaOut(bucketOf(ctx).blockPublicAccess) }),
  },
  {
    name: 'put-public-access-block',
    desc: 'ブロックパブリックアクセスを設定する (書かなかった設定は false = オフ になる)',
    params: [bucketParam, { name: 'public-access-block-configuration', type: 'structure', required: true, desc: 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true' }],
    scope: 'global',
    examples: ['aws s3api put-public-access-block --bucket my-bucket --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'],
    run(ctx) {
      const c = struct(ctx, 'public-access-block-configuration') ?? {};
      putPublicAccessBlock(ctx.env, bucketOf(ctx).name, { blockPublicAcls: truthy(c.BlockPublicAcls), ignorePublicAcls: truthy(c.IgnorePublicAcls), blockPublicPolicy: truthy(c.BlockPublicPolicy), restrictPublicBuckets: truthy(c.RestrictPublicBuckets) });
      return undefined;
    },
  },
  {
    name: 'delete-public-access-block',
    desc: 'ブロックパブリックアクセスを消す (4 つともオフ)',
    params: [bucketParam],
    scope: 'global',
    run(ctx) {
      putPublicAccessBlock(ctx.env, bucketOf(ctx).name, { blockPublicAcls: false, ignorePublicAcls: false, blockPublicPolicy: false, restrictPublicBuckets: false });
      return undefined;
    },
  },
  {
    name: 'get-bucket-policy',
    desc: 'バケットポリシー (Policy は JSON の文字列。--query Policy --output text で中身だけ出せる)',
    params: [bucketParam],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const b = bucketOf(ctx);
      if (!b.policy) throw new AwsError('NoSuchBucketPolicy', 'The bucket policy does not exist');
      return { Policy: JSON.stringify(b.policy) };
    },
  },
  {
    name: 'put-bucket-policy',
    desc: 'バケットポリシーを置き換える (--policy file://policy.json か JSON の文字列)',
    params: [bucketParam, { name: 'policy', type: 'string', required: true, desc: 'ポリシーの JSON (file://policy.json)' }],
    scope: 'global',
    examples: ['aws s3api put-bucket-policy --bucket my-bucket --policy file://policy.json'],
    run(ctx) {
      putBucketPolicy(ctx.env, bucketOf(ctx).name, req(ctx, 'policy'), learnerArn(ctx.env));
      return undefined;
    },
  },
  {
    name: 'delete-bucket-policy',
    desc: 'バケットポリシーを削除する',
    params: [bucketParam],
    scope: 'global',
    run(ctx) {
      deleteBucketPolicy(ctx.env, bucketOf(ctx).name);
      return undefined;
    },
  },
  {
    name: 'get-bucket-policy-status',
    desc: 'バケットポリシーが公開 (Principal "*" を条件なしで許可) かどうか',
    params: [bucketParam],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const b = bucketOf(ctx);
      if (!b.policy) throw new AwsError('NoSuchBucketPolicy', 'The bucket policy does not exist');
      return { PolicyStatus: { IsPublic: isPolicyPublic(b.policy) } };
    },
  },

  /* ---- オブジェクト ---- */
  {
    name: 'list-objects-v2',
    desc: 'オブジェクトの一覧 (キーはフルパス。--delimiter / でフォルダのようにまとめる)',
    params: [bucketParam, { name: 'prefix', type: 'string', desc: 'キーの頭で絞る (例: reports/2026/)' }, { name: 'delimiter', type: 'string', desc: '区切り文字 (/ なら CommonPrefixes にまとめる)' }, { name: 'max-keys', type: 'integer', desc: '最大件数' }, { name: 'start-after', type: 'string', desc: 'このキーより後から' }],
    readOnly: true,
    scope: 'global',
    examples: ["aws s3api list-objects-v2 --bucket my-bucket --prefix reports/ --query 'Contents[].Key'"],
    run(ctx) {
      const prefix = str(ctx, 'prefix') ?? '';
      const delimiter = str(ctx, 'delimiter');
      const after = str(ctx, 'start-after') ?? '';
      let objs = listObjects(ctx.env, req(ctx, 'bucket'), prefix).filter((o) => o.key > after);
      const prefixes = new Set<string>();
      if (delimiter) {
        objs = objs.filter((o) => {
          const at = o.key.indexOf(delimiter, prefix.length);
          if (at < 0) return true;
          prefixes.add(o.key.slice(0, at + delimiter.length));
          return false;
        });
      }
      objs = objs.slice(0, int(ctx, 'max-keys') ?? 1000);
      return { ...(objs.length ? { Contents: objs.map(contentsOut) } : {}), ...(prefixes.size ? { CommonPrefixes: [...prefixes].map((p) => ({ Prefix: p })) } : {}), RequestCharged: null, Prefix: prefix };
    },
  },
  {
    name: 'list-object-versions',
    desc: 'オブジェクトのすべてのバージョンと削除マーカー',
    params: [bucketParam, { name: 'prefix', type: 'string', desc: 'キーの頭で絞る' }],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const b = bucketOf(ctx);
      authorizePc(ctx.env, 's3:ListBucketVersions', bucketArn(b.name), b);
      const all = b.objects.filter((o) => o.key.startsWith(str(ctx, 'prefix') ?? '')).reverse();
      const versions = all.filter((o) => !o.deleteMarker).map((o) => ({ ETag: o.etag, Size: o.size, StorageClass: o.storageClass, Key: o.key, VersionId: o.versionId, IsLatest: o.isLatest, LastModified: iso(o.lastModified) }));
      const markers = all.filter((o) => o.deleteMarker).map((o) => ({ Key: o.key, VersionId: o.versionId, IsLatest: o.isLatest, LastModified: iso(o.lastModified) }));
      return { ...(versions.length ? { Versions: versions } : {}), ...(markers.length ? { DeleteMarkers: markers } : {}), RequestCharged: null, Prefix: str(ctx, 'prefix') ?? '' };
    },
  },
  {
    name: 'head-object',
    desc: 'オブジェクトの情報 (サイズ・更新日時など。本体は取らない)',
    params: [bucketParam, keyParam, { name: 'version-id', type: 'string', desc: 'バージョンを指定する' }],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      try {
        return objectHead(readObject(ctx.env, req(ctx, 'bucket'), req(ctx, 'key'), str(ctx, 'version-id')));
      } catch (e) {
        // HEAD の応答には本文が無いので、理由は HTTP のステータスだけになる
        if (e instanceof AwsError && e.code === 'AccessDenied') throw new AwsError('403', 'Forbidden');
        if (e instanceof AwsError) throw new AwsError('404', 'Not Found');
        throw e;
      }
    },
  },
  {
    name: 'get-object',
    desc: 'オブジェクトを取り出して、手元のファイル (outfile) に保存する',
    params: [bucketParam, keyParam, { name: 'outfile', type: 'string', required: true, positional: true, desc: '保存先のファイル名' }, { name: 'version-id', type: 'string', desc: 'バージョンを指定する' }],
    readOnly: true,
    scope: 'global',
    examples: ['aws s3api get-object --bucket my-bucket --key reports/a.csv a.csv'],
    run(ctx) {
      const outfile = req(ctx, 'outfile');
      const o = readObject(ctx.env, req(ctx, 'bucket'), req(ctx, 'key'), str(ctx, 'version-id'));
      ctx.writeLocal(outfile, o.body ?? '');
      return objectHead(o);
    },
  },
  {
    name: 'put-object',
    desc: '手元のファイル (--body) をオブジェクトとして置く',
    params: [bucketParam, keyParam, { name: 'body', type: 'string', desc: '手元のファイルのパス (file:// は付けない)' }, { name: 'content-type', type: 'string', desc: '例: text/html' }],
    scope: 'global',
    run(ctx) {
      const path = str(ctx, 'body');
      const body = path === undefined ? '' : ctx.readLocal(path);
      if (body === null) throw new ParamError(`Error parsing parameter '--body': Blob values must be a path to a file.`);
      const o = writeObject(ctx.env, req(ctx, 'bucket'), req(ctx, 'key'), body, str(ctx, 'content-type'));
      return { ETag: o.etag, ServerSideEncryption: o.serverSideEncryption, ...(o.versionId !== 'null' ? { VersionId: o.versionId } : {}) };
    },
  },
  {
    name: 'delete-object',
    desc: 'オブジェクトを削除する (バージョニング有効なら削除マーカーが付く。--version-id でそのバージョンを完全に消す)',
    params: [bucketParam, keyParam, { name: 'version-id', type: 'string', desc: '完全に消すバージョン (削除マーカーのバージョンを消すと元に戻る)' }],
    scope: 'global',
    run(ctx) {
      const b = bucketOf(ctx);
      const key = req(ctx, 'key');
      const versionId = str(ctx, 'version-id');
      if (!versionId) {
        removeObject(ctx.env, b.name, key);
        const marker = b.objects.find((o) => o.key === key && o.isLatest && o.deleteMarker);
        return marker ? { DeleteMarker: true, VersionId: marker.versionId } : undefined;
      }
      authorizePc(ctx.env, 's3:DeleteObjectVersion', objectArn(b.name, key), b);
      const v = b.objects.find((o) => o.key === key && o.versionId === versionId);
      if (!v) return { VersionId: versionId };
      b.objects = b.objects.filter((o) => o !== v);
      if (v.isLatest) {
        const prev = b.objects.filter((o) => o.key === key).at(-1);
        if (prev) prev.isLatest = true;
      }
      return { ...(v.deleteMarker ? { DeleteMarker: true } : {}), VersionId: versionId };
    },
  },
];

export default service('s3api', 'Amazon S3 (API をそのまま呼ぶ: バケットの設定・ポリシー・オブジェクト)', ops);
