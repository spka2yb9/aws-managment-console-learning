import { ipInCidr, isValidCidr } from './cidr';
import { trail } from './cloudtrail';
import { hash, newUuid, randomHex, stableChars } from './ids';
import { AwsError, type AwsEnv, type Certificate, type DnsRecord, type Distribution, type HostedZone, type IpSet, type WafRule, type WebAcl } from './types';

/**
 * Route 53, ACM, CloudFront and WAF: what happens between the learner's browser and the ALB / S3.
 * advanceEdge() finishes the slow parts (certificate validation, distribution deployment, invalidations).
 */

const lower = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');
export const alnum = (seed: string, n: number) => stableChars(seed, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', n);
const DEPLOY_MS = 5000;

// ---------------- Route 53 ----------------

export function createHostedZone(env: AwsEnv, name: string, comment?: string, now = Date.now()): string {
  const zone = lower(name);
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(zone)) throw new AwsError('InvalidDomainName', `${name} is not a valid domain name.`);
  if (env.hostedZones.some((z) => z.name === zone)) throw new AwsError('HostedZoneAlreadyExists', `A hosted zone has already been created with the specified caller reference.`);
  const id = `Z${alnum(zone, 13)}`;
  const ns = [0, 1, 2, 3].map((k) => `ns-${hash(zone + k) % 2000}.awsdns-${String(hash(zone + 'n' + k) % 64).padStart(2, '0')}.${['com', 'net', 'org', 'co.uk'][k]}.`);
  env.hostedZones.push({ id, name: zone, comment, createdAt: now, records: [{ name: zone, type: 'NS', ttl: 172800, values: ns }, { name: zone, type: 'SOA', ttl: 900, values: [`${ns[0]} awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400`] }] });
  trail(env, { source: 'route53', name: 'CreateHostedZone', resources: [['AWS::Route53::HostedZone', id]], request: { name: zone, hostedZoneConfig: { comment, privateZone: false } }, response: { hostedZone: { id: `/hostedzone/${id}`, name: `${zone}.` } } });
  return id;
}

export const getZone = (env: AwsEnv, id: string): HostedZone => {
  const z = env.hostedZones.find((x) => x.id === id || x.name === lower(id));
  if (!z) throw new AwsError('NoSuchHostedZone', `No hosted zone found with ID: ${id}`);
  return z;
};

/** the AWS names an alias record can point at */
const aliasTargets = (env: AwsEnv) => [...env.loadBalancers.map((l) => l.dnsName), ...env.distributions.map((d) => d.domainName)];

/** ChangeResourceRecordSets with one change, validated like Route 53 */
export function changeRecord(env: AwsEnv, zoneId: string, action: 'CREATE' | 'UPSERT' | 'DELETE', input: DnsRecord) {
  const z = getZone(env, zoneId);
  const name = lower(input.name);
  const rec: DnsRecord = { ...input, name, values: input.values.map((v) => v.trim()).filter(Boolean) };
  const err = (m: string) => new AwsError('InvalidChangeBatch', `[${m}]`);
  if (name !== z.name && !name.endsWith(`.${z.name}`)) throw err(`RRSet with DNS name ${name}. is not permitted in zone ${z.name}.`);
  const same = z.records.filter((r) => r.name === name);
  const existing = same.find((r) => r.type === rec.type);
  if (action === 'DELETE') {
    if (!existing) throw err(`Tried to delete resource record set [name='${name}.', type='${rec.type}'] but it was not found`);
    z.records = z.records.filter((r) => r !== existing);
  } else {
    if (action === 'CREATE' && existing) throw err(`Tried to create resource record set [name='${name}.', type='${rec.type}'] but it already exists`);
    if (rec.type === 'CNAME' && name === z.name) throw err(`RRSet of type CNAME with DNS name ${name}. is not permitted at apex in zone ${z.name}.`);
    const conflict = same.find((r) => r.type !== rec.type && (r.type === 'CNAME' || rec.type === 'CNAME'));
    if (conflict) throw err(`RRSet of type ${rec.type} with DNS name ${name}. is not permitted because a conflicting RRSet of type ${conflict.type} with the same DNS name already exists in zone ${z.name}.`);
    if (rec.aliasTarget) {
      rec.aliasTarget = lower(rec.aliasTarget);
      if (!aliasTargets(env).includes(rec.aliasTarget)) throw err(`Tried to create an alias that targets ${rec.aliasTarget}., type ${rec.type} in zone ${z.name}, but the alias target name does not lie within the target zone`);
      delete rec.ttl;
      rec.values = [];
    } else if (!rec.values.length) throw err(`Invalid Resource Record: FATAL problem: No resource records given`);
    if (rec.type === 'A' && !rec.aliasTarget && rec.values.some((v) => !/^\d+\.\d+\.\d+\.\d+$/.test(v))) throw err(`Invalid Resource Record: FATAL problem: ARRDATAIllegalIPv4Address (Value is not a valid IPv4 address) encountered with '${rec.values[0]}'`);
    z.records = [...z.records.filter((r) => r !== existing), rec];
  }
  trail(env, { source: 'route53', name: 'ChangeResourceRecordSets', resources: [['AWS::Route53::HostedZone', z.id]], request: { hostedZoneId: z.id, changeBatch: { changes: [{ action, resourceRecordSet: { name: `${name}.`, type: rec.type, ...(rec.aliasTarget ? { aliasTarget: { dNSName: `${rec.aliasTarget}.`, evaluateTargetHealth: false } } : { tTL: rec.ttl ?? 300, resourceRecords: rec.values.map((value) => ({ value })) }) } }] } }, response: { changeInfo: { id: `/change/C${alnum(newUuid(), 13)}`, status: 'PENDING' } } });
}

export interface Resolution {
  ok: boolean;
  /** each step: "www.x -> CNAME -> x", "x -> A (alias) -> dxxxx.cloudfront.net" */
  steps: string[];
  /** the host (AWS DNS name) or IP the name ends at */
  target?: string;
}

/** What a resolver finds for host: Route 53 records first, AWS-provided names as themselves. */
export function resolve(env: AwsEnv, host: string, depth = 0): Resolution {
  const name = lower(host);
  const zone = env.hostedZones.filter((z) => name === z.name || name.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) return /\.(amazonaws\.com|cloudfront\.net)$/.test(name) || /^\d+\.\d+\.\d+\.\d+$/.test(name) ? { ok: true, steps: [], target: name } : { ok: false, steps: [`${name}: このドメインのホストゾーンがありません (NXDOMAIN)`] };
  const records = zone.records.filter((r) => r.name === name);
  const wildcard = zone.records.filter((r) => r.name === `*.${name.split('.').slice(1).join('.')}`);
  const pick = (list: DnsRecord[]) => list.find((r) => r.type === 'A') ?? list.find((r) => r.type === 'CNAME');
  const r = pick(records) ?? pick(wildcard);
  if (!r) return { ok: false, steps: [`${name}: ホストゾーン ${zone.name} に A / CNAME レコードがありません (NXDOMAIN)`] };
  if (r.type === 'CNAME') {
    if (depth > 5) return { ok: false, steps: [`${name}: CNAME がループしています`] };
    const next = resolve(env, r.values[0], depth + 1);
    return { ...next, steps: [`${name} → CNAME → ${lower(r.values[0])}`, ...next.steps] };
  }
  if (r.aliasTarget) return { ok: true, steps: [`${name} → A (エイリアス) → ${r.aliasTarget}`], target: r.aliasTarget };
  return { ok: true, steps: [`${name} → A → ${r.values[0]}`], target: r.values[0] };
}

// ---------------- ACM ----------------

export function requestCertificate(env: AwsEnv, input: { domainName: string; subjectAlternativeNames?: string[]; region: string }, now = Date.now()): string {
  const names = [...new Set([lower(input.domainName), ...(input.subjectAlternativeNames ?? []).map(lower)].filter(Boolean))];
  for (const n of names) if (!/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/.test(n)) throw new AwsError('ValidationException', `The domain name ${n} is not valid.`);
  const arn = `arn:aws:acm:${input.region}:${env.accountId}:certificate/${newUuid()}`;
  env.certificates.push({
    certificateArn: arn,
    domainName: names[0],
    subjectAlternativeNames: names,
    region: input.region,
    status: 'PENDING_VALIDATION',
    // one CNAME per base domain (a wildcard shares its parent's record)
    validation: names.map((n) => ({ domainName: n, cnameName: `_${hash(`${arn}${n.replace(/^\*\./, '')}`).toString(16).padStart(8, '0')}${randomHex(24)}.${n.replace(/^\*\./, '')}`, cnameValue: `_${randomHex(32)}.djqtsrsxkq.acm-validations.aws` })),
    createdAt: now,
  });
  trail(env, { source: 'acm', name: 'RequestCertificate', region: input.region, resources: [['AWS::ACM::Certificate', arn]], request: { domainName: names[0], subjectAlternativeNames: names, validationMethod: 'DNS' }, response: { certificateArn: arn } });
  return arn;
}

export const getCertificate = (env: AwsEnv, arn: string): Certificate => {
  const c = env.certificates.find((x) => x.certificateArn === arn);
  if (!c) throw new AwsError('ResourceNotFoundException', `Could not find certificate ${arn}.`);
  return c;
};

/** DeleteCertificate: refused while a CloudFront distribution uses it (the validation CNAMEs stay in Route 53). */
export function deleteCertificate(env: AwsEnv, arn: string) {
  const c = getCertificate(env, arn);
  const user = env.distributions.find((d) => d.certificateArn === arn);
  if (user) throw new AwsError('ResourceInUseException', `Certificate ${arn} in use by ${user.arn}.`);
  env.certificates = env.certificates.filter((x) => x !== c);
  trail(env, { source: 'acm', name: 'DeleteCertificate', region: c.region, resources: [['AWS::ACM::Certificate', arn]], request: { certificateArn: arn }, response: null });
}

/** "Route 53 でレコードを作成": the validation CNAMEs, in the hosted zones that own the names */
export function createValidationRecords(env: AwsEnv, arn: string) {
  const c = getCertificate(env, arn);
  for (const v of c.validation) {
    const base = v.domainName.replace(/^\*\./, '');
    const zone = env.hostedZones.filter((z) => base === z.name || base.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
    if (zone) changeRecord(env, zone.id, 'UPSERT', { name: v.cnameName, type: 'CNAME', ttl: 300, values: [v.cnameValue] });
  }
}

/** exact name or a one-level wildcard (*.example.com covers www.example.com, not example.com) */
export const certCovers = (c: Certificate, host: string) => c.subjectAlternativeNames.some((n) => n === lower(host) || (n.startsWith('*.') && lower(host).split('.').slice(1).join('.') === n.slice(2)));

// ---------------- CloudFront ----------------

export interface DistributionInput {
  comment?: string;
  origin: Distribution['origin'];
  aliases: string[];
  certificateArn?: string;
  viewerProtocolPolicy: Distribution['viewerProtocolPolicy'];
  defaultTtl: number;
  webAclArn?: string;
}

function checkViewer(env: AwsEnv, input: Pick<DistributionInput, 'aliases' | 'certificateArn' | 'webAclArn'>) {
  const aliases = input.aliases.map(lower).filter(Boolean);
  if (input.certificateArn) {
    const c = env.certificates.find((x) => x.certificateArn === input.certificateArn);
    if (!c || c.region !== 'us-east-1' || c.status !== 'ISSUED') throw new AwsError('InvalidViewerCertificate', "The specified SSL certificate doesn't exist, isn't in us-east-1 region, isn't valid, or doesn't include a valid certificate chain.");
    const bad = aliases.find((a) => !certCovers(c, a));
    if (bad) throw new AwsError('InvalidViewerCertificate', `The certificate that is attached to your distribution doesn't cover the alternate domain name (CNAME) that you're trying to add. For more details, see: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html#alternate-domain-names-requirements (${bad})`);
  } else if (aliases.length) throw new AwsError('InvalidViewerCertificate', 'To add an alternate domain name (CNAME) to a CloudFront distribution, you must attach a trusted certificate that validates your authorization to use the domain name.');
  if (input.webAclArn) {
    const acl = env.webAcls.find((a) => a.arn === input.webAclArn);
    if (!acl || acl.scope !== 'CLOUDFRONT') throw new AwsError('InvalidWebACLId', 'Web ACL is not accessible by the requester or does not exist, or its scope is not CLOUDFRONT.');
  }
  for (const a of aliases) if (env.distributions.some((d) => d.aliases.includes(a) && !input.aliases.includes(a))) throw new AwsError('CNAMEAlreadyExists', `One or more of the CNAMEs you provided are already associated with a different resource.`);
  return aliases;
}

export function createDistribution(env: AwsEnv, input: DistributionInput, now = Date.now()): string {
  const aliases = checkViewer(env, input);
  const id = `E${alnum(newUuid(), 13)}`;
  const domain = `d${randomHex(13).replace(/[0-9]/g, (x) => 'abcdefghij'[Number(x)])}.cloudfront.net`;
  const arn = `arn:aws:cloudfront::${env.accountId}:distribution/${id}`;
  env.distributions.push({ id, arn, domainName: domain, comment: input.comment, enabled: true, status: 'InProgress', statusChangedAt: now, aliases, certificateArn: input.certificateArn, origin: input.origin, viewerProtocolPolicy: input.viewerProtocolPolicy, defaultTtl: input.defaultTtl, webAclArn: input.webAclArn, cache: [], invalidations: [], lastModified: now });
  trail(env, { source: 'cloudfront', name: 'CreateDistribution', region: 'us-east-1', resources: [['AWS::CloudFront::Distribution', arn]], request: { distributionConfig: { aliases: { quantity: aliases.length, items: aliases }, comment: input.comment, enabled: true } }, response: { distribution: { id, domainName: domain, status: 'InProgress' } } });
  return id;
}

export const getDistribution = (env: AwsEnv, id: string): Distribution => {
  const d = env.distributions.find((x) => x.id === id);
  if (!d) throw new AwsError('NoSuchDistribution', 'The specified distribution does not exist.');
  return d;
};

export function updateDistribution(env: AwsEnv, id: string, changes: Partial<DistributionInput>, now = Date.now()) {
  const d = getDistribution(env, id);
  const next = { aliases: changes.aliases ?? d.aliases, certificateArn: 'certificateArn' in changes ? changes.certificateArn : d.certificateArn, webAclArn: 'webAclArn' in changes ? changes.webAclArn : d.webAclArn };
  const aliases = checkViewer(env, next);
  Object.assign(d, changes, { aliases, status: 'InProgress', statusChangedAt: now, lastModified: now });
  trail(env, { source: 'cloudfront', name: 'UpdateDistribution', region: 'us-east-1', resources: [['AWS::CloudFront::Distribution', d.arn]], request: { id, distributionConfig: { aliases: { items: aliases }, ...(changes.defaultTtl !== undefined ? { defaultCacheBehavior: { defaultTTL: changes.defaultTtl } } : {}) } }, response: { distribution: { id, status: 'InProgress' } } });
}

export function createInvalidation(env: AwsEnv, id: string, paths: string[], now = Date.now()): string {
  const d = getDistribution(env, id);
  const clean = paths.map((p) => p.trim()).filter(Boolean);
  if (!clean.length) throw new AwsError('InvalidArgument', 'Your request contains one or more invalid invalidation paths.');
  const bad = clean.find((p) => !p.startsWith('/'));
  if (bad) throw new AwsError('InvalidArgument', `Your request contains one or more invalid invalidation paths. (${bad}: パスは / で始めます)`);
  const inv = { id: `I${alnum(newUuid(), 13)}`, paths: clean, status: 'InProgress' as const, createdAt: now };
  d.invalidations.unshift(inv);
  trail(env, { source: 'cloudfront', name: 'CreateInvalidation', region: 'us-east-1', resources: [['AWS::CloudFront::Distribution', d.arn]], request: { distributionId: id, invalidationBatch: { paths: { quantity: clean.length, items: clean } } }, response: { invalidation: { id: inv.id, status: 'InProgress' } } });
  return inv.id;
}

const pathMatches = (pattern: string, path: string) => (pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern);

// ---------------- WAF ----------------

export const MANAGED_RULE_GROUPS = [
  { name: 'AWSManagedRulesCommonRuleSet', label: 'コアルールセット', description: 'XSS やパストラバーサルなど、一般的な攻撃パターンをブロックします。' },
  { name: 'AWSManagedRulesKnownBadInputsRuleSet', label: '既知の不正な入力', description: 'Log4j (JNDI) など、既知の脆弱性を狙うリクエストをブロックします。' },
];

export function createIpSet(env: AwsEnv, input: { name: string; scope: IpSet['scope']; description?: string; addresses: string[] }): string {
  if (!/^[\w-]{1,128}$/.test(input.name)) throw new AwsError('WAFInvalidParameterException', 'The name is not valid.');
  const bad = input.addresses.find((a) => !isValidCidr(a));
  if (bad) throw new AwsError('WAFInvalidParameterException', `Error reason: The parameter contains formatting that is not valid., field: IP_ADDRESS, parameter: ${bad}`);
  const arn = `arn:aws:wafv2:${input.scope === 'CLOUDFRONT' ? 'us-east-1' : env.region}:${env.accountId}:${input.scope === 'CLOUDFRONT' ? 'global' : 'regional'}/ipset/${input.name}/${newUuid()}`;
  env.ipSets.push({ name: input.name, arn, scope: input.scope, description: input.description, addresses: [...input.addresses] });
  trail(env, { source: 'wafv2', name: 'CreateIPSet', region: 'us-east-1', resources: [['AWS::WAFv2::IPSet', arn]], request: { name: input.name, scope: input.scope, addresses: input.addresses }, response: { summary: { name: input.name, aRN: arn } } });
  return arn;
}

export function updateIpSet(env: AwsEnv, arn: string, addresses: string[]) {
  const s = env.ipSets.find((x) => x.arn === arn);
  if (!s) throw new AwsError('WAFNonexistentItemException', 'The referenced item does not exist.');
  const bad = addresses.find((a) => !isValidCidr(a));
  if (bad) throw new AwsError('WAFInvalidParameterException', `Error reason: The parameter contains formatting that is not valid., field: IP_ADDRESS, parameter: ${bad}`);
  s.addresses = [...addresses];
  trail(env, { source: 'wafv2', name: 'UpdateIPSet', region: 'us-east-1', resources: [['AWS::WAFv2::IPSet', arn]], request: { name: s.name, scope: s.scope, addresses }, response: null });
}

export function createWebAcl(env: AwsEnv, input: { name: string; scope: WebAcl['scope']; defaultAction: WebAcl['defaultAction']; rules: WafRule[] }): string {
  const arn = `arn:aws:wafv2:${input.scope === 'CLOUDFRONT' ? 'us-east-1' : env.region}:${env.accountId}:${input.scope === 'CLOUDFRONT' ? 'global' : 'regional'}/webacl/${input.name}/${newUuid()}`;
  env.webAcls.push({ name: input.name, arn, scope: input.scope, defaultAction: input.defaultAction, rules: [...input.rules].sort((a, b) => a.priority - b.priority), samples: [] });
  trail(env, { source: 'wafv2', name: 'CreateWebACL', region: 'us-east-1', resources: [['AWS::WAFv2::WebACL', arn]], request: { name: input.name, scope: input.scope, defaultAction: { [input.defaultAction.toLowerCase()]: {} }, rules: input.rules.map((r) => ({ name: r.name, priority: r.priority })) }, response: { summary: { aRN: arn } } });
  return arn;
}

export interface WafRequest {
  clientIp: string;
  method: string;
  uri: string;
  host: string;
}

/** first matching rule by priority (Count rules only count); otherwise the default action */
export function evaluateWaf(env: AwsEnv, acl: WebAcl, req: WafRequest): { action: 'ALLOW' | 'BLOCK'; rule?: string; counted: string[] } {
  const counted: string[] = [];
  const u = decodeURIComponent(req.uri).toLowerCase();
  for (const r of acl.rules) {
    const s = r.statement;
    const match =
      s.kind === 'ip-set'
        ? !!env.ipSets.find((x) => x.arn === s.ipSetArn)?.addresses.some((cidr) => ipInCidr(req.clientIp, cidr))
        : s.kind === 'uri-starts-with'
          ? req.uri.startsWith(s.value)
          : s.name === 'AWSManagedRulesCommonRuleSet'
            ? /<script|\.\.\/|%3cscript/.test(u)
            : /\/\.git|jndi:|\/\.env/.test(u);
    if (!match) continue;
    if (r.action === 'Count') counted.push(r.name);
    else return { action: r.action === 'Block' ? 'BLOCK' : 'ALLOW', rule: r.name, counted };
  }
  return { action: acl.defaultAction === 'Block' ? 'BLOCK' : 'ALLOW', counted };
}

export function recordWafSample(env: AwsEnv, aclArn: string, sample: WebAcl['samples'][number]) {
  const acl = env.webAcls.find((a) => a.arn === aclArn);
  if (acl) acl.samples = [sample, ...acl.samples].slice(0, 100);
}

export function storeInCache(env: AwsEnv, distributionId: string, entry: Distribution['cache'][number]) {
  const d = env.distributions.find((x) => x.id === distributionId);
  if (d) d.cache = [...d.cache.filter((c) => c.path !== entry.path), entry];
}

export function advanceEdge(env: AwsEnv, now: number): boolean {
  if (!Number.isFinite(now)) return false;
  let changed = false;
  for (const c of env.certificates ?? []) {
    if (c.status !== 'PENDING_VALIDATION' || now - c.createdAt < DEPLOY_MS) continue;
    // DNS validation succeeds once every validation CNAME resolves to its value
    const validated = c.validation.every((v) => env.hostedZones.some((z) => z.records.some((r) => r.type === 'CNAME' && r.name === lower(v.cnameName) && r.values.map(lower).includes(lower(v.cnameValue)))));
    if (validated) {
      c.status = 'ISSUED';
      c.issuedAt = now;
      changed = true;
    }
  }
  for (const d of env.distributions ?? []) {
    if (d.status === 'InProgress' && now - d.statusChangedAt >= DEPLOY_MS) {
      d.status = 'Deployed';
      changed = true;
    }
    for (const inv of d.invalidations)
      if (inv.status === 'InProgress' && now - inv.createdAt >= 3000) {
        inv.status = 'Completed';
        // "/" also names the default root object (index.html) of an S3 origin
        const paths = d.origin.kind === 's3' ? inv.paths.flatMap((p) => (p === '/' ? [p, '/index.html'] : [p])) : inv.paths;
        d.cache = d.cache.filter((c) => !paths.some((p) => pathMatches(p, c.path)));
        changed = true;
      }
  }
  return changed;
}
