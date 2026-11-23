/* aws acm — 証明書 (sim/edge.ts)。ACM はリージョンごとのサービス。
   証明書はレッスンのリージョン以外 (CloudFront 用の us-east-1) にも作れるので、scope は 'global' にして ctx.region で自分で絞る */
import { requestCertificate } from '../../../sim/edge';
import { REGIONS } from '../../../sim/env';
import type { AwsEnv, Certificate } from '../../../sim/types';
import { AwsError, iso, req, service, str, strs, type OpContext, type OperationSpec } from '../types';

const YEAR_MS = 395 * 24 * 3600 * 1000;

/** 呼び出し先のリージョン (--region / 設定)。aws.ts は scope: 'global' のリージョンを検査しないので、ここで検査する */
function acmRegion(ctx: OpContext): string {
  if (!ctx.region) throw new Error('You must specify a region. You can also configure your region by running "aws configure".');
  if (!REGIONS.some((r) => r.code === ctx.region)) throw new Error(`Could not connect to the endpoint URL: "https://acm.${ctx.region}.amazonaws.com/"`);
  return ctx.region;
}

/** このリージョンの証明書 (ほかのリージョンの ARN は見つからない) */
function certIn(ctx: OpContext, arn: string): Certificate {
  const region = acmRegion(ctx);
  const c = ctx.env.certificates.find((x) => x.certificateArn === arn && x.region === region);
  if (!c) {
    if (!/^arn:aws:acm:[a-z0-9-]+:\d{12}:certificate\/[\w-]+$/.test(arn)) throw new AwsError('ValidationException', `1 validation error detected: Value '${arn}' at 'certificateArn' failed to satisfy constraint: Member must satisfy regular expression pattern: arn:[\\w+=/,.@-]+:acm:[\\w+=/,.@-]*:[0-9]+:[\\w+=,.@-]+(/[\\w+=,.@-]+)*`);
    throw new AwsError('ResourceNotFoundException', `Could not find certificate ${arn}.`);
  }
  return c;
}

const inUseBy = (env: AwsEnv, c: Certificate) => env.distributions.filter((d) => d.certificateArn === c.certificateArn).map((d) => d.arn);
const issued = (c: Certificate) => c.status === 'ISSUED';

const certOut = (env: AwsEnv, c: Certificate) => ({
  CertificateArn: c.certificateArn,
  DomainName: c.domainName,
  SubjectAlternativeNames: c.subjectAlternativeNames,
  DomainValidationOptions: c.validation.map((v) => ({
    DomainName: v.domainName,
    ValidationDomain: v.domainName,
    ValidationStatus: issued(c) ? 'SUCCESS' : 'PENDING_VALIDATION',
    ResourceRecord: { Name: `${v.cnameName}.`, Type: 'CNAME', Value: `${v.cnameValue}.` },
    ValidationMethod: 'DNS',
  })),
  Subject: `CN=${c.domainName}`,
  Issuer: 'Amazon',
  CreatedAt: iso(c.createdAt),
  ...(issued(c) ? { IssuedAt: iso(c.issuedAt ?? c.createdAt), NotBefore: iso(c.issuedAt ?? c.createdAt), NotAfter: iso((c.issuedAt ?? c.createdAt) + YEAR_MS) } : {}),
  Status: c.status,
  KeyAlgorithm: 'RSA-2048',
  SignatureAlgorithm: 'SHA256WITHRSA',
  InUseBy: inUseBy(env, c),
  Type: 'AMAZON_ISSUED',
  ...(issued(c) ? { KeyUsages: [{ Name: 'DIGITAL_SIGNATURE' }, { Name: 'KEY_ENCIPHERMENT' }], ExtendedKeyUsages: [{ Name: 'TLS_WEB_SERVER_AUTHENTICATION', OID: '1.3.6.1.5.5.7.3.1' }, { Name: 'TLS_WEB_CLIENT_AUTHENTICATION', OID: '1.3.6.1.5.5.7.3.2' }] } : {}),
  RenewalEligibility: issued(c) && inUseBy(env, c).length ? 'ELIGIBLE' : 'INELIGIBLE',
  Options: { CertificateTransparencyLoggingPreference: 'ENABLED' },
});

const summaryOut = (env: AwsEnv, c: Certificate) => ({
  CertificateArn: c.certificateArn,
  DomainName: c.domainName,
  SubjectAlternativeNameSummaries: c.subjectAlternativeNames,
  HasAdditionalSubjectAlternativeNames: false,
  Status: c.status,
  Type: 'AMAZON_ISSUED',
  KeyAlgorithm: 'RSA-2048',
  ...(issued(c) ? { KeyUsages: ['DIGITAL_SIGNATURE', 'KEY_ENCIPHERMENT'], ExtendedKeyUsages: ['TLS_WEB_SERVER_AUTHENTICATION', 'TLS_WEB_CLIENT_AUTHENTICATION'] } : {}),
  InUse: inUseBy(env, c).length > 0,
  RenewalEligibility: issued(c) && inUseBy(env, c).length ? 'ELIGIBLE' : 'INELIGIBLE',
  ...(issued(c) ? { NotBefore: iso(c.issuedAt ?? c.createdAt), NotAfter: iso((c.issuedAt ?? c.createdAt) + YEAR_MS) } : {}),
  CreatedAt: iso(c.createdAt),
  ...(issued(c) ? { IssuedAt: iso(c.issuedAt ?? c.createdAt) } : {}),
});

const ops: OperationSpec[] = [
  {
    name: 'request-certificate',
    desc: '公開用の証明書をリクエストする (リクエストしたリージョンでだけ使える。CloudFront 用は us-east-1)',
    params: [
      { name: 'domain-name', type: 'string', required: true, desc: '証明書で守る名前 (例: example.com、*.example.com)' },
      { name: 'subject-alternative-names', type: 'list', desc: '追加の名前 (空白区切りで複数)' },
      { name: 'validation-method', type: 'string', desc: 'DNS (推奨) か EMAIL。省略すると EMAIL' },
    ],
    scope: 'global',
    examples: ['aws acm request-certificate --domain-name example.com --subject-alternative-names www.example.com --validation-method DNS --region us-east-1'],
    run(ctx) {
      const region = acmRegion(ctx);
      const method = str(ctx, 'validation-method');
      if (method && method !== 'DNS' && method !== 'EMAIL') throw new AwsError('ValidationException', `1 validation error detected: Value '${method}' at 'validationMethod' failed to satisfy constraint: Member must satisfy enum value set: [EMAIL, DNS, HTTP]`);
      if (method !== 'DNS') throw new AwsError('ValidationException', '(シミュレーター) E メール検証には対応していません。--validation-method を省略すると E メール検証になるので、--validation-method DNS を付けてください');
      return { CertificateArn: requestCertificate(ctx.env, { domainName: req(ctx, 'domain-name'), subjectAlternativeNames: strs(ctx, 'subject-alternative-names'), region }, ctx.now) };
    },
  },
  {
    name: 'describe-certificate',
    desc: '証明書の詳細 (名前・ステータス・DNS 検証用の CNAME・使っているリソース)',
    params: [{ name: 'certificate-arn', type: 'string', required: true, desc: '証明書の ARN' }],
    readOnly: true,
    scope: 'global',
    run: (ctx) => ({ Certificate: certOut(ctx.env, certIn(ctx, req(ctx, 'certificate-arn'))) }),
  },
  {
    name: 'list-certificates',
    desc: 'このリージョンの証明書の一覧',
    params: [{ name: 'certificate-statuses', type: 'list', desc: 'ステータスで絞る (PENDING_VALIDATION / ISSUED ...)' }],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const region = acmRegion(ctx);
      const statuses = strs(ctx, 'certificate-statuses');
      return { CertificateSummaryList: ctx.env.certificates.filter((c) => c.region === region && (!statuses.length || statuses.includes(c.status))).map((c) => summaryOut(ctx.env, c)) };
    },
  },
  {
    name: 'wait certificate-validated',
    desc: '証明書が発行済み (ISSUED) になるまで待つ',
    params: [{ name: 'certificate-arn', type: 'string', required: true, desc: '証明書の ARN' }],
    readOnly: true,
    scope: 'global',
    waiter: { until: (ctx) => issued(certIn(ctx, req(ctx, 'certificate-arn'))), delayMs: 3000, maxAttempts: 20 },
    run: () => undefined,
  },
];

export default service('acm', 'AWS Certificate Manager (SSL/TLS 証明書)', ops);
