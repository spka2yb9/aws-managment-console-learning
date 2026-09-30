import { backendOf } from './targets';
import { publicDnsName } from './ec2';
import { targetHealth } from './elb';
import { label } from './env';
import { canConnect, canConnectFromInternet, CLIENT_IP, type Check } from './network';
import { isPolicyPublic, s3GetObject, s3ListObjects } from './s3';
import { certCovers, evaluateWaf, resolve } from './edge';
import { latestObject } from './s3';
import { AwsError, type AwsEnv, type CachedObject, type Distribution, type SimulatedApp, type WebAcl } from './types';

/** virtual-hosted (bucket.s3.region.amazonaws.com/key) or path-style (s3.region.amazonaws.com/bucket/key) */
function s3Target(host: string, path: string): { bucket: string; key: string } | null {
  const v = /^(.+)\.s3(?:[.-]([a-z0-9-]+))?\.amazonaws\.com$/.exec(host);
  if (v) return { bucket: v[1], key: decodeURIComponent(path.slice(1)) };
  if (/^s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host)) {
    const [bucket, ...rest] = path.slice(1).split('/');
    return bucket ? { bucket, key: decodeURIComponent(rest.join('/')) } : null;
  }
  return null;
}

const s3Xml = (code: string, message: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message><RequestId>SIMULATED</RequestId><HostId>simulator</HostId></Error>`;

/** An anonymous browser request to S3: only a bucket policy granting "*" (not blocked by BPA) lets it through. */
function s3Response(env: AwsEnv, url: string, bucket: string, key: string, https: boolean, clientIp: string): HttpResult {
  const b = env.buckets.find((x) => x.name === bucket);
  const checks: Check[] = [{ label: 'バケット', ok: !!b, detail: b ? `${bucket} (${b.region})` : 'このバケットは存在しません' }];
  if (!b) return { url, status: 404, statusText: 'Not Found', body: s3Xml('NoSuchBucket', 'The specified bucket does not exist'), hops: [hop('Internet → Amazon S3', checks)] };
  const pub = isPolicyPublic(b.policy);
  checks.push({ label: 'バケットポリシー', ok: pub, detail: !b.policy ? 'バケットポリシーがありません (匿名アクセスを許可するものがない)' : pub ? 'Principal "*" を許可するステートメントがあります' : '匿名 (Principal "*") を許可するステートメントがありません' });
  checks.push({ label: 'ブロックパブリックアクセス (RestrictPublicBuckets)', ok: !(pub && b.blockPublicAccess.restrictPublicBuckets), detail: b.blockPublicAccess.restrictPublicBuckets ? 'オン: パブリックなバケットポリシーは匿名のリクエストには効きません' : 'オフ' });
  const caller = { principal: { type: 'anonymous' as const }, context: { 'aws:SecureTransport': https, 'aws:SourceIp': clientIp } };
  const hops = [hop('Internet → Amazon S3 (匿名リクエスト)', checks)];
  try {
    if (!key) {
      const r = s3ListObjects(env, caller, bucket);
      return { url, status: 200, statusText: 'OK', body: `<ListBucketResult><Name>${bucket}</Name>${r.objects.map((o) => `<Contents><Key>${o.key}</Key><Size>${o.size}</Size></Contents>`).join('')}</ListBucketResult>`, hops };
    }
    const o = s3GetObject(env, caller, bucket, key);
    return { url, status: 200, statusText: 'OK', body: o.body ?? `(${o.contentType}, ${o.size} bytes)`, hops };
  } catch (e) {
    if (!(e instanceof AwsError)) throw e;
    if (e.code === 'NoSuchKey') return { url, status: 404, statusText: 'Not Found', body: s3Xml('NoSuchKey', 'The specified key does not exist.'), hops };
    return { url, status: 403, statusText: 'Forbidden', body: s3Xml('AccessDenied', 'Access Denied'), hops };
  }
}

export interface HttpEffects {
  cache?: { distributionId: string; entry: CachedObject };
  waf?: { aclArn: string; sample: WebAcl['samples'][number] };
}

export interface Hop {
  hop: string;
  ok: boolean;
  checks: Check[];
}

export interface HttpResult {
  url: string;
  /** undefined when the browser never got an HTTP response */
  status?: number;
  statusText?: string;
  error?: 'ERR_INVALID_URL' | 'ERR_NAME_NOT_RESOLVED' | 'ERR_CONNECTION_TIMED_OUT' | 'ERR_CONNECTION_REFUSED' | 'ERR_SSL_PROTOCOL_ERROR' | 'ERR_CERT_COMMON_NAME_INVALID';
  body: string;
  /** response headers worth showing (CloudFront: X-Cache, Age ...) */
  headers?: Record<string, string>;
  /** state the request changes (an edge cache fill, a WAF sample): the caller applies them */
  effects?: HttpEffects;
  hops: Hop[];
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 301: 'Moved Permanently', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Temporarily Unavailable', 504: 'Gateway Time-out' };

function response(url: string, status: number, body: string, hops: Hop[]): HttpResult {
  return { url, status, statusText: STATUS_TEXT[status], body, hops };
}

function hop(name: string, checks: Check[]): Hop {
  return { hop: name, ok: checks.every((c) => c.ok), checks };
}

/** The simulated app: serves "/" (needs its DB, if any) and its health check path. */
function appResponse(env: AwsEnv, url: string, backend: { id: string; name: string; app?: SimulatedApp }, path: string, hops: Hop[]): HttpResult {
  const app = backend.app!;
  const name = backend.name;
  if (path === app.healthCheckPath) return response(url, 200, 'OK', hops);
  if (path !== '/') return response(url, 404, 'Cannot GET ' + path, hops);
  if (app.dbInstanceIdentifier) {
    const db = env.dbInstances.find((d) => d.dbInstanceIdentifier === app.dbInstanceIdentifier);
    const conn = db ? canConnect(env, backend.id, db.dbInstanceIdentifier, 'tcp', db.port) : { ok: false, checks: [{ label: 'DB', ok: false, detail: `${app.dbInstanceIdentifier} が存在しません` }] };
    hops.push(hop(`${name} → ${app.dbInstanceIdentifier} (TCP ${db?.port ?? '?'})`, conn.checks));
    if (!conn.ok) return response(url, 500, `Internal Server Error\n\nError: connect ETIMEDOUT ${db?.endpointAddress ?? app.dbInstanceIdentifier}:${db?.port ?? ''}\n(アプリがDatabaseに接続できません)`, hops);
  }
  return response(url, 200, `Hello from ${name}${app.version ? `\nwebapp ${app.version}` : ''}${app.dbInstanceIdentifier ? '\nDatabase: connected' : ''}`, hops);
}

/**
 * What the learner's browser gets for `url`, with every hop explained.
 * ALB semantics: no registered/usable targets -> 503; if no target is healthy the ALB "fails open" and still
 * routes to the unhealthy ones; SG blocking LB -> target -> 504; nothing listening on the target port -> 502.
 */
export function simulateHttp(env: AwsEnv, rawUrl: string, clientIp = CLIENT_IP): HttpResult {
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `http://${rawUrl.trim()}`);
  } catch {
    return { url: rawUrl, error: 'ERR_INVALID_URL', body: '', hops: [] };
  }
  const url = u.toString();
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const requestHost = u.hostname.toLowerCase();
  const hops: Hop[] = [];

  // custom domains resolve through Route 53; AWS-provided names (ALB, CloudFront, S3, EC2) resolve to themselves
  let host = requestHost;
  if (env.hostedZones?.some((z) => requestHost === z.name || requestHost.endsWith(`.${z.name}`))) {
    const dns = resolve(env, requestHost);
    hops.push(hop('DNS (Route 53)', dns.steps.map((detail, n) => ({ label: `名前解決 ${n + 1}`, ok: dns.ok || n < dns.steps.length - 1, detail }))));
    if (!dns.ok) return { url, error: 'ERR_NAME_NOT_RESOLVED', body: '', hops };
    host = dns.target!;
  }

  const dist = env.distributions?.find((d) => d.domainName === host);
  if (dist) return cloudFrontResponse(env, u, requestHost, dist, clientIp, hops);

  const s3 = s3Target(host, u.pathname);
  if (s3) return s3Response(env, url, s3.bucket, s3.key, u.protocol === 'https:', clientIp);

  const lb = env.loadBalancers.find((l) => l.dnsName === host);
  if (lb) {
    if (lb.state !== 'active') return { url, error: 'ERR_NAME_NOT_RESOLVED', body: '', hops: [hop('DNS', [{ label: lb.dnsName, ok: false, detail: `ロードバランサーはプロビジョニング中です。アクティブになるまで DNS 名は解決できません` }])] };
    const inbound = canConnectFromInternet(env, lb.loadBalancerArn, 'tcp', port, clientIp);
    const listener = lb.listeners.find((l) => l.port === port);
    hops.push(hop(`Internet → ${lb.loadBalancerName} (TCP ${port})`, [...inbound.checks, { label: 'リスナー', ok: !!listener, detail: listener ? `${listener.protocol}:${listener.port} → 転送` : `ポート ${port} のリスナーがありません` }]));
    if (!inbound.ok) return { url, error: 'ERR_CONNECTION_TIMED_OUT', body: '', hops };
    if (!listener) return { url, error: 'ERR_CONNECTION_REFUSED', body: '', hops };
    if (u.protocol === 'https:') return { url, error: 'ERR_SSL_PROTOCOL_ERROR', body: '', hops };
    const tg = env.targetGroups.find((t) => t.targetGroupArn === listener.targetGroupArn)!;
    const health = tg.targets.map((t) => ({ t, h: targetHealth(env, tg.targetGroupArn, t) }));
    const healthy = health.filter((x) => x.h.state === 'healthy');
    // Fail open: with zero healthy targets, requests go to all unhealthy targets.
    const routable = healthy.length ? healthy : health.filter((x) => x.h.state === 'unhealthy');
    hops.push(
      hop(`${lb.loadBalancerName} → ターゲットグループ ${tg.targetGroupName}`, [
        {
          label: '登録済みターゲット',
          ok: routable.length > 0,
          detail: tg.targets.length
            ? `${health.map((x) => `${x.t.id}:${x.t.port} ${x.h.state}${x.h.reason ? ` (${x.h.reason})` : ''}`).join(', ')}${!healthy.length && routable.length ? ' — 正常 (healthy) なターゲットが無いため、ALB は異常なターゲットにも転送します (fail open)' : ''}`
            : 'ターゲットが登録されていません',
        },
      ]),
    );
    if (!routable.length) return response(url, 503, '503 Service Temporarily Unavailable', hops);
    // requests are spread over the routable targets
    const { t } = routable[Math.floor(Date.now() / 1000) % routable.length];
    const backend = backendOf(env, tg, t)!;
    const conn = canConnect(env, lb.loadBalancerArn, backend.id, 'tcp', t.port);
    const listening = backend.app?.port === t.port;
    hops.push(hop(`${lb.loadBalancerName} → ${backend.name} (TCP ${t.port})`, [...conn.checks, ...(conn.ok ? [{ label: 'アプリケーション', ok: listening, detail: listening ? `ポート ${t.port} で待ち受け中` : `ポート ${t.port} で待ち受けているプロセスがありません (Connection refused)` }] : [])]));
    if (!conn.ok) return response(url, 504, '504 Gateway Time-out', hops);
    if (!listening) return response(url, 502, '502 Bad Gateway', hops);
    return appResponse(env, url, backend, u.pathname, hops);
  }

  const instance = env.instances.find((i) => i.publicIpAddress && (i.publicIpAddress === host || publicDnsName(env, i.publicIpAddress) === host));
  if (instance) {
    const inbound = canConnectFromInternet(env, instance.instanceId, 'tcp', port, clientIp);
    const listening = instance.app?.port === port;
    hops.push(hop(`Internet → ${label(instance.instanceId, instance)} (TCP ${port})`, [...inbound.checks, ...(inbound.ok ? [{ label: 'アプリケーション', ok: listening, detail: listening ? `ポート ${port} で待ち受け中` : `ポート ${port} で待ち受けているプロセスがありません` }] : [])]));
    if (!inbound.ok) return { url, error: 'ERR_CONNECTION_TIMED_OUT', body: '', hops };
    if (!listening) return { url, error: 'ERR_CONNECTION_REFUSED', body: '', hops };
    return appResponse(env, url, { id: instance.instanceId, name: label(instance.instanceId, instance), app: instance.app }, u.pathname, hops);
  }

  return { url, error: 'ERR_NAME_NOT_RESOLVED', body: '', hops: [hop('DNS', [{ label: host, ok: false, detail: 'このホスト名は解決できません (ロードバランサーの DNS 名か EC2 のパブリック IPv4 アドレスを使います)' }])] };
}

const CF_ERROR = (reason: string) => `403 ERROR\nThe request could not be satisfied.\n${reason}\nGenerated by cloudfront (CloudFront)`;

/** bucket policy lets this distribution read (Origin Access Control: Principal Service cloudfront.amazonaws.com) */
function oacAllows(env: AwsEnv, bucket: string, d: Distribution): boolean {
  const b = env.buckets.find((x) => x.name === bucket);
  const st = b?.policy ? (Array.isArray(b.policy.Statement) ? b.policy.Statement : [b.policy.Statement]) : [];
  return st.some((x) => x.Effect === 'Allow' && typeof x.Principal === 'object' && [x.Principal.Service].flat().includes('cloudfront.amazonaws.com') && (!x.Condition || JSON.stringify(x.Condition).includes(d.arn)));
}

/** CloudFront: host / TLS checks, HTTP -> HTTPS redirect, WAF, the edge cache and the origin fetch. */
function cloudFrontResponse(env: AwsEnv, u: URL, requestHost: string, d: Distribution, clientIp: string, hops: Hop[]): HttpResult {
  const url = u.toString();
  const https = u.protocol === 'https:';
  const own = requestHost === d.domainName;
  const pop = 'NRT57-P2';
  const headers = (extra: Record<string, string>) => ({ Via: `1.1 ${d.id.toLowerCase()}.cloudfront.net (CloudFront)`, 'X-Amz-Cf-Pop': pop, ...extra });
  const checks: Check[] = [{ label: 'ディストリビューション', ok: true, detail: `${d.id} (${d.domainName})` }];
  // TLS comes first: a name that is not an alternate domain gets the default *.cloudfront.net certificate
  if (https && !own) {
    const c = d.aliases.includes(requestHost) ? env.certificates.find((x) => x.certificateArn === d.certificateArn) : undefined;
    const ok = !!c && certCovers(c, requestHost);
    checks.push({ label: 'TLS 証明書 (SNI)', ok, detail: c ? `${c.subjectAlternativeNames.join(', ')} ${ok ? `(${requestHost} を含む)` : `: ${requestHost} は含まれていません`}` : `${requestHost} は代替ドメイン名ではないため、既定の証明書 *.cloudfront.net が返されました` });
    if (!ok) {
      hops.push(hop(`Internet → CloudFront (${requestHost}, TLS)`, checks));
      return { url, error: 'ERR_CERT_COMMON_NAME_INVALID', body: '', hops };
    }
  }
  if (!own && !d.aliases.includes(requestHost)) {
    checks.push({ label: '代替ドメイン名 (CNAME)', ok: false, detail: `${requestHost} はこのディストリビューションの代替ドメイン名に登録されていません` });
    hops.push(hop(`Internet → CloudFront (${requestHost})`, checks));
    return { url, status: 403, statusText: 'Forbidden', body: CF_ERROR('Bad request. We can\'t connect to the server for this app or website at this time.'), headers: headers({ 'X-Cache': 'Error from cloudfront' }), hops };
  }
  if (!https && d.viewerProtocolPolicy !== 'allow-all') {
    if (d.viewerProtocolPolicy === 'https-only') {
      hops.push(hop(`Internet → CloudFront (HTTP)`, [...checks, { label: 'ビューワープロトコルポリシー', ok: false, detail: 'HTTPS only: HTTP のリクエストは拒否されます' }]));
      return { url, status: 403, statusText: 'Forbidden', body: CF_ERROR('Bad request.'), headers: headers({}), hops };
    }
    hops.push(hop(`Internet → CloudFront (HTTP)`, [...checks, { label: 'ビューワープロトコルポリシー', ok: true, detail: `Redirect HTTP to HTTPS: 301 → https://${u.host}${u.pathname}` }]));
    const r = simulateHttp(env, `https://${u.host}${u.pathname}${u.search}`, clientIp);
    return { ...r, hops: [...hops, ...r.hops.filter((h) => !h.hop.startsWith('DNS'))] };
  }
  const effects: HttpEffects = {};
  if (d.webAclArn) {
    const acl = env.webAcls.find((a) => a.arn === d.webAclArn);
    if (acl) {
      const w = evaluateWaf(env, acl, { clientIp, method: 'GET', uri: `${u.pathname}${u.search}`, host: requestHost });
      effects.waf = { aclArn: acl.arn, sample: { at: Date.now(), clientIp, method: 'GET', uri: `${u.pathname}${u.search}`, host: requestHost, rule: w.rule, action: w.action } };
      checks.push({ label: `AWS WAF (${acl.name})`, ok: w.action === 'ALLOW', detail: w.rule ? `ルール ${w.rule} に一致 → ${w.action}` : `どのルールにも一致しません → デフォルトアクション ${acl.defaultAction.toUpperCase()}` });
      if (w.action === 'BLOCK') {
        hops.push(hop(`Internet → CloudFront (${requestHost})`, checks));
        return { url, status: 403, statusText: 'Forbidden', body: CF_ERROR("Request blocked. We can't connect to the server for this app or website at this time. There might be too much traffic or a configuration error."), headers: headers({ 'X-Cache': 'Error from cloudfront' }), hops, effects };
      }
    }
  }
  const now = Date.now();
  // the default root object: "/" is fetched and cached as /index.html
  const path = d.origin.kind === 's3' && u.pathname === '/' ? '/index.html' : u.pathname;
  const hit = d.cache.find((c) => c.path === path && now - c.cachedAt < d.defaultTtl * 1000);
  if (hit) {
    const age = Math.floor((now - hit.cachedAt) / 1000);
    hops.push(hop(`Internet → CloudFront (${requestHost})`, [...checks, { label: 'エッジキャッシュ', ok: true, detail: `ヒット: ${age} 秒前にキャッシュしたオブジェクトを返しました (TTL ${d.defaultTtl} 秒)。オリジンには問い合わせていません` }]));
    return { url, status: hit.status, statusText: STATUS_TEXT[hit.status], body: hit.body, headers: headers({ 'X-Cache': 'Hit from cloudfront', Age: String(age) }), hops, effects };
  }
  hops.push(hop(`Internet → CloudFront (${requestHost})`, [...checks, { label: 'エッジキャッシュ', ok: true, detail: 'ミス: オリジンから取得します' }]));
  let status: number;
  let body: string;
  if (d.origin.kind === 's3') {
    const bucket = d.origin.bucket;
    const key = decodeURIComponent(path.slice(1));
    const allowed = oacAllows(env, bucket, d);
    const o = env.buckets.find((b) => b.name === bucket) && latestObject(env.buckets.find((b) => b.name === bucket)!, key);
    hops.push(hop(`CloudFront → S3 (${bucket})`, [{ label: 'オリジンアクセスコントロール (OAC)', ok: allowed, detail: allowed ? 'バケットポリシーがこのディストリビューション (cloudfront.amazonaws.com) の読み取りを許可しています' : 'バケットポリシーが CloudFront からの読み取りを許可していません' }, { label: 'オブジェクト', ok: !!o, detail: o ? `${key} (${o.size} バイト, 最終更新 ${new Date(o.lastModified).toISOString()})` : `${key} はありません` }]));
    if (!allowed) [status, body] = [403, s3Xml('AccessDenied', 'Access Denied')];
    else if (!o) [status, body] = [403, s3Xml('AccessDenied', 'Access Denied')];
    else [status, body] = [200, o.body ?? `(${o.contentType}, ${o.size} bytes)`];
  } else {
    const lbName = d.origin.loadBalancerName;
    const lb = env.loadBalancers.find((l) => l.loadBalancerName === lbName);
    const r = lb ? simulateHttp(env, `http://${lb.dnsName}${u.pathname}${u.search}`, clientIp) : undefined;
    hops.push(...(r?.hops ?? [hop('CloudFront → オリジン', [{ label: 'ALB', ok: false, detail: `${lbName} がありません` }])]));
    [status, body] = r?.status !== undefined ? [r.status, r.body] : [502, CF_ERROR('Bad gateway.')];
  }
  if (status === 200 && d.defaultTtl > 0) effects.cache = { distributionId: d.id, entry: { path, status, body, cachedAt: now } };
  return { url, status, statusText: STATUS_TEXT[status], body, headers: headers({ 'X-Cache': status < 400 ? 'Miss from cloudfront' : 'Error from cloudfront' }), hops, effects };
}
