/* aws cloudfront — ディストリビューションと無効化 (sim/edge.ts)。CloudFront はグローバルなサービス */
import { alnum, createInvalidation, getDistribution, updateDistribution, type DistributionInput } from '../../../sim/edge';
import type { AwsEnv, Distribution } from '../../../sim/types';
import { AwsError, iso, req, service, str, strs, struct, type OperationSpec, ParamError } from '../types';

/* ETag は設定が変わるたびに変わる (update-distribution の --if-match に渡す) */
export const etagOf = (d: Distribution) => `E${alnum(`${d.id}:${d.lastModified}`, 13)}`;

const q = <T>(items: T[]) => (items.length ? { Quantity: items.length, Items: items } : { Quantity: 0 });

function originOut(env: AwsEnv, d: Distribution) {
  if (d.origin.kind === 's3') {
    const domain = `${d.origin.bucket}.s3.${env.region}.amazonaws.com`;
    return { Id: domain, DomainName: domain, OriginPath: '', CustomHeaders: q([]), S3OriginConfig: { OriginAccessIdentity: '' }, ConnectionAttempts: 3, ConnectionTimeout: 10, OriginShield: { Enabled: false }, OriginAccessControlId: `E${alnum(d.id + 'oac', 13)}` };
  }
  const name = d.origin.loadBalancerName;
  const domain = env.loadBalancers.find((l) => l.loadBalancerName === name)?.dnsName ?? name;
  return {
    Id: domain,
    DomainName: domain,
    OriginPath: '',
    CustomHeaders: q([]),
    CustomOriginConfig: { HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: 'http-only', OriginSslProtocols: q(['TLSv1.2']), OriginReadTimeout: 30, OriginKeepaliveTimeout: 5 },
    ConnectionAttempts: 3,
    ConnectionTimeout: 10,
    OriginShield: { Enabled: false },
    OriginAccessControlId: '',
  };
}

const viewerCertOut = (d: Distribution) =>
  d.certificateArn
    ? { ACMCertificateArn: d.certificateArn, SSLSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021', Certificate: d.certificateArn, CertificateSource: 'acm' }
    : { CloudFrontDefaultCertificate: true, SSLSupportMethod: 'vip', MinimumProtocolVersion: 'TLSv1', CertificateSource: 'cloudfront' };

const cacheBehaviorOut = (env: AwsEnv, d: Distribution) => ({
  TargetOriginId: originOut(env, d).Id,
  TrustedSigners: { Enabled: false, Quantity: 0 },
  TrustedKeyGroups: { Enabled: false, Quantity: 0 },
  ViewerProtocolPolicy: d.viewerProtocolPolicy,
  AllowedMethods: { ...q(['HEAD', 'GET']), CachedMethods: q(['HEAD', 'GET']) },
  SmoothStreaming: false,
  Compress: true,
  LambdaFunctionAssociations: q([]),
  FunctionAssociations: q([]),
  FieldLevelEncryptionId: '',
  ForwardedValues: { QueryString: false, Cookies: { Forward: 'none' }, Headers: q([]), QueryStringCacheKeys: q([]) },
  MinTTL: 0,
  DefaultTTL: d.defaultTtl,
  MaxTTL: Math.max(31536000, d.defaultTtl),
});

/* DistributionConfig のキー (この順で返す。update-distribution で知らないキーはエラー) */
const CONFIG_KEYS = ['CallerReference', 'Aliases', 'DefaultRootObject', 'Origins', 'OriginGroups', 'DefaultCacheBehavior', 'CacheBehaviors', 'CustomErrorResponses', 'Comment', 'Logging', 'PriceClass', 'Enabled', 'ViewerCertificate', 'Restrictions', 'WebACLId', 'HttpVersion', 'IsIPV6Enabled', 'ContinuousDeploymentPolicyId', 'Staging'];
const REQUIRED_KEYS = ['CallerReference', 'Origins', 'DefaultCacheBehavior', 'Comment', 'Enabled'];

const configOut = (env: AwsEnv, d: Distribution) => ({
  CallerReference: alnum(`${d.id}:caller`, 12).toLowerCase(),
  Aliases: q(d.aliases),
  DefaultRootObject: d.origin.kind === 's3' ? 'index.html' : '',
  Origins: q([originOut(env, d)]),
  OriginGroups: q([]),
  DefaultCacheBehavior: cacheBehaviorOut(env, d),
  CacheBehaviors: q([]),
  CustomErrorResponses: q([]),
  Comment: d.comment ?? '',
  Logging: { Enabled: false, IncludeCookies: false, Bucket: '', Prefix: '' },
  PriceClass: 'PriceClass_All',
  Enabled: d.enabled,
  ViewerCertificate: viewerCertOut(d),
  Restrictions: { GeoRestriction: { RestrictionType: 'none', Quantity: 0 } },
  WebACLId: d.webAclArn ?? '',
  HttpVersion: 'http2',
  IsIPV6Enabled: true,
  ContinuousDeploymentPolicyId: '',
  Staging: false,
});

const distOut = (env: AwsEnv, d: Distribution) => ({
  Id: d.id,
  ARN: d.arn,
  Status: d.status,
  LastModifiedTime: iso(d.lastModified),
  InProgressInvalidationBatches: d.invalidations.filter((i) => i.status === 'InProgress').length,
  DomainName: d.domainName,
  ActiveTrustedSigners: { Enabled: false, Quantity: 0 },
  ActiveTrustedKeyGroups: { Enabled: false, Quantity: 0 },
  DistributionConfig: configOut(env, d),
});

function summaryOut(env: AwsEnv, d: Distribution) {
  const c = configOut(env, d);
  return {
    Id: d.id,
    ARN: d.arn,
    ETag: etagOf(d),
    Status: d.status,
    LastModifiedTime: iso(d.lastModified),
    DomainName: d.domainName,
    Aliases: c.Aliases,
    Origins: c.Origins,
    OriginGroups: c.OriginGroups,
    DefaultCacheBehavior: c.DefaultCacheBehavior,
    CacheBehaviors: c.CacheBehaviors,
    CustomErrorResponses: c.CustomErrorResponses,
    Comment: c.Comment,
    PriceClass: c.PriceClass,
    Enabled: c.Enabled,
    ViewerCertificate: c.ViewerCertificate,
    Restrictions: c.Restrictions,
    WebACLId: c.WebACLId,
    HttpVersion: c.HttpVersion,
    IsIPV6Enabled: c.IsIPV6Enabled,
    Staging: false,
  };
}

type Invalidation = Distribution['invalidations'][number];
const invOut = (i: Invalidation) => ({ Id: i.id, Status: i.status, CreateTime: iso(i.createdAt), InvalidationBatch: { Paths: q(i.paths), CallerReference: `cli-${Math.floor(i.createdAt / 1000)}-${alnum(i.id, 6).toLowerCase()}` } });

function getInvalidation(env: AwsEnv, distId: string, id: string): Invalidation {
  const i = getDistribution(env, distId).invalidations.find((x) => x.id === id);
  if (!i) throw new AwsError('NoSuchInvalidation', 'The specified invalidation does not exist.');
  return i;
}

/* boto の Parameter validation failed (クライアント側の検査) */
function paramError(lines: string[]): never {
  throw new ParamError(`Parameter validation failed:\n${lines.join('\n')}`);
}

/** update-distribution の --distribution-config を sim の変更へ (DistributionConfig を丸ごと置き換える) */
function configIn(cfg: Record<string, unknown>): Partial<DistributionInput> {
  const errors = [
    ...REQUIRED_KEYS.filter((k) => cfg[k] === undefined).map((k) => `Missing required parameter in DistributionConfig: "${k}"`),
    ...Object.keys(cfg).filter((k) => !CONFIG_KEYS.includes(k)).map((k) => `Unknown parameter in DistributionConfig: "${k}", must be one of: ${CONFIG_KEYS.join(', ')}`),
  ];
  if (errors.length) paramError(errors);
  const aliases = (cfg.Aliases ?? { Quantity: 0 }) as { Quantity?: number; Items?: unknown[] };
  const items = (aliases.Items ?? []).map(String);
  if (Number(aliases.Quantity) !== items.length) throw new AwsError('InconsistentQuantities', "The value of Quantity and the size of Items don't match.");
  const vc = (cfg.ViewerCertificate ?? { CloudFrontDefaultCertificate: true }) as Record<string, unknown>;
  const cert = vc.CloudFrontDefaultCertificate === true ? undefined : String(vc.ACMCertificateArn ?? vc.Certificate ?? '') || undefined;
  const behavior = cfg.DefaultCacheBehavior as Record<string, unknown>;
  const policy = String(behavior.ViewerProtocolPolicy ?? '');
  if (!['allow-all', 'redirect-to-https', 'https-only'].includes(policy)) paramError([`Invalid value for parameter DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy, value: ${policy}, valid values: allow-all, https-only, redirect-to-https`]);
  return {
    aliases: items,
    certificateArn: cert,
    webAclArn: String(cfg.WebACLId ?? '') || undefined,
    comment: String(cfg.Comment),
    viewerProtocolPolicy: policy as Distribution['viewerProtocolPolicy'],
    defaultTtl: behavior.DefaultTTL === undefined ? 86400 : Math.max(0, Number(behavior.DefaultTTL) || 0),
  };
}

const distId = { name: 'id', type: 'string', required: true, desc: 'ディストリビューションの ID (E…)' } as const;

const ops: OperationSpec[] = [
  {
    name: 'list-distributions',
    desc: 'ディストリビューションの一覧 (ID・ドメイン名・代替ドメイン名・状態)',
    params: [],
    readOnly: true,
    scope: 'global',
    run: (ctx) => ({ DistributionList: { Items: ctx.env.distributions.map((d) => summaryOut(ctx.env, d)) } }),
  },
  {
    name: 'get-distribution',
    desc: 'ディストリビューションの状態と設定',
    params: [distId],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const d = getDistribution(ctx.env, req(ctx, 'id'));
      return { ETag: etagOf(d), Distribution: distOut(ctx.env, d) };
    },
  },
  {
    name: 'get-distribution-config',
    desc: 'ディストリビューションの設定 (DistributionConfig) と ETag。update-distribution の元にする',
    params: [distId],
    readOnly: true,
    scope: 'global',
    examples: ['aws cloudfront get-distribution-config --id E1234567890ABC --query DistributionConfig > dist-config.json'],
    run(ctx) {
      const d = getDistribution(ctx.env, req(ctx, 'id'));
      return { ETag: etagOf(d), DistributionConfig: configOut(ctx.env, d) };
    },
  },
  {
    name: 'update-distribution',
    desc: 'ディストリビューションの設定を置き換える (get-distribution-config の DistributionConfig を直して渡す)',
    params: [
      distId,
      { name: 'distribution-config', type: 'structure', required: true, desc: '設定の全体 (file://dist-config.json)' },
      { name: 'if-match', type: 'string', desc: 'get-distribution-config で取った ETag' },
    ],
    scope: 'global',
    examples: ['aws cloudfront update-distribution --id E1234567890ABC --if-match E2QWRUHEXAMPLE --distribution-config file://dist-config.json'],
    run(ctx) {
      const d = getDistribution(ctx.env, req(ctx, 'id'));
      const changes = configIn(struct(ctx, 'distribution-config') ?? {});
      const etag = str(ctx, 'if-match');
      if (!etag) throw new AwsError('InvalidIfMatchVersion', 'The If-Match version is missing or not valid for the resource.');
      if (etag !== etagOf(d)) throw new AwsError('PreconditionFailed', "The request failed because it didn't meet the preconditions in one or more request-header fields.");
      updateDistribution(ctx.env, d.id, changes, ctx.now);
      return { ETag: etagOf(d), Distribution: distOut(ctx.env, d) };
    },
  },
  {
    name: 'create-invalidation',
    desc: 'エッジのキャッシュからファイルを消す (無効化)',
    params: [
      { name: 'distribution-id', type: 'string', required: true, desc: 'ディストリビューションの ID' },
      { name: 'paths', type: 'list', desc: '消すパス (/ で始める。空白区切りで複数。/* はシェルに展開されないよう引用符で囲む)' },
      { name: 'invalidation-batch', type: 'structure', desc: '{"Paths": {"Quantity": 1, "Items": ["/index.html"]}, "CallerReference": "..."}' },
    ],
    scope: 'global',
    examples: ["aws cloudfront create-invalidation --distribution-id E1234567890ABC --paths /index.html", "aws cloudfront create-invalidation --distribution-id E1234567890ABC --paths '/*'"],
    run(ctx) {
      const batch = struct(ctx, 'invalidation-batch');
      const paths = batch ? ((batch.Paths as { Items?: unknown[] } | undefined)?.Items ?? []).map(String) : strs(ctx, 'paths');
      if (!batch && ctx.p.paths === undefined) throw new ParamError('aws: error: Either --paths or --invalidation-batch is required');
      const distributionId = req(ctx, 'distribution-id');
      const id = createInvalidation(ctx.env, distributionId, paths, ctx.now);
      return { Location: `https://cloudfront.amazonaws.com/2020-05-31/distribution/${distributionId}/invalidation/${id}`, Invalidation: invOut(getInvalidation(ctx.env, distributionId, id)) };
    },
  },
  {
    name: 'list-invalidations',
    desc: '無効化の一覧 (新しい順)',
    params: [{ name: 'distribution-id', type: 'string', required: true, desc: 'ディストリビューションの ID' }],
    readOnly: true,
    scope: 'global',
    run: (ctx) => ({ InvalidationList: { Items: getDistribution(ctx.env, req(ctx, 'distribution-id')).invalidations.map((i) => ({ Id: i.id, CreateTime: iso(i.createdAt), Status: i.status })) } }),
  },
  {
    name: 'get-invalidation',
    desc: '無効化の状態 (InProgress → Completed) とパス',
    params: [
      { name: 'distribution-id', type: 'string', required: true, desc: 'ディストリビューションの ID' },
      { name: 'id', type: 'string', required: true, desc: '無効化の ID (I…)' },
    ],
    readOnly: true,
    scope: 'global',
    run: (ctx) => ({ Invalidation: invOut(getInvalidation(ctx.env, req(ctx, 'distribution-id'), req(ctx, 'id'))) }),
  },
  {
    name: 'wait distribution-deployed',
    desc: 'ディストリビューションの変更が全エッジに配られる (Status が Deployed になる) まで待つ',
    params: [distId],
    readOnly: true,
    scope: 'global',
    waiter: { until: (ctx) => getDistribution(ctx.env, req(ctx, 'id')).status === 'Deployed', delayMs: 2000, maxAttempts: 35 },
    run: () => undefined,
  },
  {
    name: 'wait invalidation-completed',
    desc: '無効化が終わる (Status が Completed になる) まで待つ',
    params: [
      { name: 'distribution-id', type: 'string', required: true, desc: 'ディストリビューションの ID' },
      { name: 'id', type: 'string', required: true, desc: '無効化の ID (I…)' },
    ],
    readOnly: true,
    scope: 'global',
    waiter: { until: (ctx) => getInvalidation(ctx.env, req(ctx, 'distribution-id'), req(ctx, 'id')).status === 'Completed', delayMs: 2000, maxAttempts: 30 },
    run: () => undefined,
  },
];

export default service('cloudfront', 'Amazon CloudFront (CDN: ディストリビューションとキャッシュ)', ops);
