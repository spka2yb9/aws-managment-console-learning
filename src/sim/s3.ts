import { randomHex } from './ids';
import { trail } from './cloudtrail';
import { accessDeniedMessage, evaluateIamPermission, list, parsePolicy, statements, type IamDecision, type RequestPrincipal } from './iam';
import { AwsError, type AwsEnv, type BlockPublicAccess, type Bucket, type PolicyDocument, type S3Object } from './types';

/** Names "someone else" already owns: bucket names are global across all AWS accounts. */
const TAKEN = new Set(['test', 'bucket', 'my-bucket', 'mybucket', 'example', 'data', 'logs', 'backup', 'images', 'static', 'assets', 'aws']);

export const BPA_ALL_ON: BlockPublicAccess = { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true };

export const bucketArn = (b: string) => `arn:aws:s3:::${b}`;
export const objectArn = (b: string, k: string) => `arn:aws:s3:::${b}/${k}`;
export const bucketHost = (b: Pick<Bucket, 'name' | 'region'>) => `${b.name}.s3.${b.region}.amazonaws.com`;
export const objectUrl = (b: Pick<Bucket, 'name' | 'region'>, key: string) => `https://${bucketHost(b)}/${key.split('/').map(encodeURIComponent).join('/')}`;

export function getBucket(env: AwsEnv, name: string): Bucket {
  const b = env.buckets.find((x) => x.name === name);
  if (!b) throw new AwsError('NoSuchBucket', 'The specified bucket does not exist');
  return b;
}

/** Bucket naming rules (general purpose buckets). Returns the first violated rule, or null. */
export function bucketNameProblem(name: string): string | null {
  if (name.length < 3 || name.length > 63) return 'バケット名は 3〜63 文字にする必要があります。';
  if (/[A-Z]/.test(name)) return 'バケット名に大文字を含めることはできません。';
  if (!/^[a-z0-9.-]+$/.test(name)) return 'バケット名に使用できるのは、小文字、数字、ドット (.)、ハイフン (-) のみです。';
  if (!/^[a-z0-9].*[a-z0-9]$/.test(name)) return 'バケット名の先頭と末尾は文字または数字にする必要があります。';
  if (name.includes('..')) return 'バケット名に連続したドットを含めることはできません。';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return 'バケット名を IP アドレスの形式にすることはできません。';
  if (name.startsWith('xn--') || name.startsWith('sthree-') || name.endsWith('-s3alias') || name.endsWith('--ol-s3')) return 'バケット名に予約済みのプレフィックスまたはサフィックスは使用できません。';
  return null;
}

export function createBucket(env: AwsEnv, input: { name: string; region?: string; versioning?: boolean; sseAlgorithm?: 'AES256' | 'aws:kms'; blockPublicAccess?: BlockPublicAccess }, now = Date.now()): string {
  const problem = bucketNameProblem(input.name);
  if (problem) throw new AwsError('InvalidBucketName', `The specified bucket is not valid. (${problem})`);
  if (env.buckets.some((b) => b.name === input.name)) throw new AwsError('BucketAlreadyOwnedByYou', 'Your previous request to create the named bucket succeeded and you already own it.');
  if (TAKEN.has(input.name))
    throw new AwsError('BucketAlreadyExists', 'The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.');
  env.buckets.push({
    name: input.name,
    region: input.region ?? env.region,
    creationDate: new Date(now).toISOString(),
    // Since April 2023 new buckets block all public access and are encrypted with SSE-S3 by default.
    blockPublicAccess: { ...(input.blockPublicAccess ?? BPA_ALL_ON) },
    versioning: input.versioning ? 'Enabled' : 'Disabled',
    encryption: { sseAlgorithm: input.sseAlgorithm ?? 'AES256', bucketKeyEnabled: true },
    objects: [],
    tags: [],
  });
  trail(env, { source: 's3', name: 'CreateBucket', region: input.region ?? env.region, resources: [['AWS::S3::Bucket', input.name]], request: { bucketName: input.name, Host: `${input.name}.s3.${input.region ?? env.region}.amazonaws.com` }, response: null });
  return input.name;
}

export function deleteBucket(env: AwsEnv, name: string) {
  const b = getBucket(env, name);
  if (b.objects.length) throw new AwsError('BucketNotEmpty', 'The bucket you tried to delete is not empty');
  env.buckets = env.buckets.filter((x) => x !== b);
  trail(env, { source: 's3', name: 'DeleteBucket', region: b.region, resources: [['AWS::S3::Bucket', name]], request: { bucketName: name }, response: null });
}

/**
 * A policy is "public" when some Allow statement grants "*" without a condition that pins the caller down
 * (source IP / VPC endpoint / org / account). That is what Block Public Access looks for.
 */
export function isPolicyPublic(doc: PolicyDocument | undefined): boolean {
  if (!doc) return false;
  const pinning = ['aws:sourceip', 'aws:sourcevpce', 'aws:sourcevpc', 'aws:principalorgid', 'aws:principalaccount', 'aws:sourceaccount', 'aws:sourcearn'];
  return statements(doc).some((st) => {
    if (st.Effect !== 'Allow') return false;
    const star = st.Principal === '*' || (typeof st.Principal === 'object' && list(st.Principal.AWS).includes('*'));
    if (!star) return false;
    const keys = Object.values(st.Condition ?? {}).flatMap((kv) => Object.keys(kv).map((k) => k.toLowerCase()));
    return !keys.some((k) => pinning.includes(k));
  });
}

export function putBucketPolicy(env: AwsEnv, bucket: string, text: string, callerArn: string) {
  const b = getBucket(env, bucket);
  const doc = parsePolicy(text, 'resource', { bucket });
  if (isPolicyPublic(doc) && b.blockPublicAccess.blockPublicPolicy)
    throw new AwsError('AccessDenied', `User: ${callerArn} is not authorized to perform: s3:PutBucketPolicy on resource: "${bucketArn(bucket)}" because public policies are blocked by the BlockPublicPolicy block public access setting.`);
  b.policy = doc;
  trail(env, { source: 's3', name: 'PutBucketPolicy', region: b.region, resources: [['AWS::S3::Bucket', bucket]], request: { bucketName: bucket, policy: doc }, response: null });
}

export function deleteBucketPolicy(env: AwsEnv, bucket: string) {
  const b = getBucket(env, bucket);
  delete b.policy;
  trail(env, { source: 's3', name: 'DeleteBucketPolicy', region: b.region, resources: [['AWS::S3::Bucket', bucket]], request: { bucketName: bucket }, response: null });
}

export function putPublicAccessBlock(env: AwsEnv, bucket: string, bpa: BlockPublicAccess) {
  const b = getBucket(env, bucket);
  b.blockPublicAccess = { ...bpa };
  trail(env, { source: 's3', name: 'PutBucketPublicAccessBlock', region: b.region, resources: [['AWS::S3::Bucket', bucket]], request: { bucketName: bucket, PublicAccessBlockConfiguration: { BlockPublicAcls: bpa.blockPublicAcls, IgnorePublicAcls: bpa.ignorePublicAcls, BlockPublicPolicy: bpa.blockPublicPolicy, RestrictPublicBuckets: bpa.restrictPublicBuckets } }, response: null });
}

export function putBucketVersioning(env: AwsEnv, bucket: string, status: 'Enabled' | 'Suspended') {
  const b = getBucket(env, bucket);
  if (status === 'Suspended' && b.versioning === 'Disabled') return;
  b.versioning = status;
  trail(env, { source: 's3', name: 'PutBucketVersioning', region: b.region, resources: [['AWS::S3::Bucket', bucket]], request: { bucketName: bucket, VersioningConfiguration: { Status: status } }, response: null });
}

export function putBucketEncryption(env: AwsEnv, bucket: string, sseAlgorithm: 'AES256' | 'aws:kms', bucketKeyEnabled = true) {
  const b = getBucket(env, bucket);
  b.encryption = { sseAlgorithm, bucketKeyEnabled };
  trail(env, { source: 's3', name: 'PutBucketEncryption', region: b.region, resources: [['AWS::S3::Bucket', bucket]], request: { bucketName: bucket, ServerSideEncryptionConfiguration: { Rule: { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: sseAlgorithm }, BucketKeyEnabled: bucketKeyEnabled } } }, response: null });
}

export function latestObject(b: Bucket, key: string): S3Object | undefined {
  const o = b.objects.find((x) => x.key === key && x.isLatest);
  return o && !o.deleteMarker ? o : undefined;
}

/** Current (non-deleted) objects, one per key. */
export function currentObjects(b: Bucket): S3Object[] {
  return b.objects.filter((o) => o.isLatest && !o.deleteMarker);
}

export function putObject(env: AwsEnv, bucket: string, key: string, attrs: { size: number; contentType?: string; body?: string }, now = Date.now()): S3Object {
  const b = getBucket(env, bucket);
  if (!key || key.length > 1024) throw new AwsError('KeyTooLongError', 'Your key is too long');
  const versioned = b.versioning === 'Enabled';
  if (versioned) b.objects.forEach((o) => o.key === key && (o.isLatest = false));
  else b.objects = b.objects.filter((o) => !(o.key === key && o.versionId === 'null'));
  const o: S3Object = {
    key,
    versionId: versioned ? randomHex(32) : 'null',
    isLatest: true,
    size: attrs.size,
    lastModified: new Date(now).toISOString(),
    etag: `"${randomHex(32)}"`,
    storageClass: 'STANDARD',
    contentType: attrs.contentType ?? (key.endsWith('.csv') ? 'text/csv' : key.endsWith('.html') ? 'text/html' : key.endsWith('.png') ? 'image/png' : key.endsWith('.json') ? 'application/json' : 'binary/octet-stream'),
    serverSideEncryption: b.encryption.sseAlgorithm,
    body: attrs.body,
  };
  b.objects.push(o);
  return o;
}

/** Unversioned: removes the object. Versioned: adds a delete marker (older versions stay restorable). */
export function deleteObject(env: AwsEnv, bucket: string, key: string, now = Date.now()) {
  const b = getBucket(env, bucket);
  if (b.versioning === 'Disabled') {
    b.objects = b.objects.filter((o) => o.key !== key);
    return;
  }
  if (!latestObject(b, key)) return;
  b.objects.forEach((o) => o.key === key && (o.isLatest = false));
  b.objects.push({ key, versionId: randomHex(32), isLatest: true, deleteMarker: true, size: 0, lastModified: new Date(now).toISOString(), etag: '', storageClass: 'STANDARD', contentType: '', serverSideEncryption: b.encryption.sseAlgorithm });
}

// ---------- authorized data plane (used by the EC2 CLI and the simulated browser) ----------

export interface S3Caller {
  principal: RequestPrincipal;
  context: Record<string, string | boolean>;
}

/** Authorize one S3 action; throws AccessDenied exactly the way S3 words it. */
export function authorize(env: AwsEnv, caller: S3Caller, action: string, resource: string, b?: Bucket): IamDecision {
  let policy = b?.policy;
  // RestrictPublicBuckets: a public bucket policy only works for principals of the owner account (and AWS services).
  if (b && policy && isPolicyPublic(policy) && b.blockPublicAccess.restrictPublicBuckets && caller.principal.type === 'anonymous') policy = undefined;
  const d = evaluateIamPermission(env, { principal: caller.principal, action, resource, resourcePolicy: policy, context: caller.context });
  if (d.decision !== 'Allow') throw new AwsError('AccessDenied', accessDeniedMessage(action, resource, d));
  return d;
}

export function s3ListBuckets(env: AwsEnv, caller: S3Caller): Bucket[] {
  authorize(env, caller, 's3:ListAllMyBuckets', 'arn:aws:s3:::*');
  return env.buckets;
}

export function s3ListObjects(env: AwsEnv, caller: S3Caller, bucket: string, prefix = ''): { prefixes: string[]; objects: S3Object[] } {
  const b = getBucket(env, bucket);
  authorize(env, { ...caller, context: { ...caller.context, 's3:prefix': prefix } }, 's3:ListBucket', bucketArn(bucket), b);
  const under = currentObjects(b).filter((o) => o.key.startsWith(prefix));
  const prefixes = [...new Set(under.map((o) => o.key.slice(prefix.length)).filter((k) => k.includes('/')).map((k) => prefix + k.split('/')[0] + '/'))];
  return { prefixes, objects: under.filter((o) => !o.key.slice(prefix.length).includes('/')) };
}

/** GetObject. A missing key is 404 only for callers allowed to s3:ListBucket, otherwise S3 answers 403. */
export function s3GetObject(env: AwsEnv, caller: S3Caller, bucket: string, key: string): S3Object {
  const b = getBucket(env, bucket);
  authorize(env, caller, 's3:GetObject', objectArn(bucket, key), b);
  const o = latestObject(b, key);
  if (o) return o;
  try {
    authorize(env, caller, 's3:ListBucket', bucketArn(bucket), b);
  } catch {
    throw new AwsError('AccessDenied', 'Access Denied');
  }
  throw new AwsError('NoSuchKey', 'The specified key does not exist.');
}

export function s3PutObject(env: AwsEnv, caller: S3Caller, bucket: string, key: string, attrs: { size: number; contentType?: string; body?: string }): S3Object {
  const b = getBucket(env, bucket);
  authorize(env, caller, 's3:PutObject', objectArn(bucket, key), b);
  return putObject(env, bucket, key, attrs);
}

export function s3DeleteObject(env: AwsEnv, caller: S3Caller, bucket: string, key: string) {
  const b = getBucket(env, bucket);
  authorize(env, caller, 's3:DeleteObject', objectArn(bucket, key), b);
  deleteObject(env, bucket, key);
}
