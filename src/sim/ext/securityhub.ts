// AWS Security Hub CSPM (lesson 44): standards, controls, findings in ASFF (workflow status, notes), automation rules.
// The state lives in AwsEnv as an optional field (sessions saved by older versions don't have it).
//
// Like AWS Config (config.ts), every control is evaluated from the current env. Findings are stored, though, because
// they carry state of their own (workflow status, notes, severity changed by people or rules): checkControls() creates
// or updates them whenever a check's result or the checked resource changes ("change triggered"), which is also when
// automation rules run. It runs on every clock tick (advanceSecurityHub) and before every Security Hub API call.
import { trail, type EventSource } from '../cloudtrail';
import { stableChars } from '../ids';
import { AwsError, type AwsEnv, type PolicyStatement, type SecurityGroup, type SecurityGroupRule, type Tag } from '../types';

export type SeverityLabel = 'INFORMATIONAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export const SEVERITIES: SeverityLabel[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'];
/** Severity.Normalized for a label (what Security Hub fills in when only the label is given) */
export const NORMALIZED: Record<SeverityLabel, number> = { INFORMATIONAL: 0, LOW: 1, MEDIUM: 40, HIGH: 70, CRITICAL: 90 };
export type WorkflowStatus = 'NEW' | 'NOTIFIED' | 'SUPPRESSED' | 'RESOLVED';
export const WORKFLOW_STATUSES: WorkflowStatus[] = ['NEW', 'NOTIFIED', 'SUPPRESSED', 'RESOLVED'];
export type ComplianceStatus = 'PASSED' | 'FAILED' | 'WARNING' | 'NOT_AVAILABLE';
/** the console's control status (derived from the control's findings) */
export type ControlStatus = 'PASSED' | 'FAILED' | 'UNKNOWN' | 'NO_DATA';
export type StandardKey = 'fsbp' | 'cis';

export interface FindingResource {
  /** ASFF resource type: AwsEc2SecurityGroup, AwsS3Bucket, AwsAccount ... */
  type: string;
  id: string;
  region: string;
  tags: Record<string, string>;
}

export interface Finding {
  id: string;
  productArn: string;
  productName: string;
  companyName: string;
  generatorId: string;
  types: string[];
  title: string;
  description: string;
  /** Severity.Label now (people and automation rules can change it) */
  severity: SeverityLabel;
  /** FindingProviderFields.Severity: what the product said */
  providerSeverity: { label: SeverityLabel; original: string };
  resource: FindingResource;
  /** control findings: Compliance.SecurityControlId / Status */
  controlId?: string;
  compliance?: ComplianceStatus;
  annotation?: string;
  workflow: WorkflowStatus;
  recordState: 'ACTIVE' | 'ARCHIVED';
  note?: { text: string; updatedBy: string; updatedAt: number };
  firstObservedAt: number;
  lastObservedAt: number;
  createdAt: number;
  updatedAt: number;
  /** control findings: the checked resource's configuration at the last check (a change = the check runs again) */
  checked?: string;
}

/** AwsSecurityFindingFilters / AutomationRulesFindingFilters in the API shape: { SeverityLabel: [{ Value, Comparison }] } */
export type FindingFilters = Record<string, Record<string, unknown>[]>;

/** FindingFieldsUpdate in the API shape (also BatchUpdateFindings' fields) */
export interface FieldsUpdate {
  Severity?: { Label?: string };
  Workflow?: { Status?: string };
  Note?: { Text?: string; UpdatedBy?: string };
}

export interface AutomationRule {
  ruleArn: string;
  ruleName: string;
  description: string;
  ruleOrder: number;
  ruleStatus: 'ENABLED' | 'DISABLED';
  isTerminal: boolean;
  criteria: FindingFilters;
  actions: { Type: 'FINDING_FIELDS_UPDATE'; FindingFieldsUpdate: FieldsUpdate }[];
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

export interface SecurityHubState {
  /** undefined = Security Hub CSPM is not enabled in this account / Region */
  hub?: { hubArn: string; subscribedAt: number };
  standards: { key: StandardKey; subscribedAt: number }[];
  findings: Finding[];
  automationRules: AutomationRule[];
  /** findings other products (GuardDuty) send as soon as Security Hub CSPM is enabled (scenario seed) */
  queued?: Finding[];
}

/* ---------------- standards ---------------- */

export interface StandardDef {
  key: StandardKey;
  name: string;
  nameJa: string;
  description: string;
  /** StandardsArn (FSBP is regional, CIS v1.2.0 is a "ruleset" without a Region) */
  arn: (region: string) => string;
  /** the part after subscription/ and control/ */
  path: string;
  /** Compliance.AssociatedStandards[].StandardsId */
  standardsId: string;
}

export const STANDARDS: StandardDef[] = [
  {
    key: 'fsbp',
    name: 'AWS Foundational Security Best Practices v1.0.0',
    nameJa: 'AWS 基礎セキュリティのベストプラクティス v1.0.0',
    description: 'The AWS Foundational Security Best Practices standard is a set of automated security checks that detect when AWS accounts and deployed resources do not align to security best practices. The standard is defined by AWS security experts.',
    arn: (region) => `arn:aws:securityhub:${region}::standards/aws-foundational-security-best-practices/v/1.0.0`,
    path: 'aws-foundational-security-best-practices/v/1.0.0',
    standardsId: 'standards/aws-foundational-security-best-practices/v/1.0.0',
  },
  {
    key: 'cis',
    name: 'CIS AWS Foundations Benchmark v1.2.0',
    nameJa: 'CIS AWS Foundations Benchmark v1.2.0',
    description: 'The Center for Internet Security (CIS) AWS Foundations Benchmark v1.2.0 is a set of security configuration best practices for AWS. This Security Hub standard automatically checks for your compliance readiness against a subset of CIS requirements.',
    arn: () => 'arn:aws:securityhub:::ruleset/cis-aws-foundations-benchmark/v/1.2.0',
    path: 'cis-aws-foundations-benchmark/v/1.2.0',
    standardsId: 'ruleset/cis-aws-foundations-benchmark/v/1.2.0',
  },
];

export const standardDef = (key: StandardKey) => STANDARDS.find((s) => s.key === key)!;
export const subscriptionArn = (env: AwsEnv, key: StandardKey) => `arn:aws:securityhub:${env.region}:${env.accountId}:subscription/${standardDef(key).path}`;
/** a StandardsArn as typed (with or without the Region) */
export const standardByArn = (env: AwsEnv, arn: string) => STANDARDS.find((s) => s.arn(env.region) === arn || s.arn('') === arn);

/* ---------------- controls ---------------- */

interface CheckResult {
  resource: FindingResource;
  status: 'PASSED' | 'FAILED';
  annotation?: string;
  /** the resource's configuration (a change makes the check run again) */
  config: string;
}

export interface ControlDef {
  id: string;
  title: string;
  titleJa: string;
  /** ASFF Description (the API is English, the console shows descriptionJa) */
  description: string;
  descriptionJa: string;
  severity: SeverityLabel;
  /** AWS Config rule the check uses */
  configRule: string;
  schedule: '変更がトリガーされた場合' | '定期的' | '変更がトリガーされた場合と定期的';
  /** standard -> the control's id / requirement in it */
  standards: Partial<Record<StandardKey, string>>;
  evaluate(env: AwsEnv): CheckResult[];
}

const tagMap = (tags: Tag[]) => Object.fromEntries(tags.map((t) => [t.key, t.value]));
const OPEN = (r: SecurityGroupRule) => r.cidrIpv4 === '0.0.0.0/0';
const coversTcp = (r: SecurityGroupRule, port: number) => r.ipProtocol === '-1' || (r.ipProtocol === 'tcp' && (r.fromPort === -1 || (r.fromPort <= port && port <= r.toPort)));
/** EC2.19's fixed blockedPorts */
export const HIGH_RISK_PORTS = [20, 21, 22, 23, 25, 110, 135, 143, 445, 1433, 1434, 3000, 3306, 3389, 4333, 5000, 5432, 5500, 5601, 8080, 8088, 8888, 9200, 9300];

function sgChecks(env: AwsEnv, bad: (g: SecurityGroup) => string | false, groups = env.securityGroups): CheckResult[] {
  return groups.map((g) => {
    const why = bad(g);
    return { resource: { type: 'AwsEc2SecurityGroup', id: `arn:aws:ec2:${env.region}:${env.accountId}:security-group/${g.groupId}`, region: env.region, tags: tagMap(g.tags) }, status: why ? 'FAILED' : 'PASSED', ...(why ? { annotation: why } : {}), config: JSON.stringify(g) };
  });
}

const liveInstances = (env: AwsEnv) => env.instances.filter((i) => i.state !== 'terminated' && i.state !== 'shutting-down');
function instanceChecks(env: AwsEnv, bad: (i: AwsEnv['instances'][number]) => string | false): CheckResult[] {
  return liveInstances(env).map((i) => {
    const why = bad(i);
    return { resource: { type: 'AwsEc2Instance', id: `arn:aws:ec2:${env.region}:${env.accountId}:instance/${i.instanceId}`, region: env.region, tags: tagMap(i.tags) }, status: why ? 'FAILED' : 'PASSED', ...(why ? { annotation: why } : {}), config: JSON.stringify({ ...i, homeFiles: undefined }) };
  });
}

function dbChecks(env: AwsEnv, bad: (d: AwsEnv['dbInstances'][number]) => string | false): CheckResult[] {
  return env.dbInstances.map((d) => {
    const why = bad(d);
    return { resource: { type: 'AwsRdsDbInstance', id: `arn:aws:rds:${env.region}:${env.accountId}:db:${d.dbInstanceIdentifier}`, region: env.region, tags: tagMap(d.tags) }, status: why ? 'FAILED' : 'PASSED', ...(why ? { annotation: why } : {}), config: JSON.stringify({ ...d, data: undefined }) };
  });
}

export const CONTROLS: ControlDef[] = [
  {
    id: 'EC2.2',
    title: 'VPC default security groups should not allow inbound or outbound traffic',
    titleJa: 'VPC のデフォルトのセキュリティグループでは、インバウンドトラフィックとアウトバウンドトラフィックを許可しないようにする必要があります',
    description: 'This control checks whether the default security group of a VPC allows inbound or outbound traffic. The control fails if the security group allows inbound or outbound traffic.',
    descriptionJa: 'VPC のデフォルトのセキュリティグループが、インバウンドまたはアウトバウンドのトラフィックを許可しているかどうかを確認します。ルールが 1 つでもあると失敗します。デフォルトのセキュリティグループは削除できないため、ルールを空にしておくことが推奨されます。',
    severity: 'HIGH',
    configRule: 'vpc-default-security-group-closed',
    schedule: '変更がトリガーされた場合',
    standards: { fsbp: 'EC2.2', cis: '4.3' },
    evaluate: (env) => sgChecks(env, (g) => (g.ingress.length > 0 || g.egress.length > 0) && 'Default security group has inbound or outbound rules.', env.securityGroups.filter((g) => g.groupName === 'default')),
  },
  {
    id: 'EC2.8',
    title: 'EC2 instances should use Instance Metadata Service Version 2 (IMDSv2)',
    titleJa: 'EC2 インスタンスは、インスタンスメタデータサービスバージョン 2 (IMDSv2) を使用する必要があります',
    description: 'This control checks whether your EC2 instance metadata version is configured with Instance Metadata Service Version 2 (IMDSv2). The control passes if HttpTokens is set to required for IMDSv2. The control fails if HttpTokens is set to optional.',
    descriptionJa: 'EC2 インスタンスのメタデータのバージョンが IMDSv2 に設定されているかどうかを確認します。HttpTokens が required なら合格、optional なら失敗します。',
    severity: 'HIGH',
    configRule: 'ec2-imdsv2-check',
    schedule: '変更がトリガーされた場合',
    standards: { fsbp: 'EC2.8' },
    evaluate: (env) => instanceChecks(env, (i) => (i.metadataOptions?.httpTokens ?? 'optional') !== 'required' && 'HttpTokens is set to optional.'),
  },
  {
    id: 'EC2.9',
    title: 'Amazon EC2 instances should not have a public IPv4 address',
    titleJa: 'Amazon EC2 インスタンスは、パブリック IPv4 アドレスを持つべきではありません',
    description: 'This control checks whether an Amazon EC2 instance has a public IPv4 address. The control fails if the publicIp field is present in the EC2 instance configuration item.',
    descriptionJa: 'EC2 インスタンスにパブリック IPv4 アドレスがあるかどうかを確認します。パブリック IP アドレスがあると失敗します。',
    severity: 'HIGH',
    configRule: 'ec2-instance-no-public-ip',
    schedule: '変更がトリガーされた場合',
    standards: { fsbp: 'EC2.9' },
    evaluate: (env) => instanceChecks(env, (i) => !!i.publicIpAddress && `Instance has a public IPv4 address (${i.publicIpAddress}).`),
  },
  {
    id: 'EC2.13',
    title: 'Security groups should not allow ingress from 0.0.0.0/0 or ::/0 to port 22',
    titleJa: 'セキュリティグループは、0.0.0.0/0 または ::/0 からポート 22 への入力を許可すべきではありません',
    description: 'This control checks whether security groups allow unrestricted incoming traffic to port 22 from 0.0.0.0/0 or ::/0. The control fails if a security group allows it.',
    descriptionJa: 'セキュリティグループが、0.0.0.0/0 または ::/0 からポート 22 (SSH) へのインバウンドを許可しているかどうかを確認します。許可していると失敗します。',
    severity: 'HIGH',
    configRule: 'restricted-ssh',
    schedule: '変更がトリガーされた場合',
    standards: { cis: '4.1' },
    evaluate: (env) => sgChecks(env, (g) => g.ingress.some((r) => OPEN(r) && coversTcp(r, 22)) && 'Security group allows unrestricted ingress (0.0.0.0/0) to port 22.'),
  },
  {
    id: 'EC2.18',
    title: 'Security groups should only allow unrestricted incoming traffic for authorized ports',
    titleJa: 'セキュリティグループは、承認されたポートに対して無制限の着信トラフィックのみを許可する必要があります',
    description: 'This control checks whether an Amazon EC2 security group permits unrestricted incoming traffic from unauthorized ports. The control fails if the security group allows unrestricted incoming traffic on any port other than the authorized ports (TCP 80 and 443 by default).',
    descriptionJa: 'セキュリティグループが、承認されたポート (既定は TCP 80 と 443) 以外への無制限 (0.0.0.0/0) のインバウンドを許可しているかどうかを確認します。許可していると失敗します。',
    severity: 'HIGH',
    configRule: 'vpc-sg-open-only-to-authorized-ports',
    schedule: '変更がトリガーされた場合',
    standards: { fsbp: 'EC2.18' },
    evaluate: (env) =>
      sgChecks(env, (g) => {
        const bad = g.ingress.filter((r) => OPEN(r) && !(r.ipProtocol === 'tcp' && r.fromPort === r.toPort && [80, 443].includes(r.fromPort)));
        return bad.length > 0 && `Security group allows unrestricted ingress to unauthorized port(s): ${bad.map((r) => (r.ipProtocol === '-1' ? 'all' : `${r.ipProtocol}/${r.fromPort === r.toPort ? r.fromPort : `${r.fromPort}-${r.toPort}`}`)).join(', ')}.`;
      }),
  },
  {
    id: 'EC2.19',
    title: 'Security groups should not allow unrestricted access to ports with high risk',
    titleJa: 'セキュリティグループは、リスクの高いポートへの無制限アクセスを許可してはいけません',
    description: "This control checks whether unrestricted incoming traffic for an Amazon EC2 security group is accessible to the specified ports that are considered to be high risk. This control fails if any of the rules in a security group allow ingress traffic from '0.0.0.0/0' or '::/0' to those ports.",
    descriptionJa: `セキュリティグループが、リスクの高いポート (${HIGH_RISK_PORTS.join(', ')}) への 0.0.0.0/0 または ::/0 からのインバウンドを許可しているかどうかを確認します。1 つでも許可していると失敗します。`,
    severity: 'CRITICAL',
    configRule: 'vpc-sg-restricted-common-ports',
    schedule: '変更がトリガーされた場合と定期的',
    standards: { fsbp: 'EC2.19' },
    evaluate: (env) =>
      sgChecks(env, (g) => {
        const ports = HIGH_RISK_PORTS.filter((p) => g.ingress.some((r) => OPEN(r) && coversTcp(r, p)));
        return ports.length > 0 && `Security group allows unrestricted ingress (0.0.0.0/0) to high-risk port(s): ${ports.join(', ')}.`;
      }),
  },
  {
    id: 'IAM.1',
    title: 'IAM policies should not allow full "*" administrative privileges',
    titleJa: 'IAM ポリシーでは、完全な「*」管理者権限を許可しないでください',
    description: 'This control checks whether the default version of IAM policies (also known as customer managed policies) has administrator access by including a statement with "Effect": "Allow" with "Action": "*" over "Resource": "*". The control fails if you have IAM policies with such a statement.',
    descriptionJa: 'カスタマー管理ポリシーに、"Effect": "Allow" で "Action": "*" かつ "Resource": "*" のステートメントがあるかどうかを確認します。あると失敗します。AWS 管理ポリシーとインラインポリシーは確認しません。',
    severity: 'HIGH',
    configRule: 'iam-policy-no-statements-with-admin-access',
    schedule: '変更がトリガーされた場合',
    standards: { fsbp: 'IAM.1', cis: '1.22' },
    evaluate: (env) =>
      env.iamPolicies
        .filter((p) => !p.awsManaged)
        .map((p) => {
          const list = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
          const admin = list<PolicyStatement>(p.document.Statement).some((st) => st.Effect === 'Allow' && list(st.Action).includes('*') && list(st.Resource).includes('*'));
          return { resource: { type: 'AwsIamPolicy', id: p.arn, region: env.region, tags: {} }, status: admin ? 'FAILED' : 'PASSED', ...(admin ? { annotation: 'Policy allows full "*" administrative privileges.' } : {}), config: JSON.stringify(p) };
        }),
  },
  {
    id: 'RDS.2',
    title: 'RDS DB Instances should prohibit public access, as determined by the PubliclyAccessible configuration',
    titleJa: 'RDS DB インスタンスは、PubliclyAccessible 設定で判断されるパブリックアクセスを禁止する必要があります',
    description: 'This control checks whether Amazon RDS instances are publicly accessible by evaluating the PubliclyAccessible field in the instance configuration item.',
    descriptionJa: 'RDS DB インスタンスの設定の PubliclyAccessible を確認します。true (パブリックアクセス可能) なら失敗します。',
    severity: 'CRITICAL',
    configRule: 'rds-instance-public-access-check',
    schedule: '変更がトリガーされた場合',
    standards: { fsbp: 'RDS.2' },
    evaluate: (env) => dbChecks(env, (d) => d.publiclyAccessible && 'PubliclyAccessible is true.'),
  },
  {
    id: 'RDS.3',
    title: 'RDS DB instances should have encryption at-rest enabled',
    titleJa: 'RDS DB インスタンスでは、保管時の暗号化が有効になっている必要があります',
    description: 'This control checks whether storage encryption is enabled for your Amazon RDS DB instances.',
    descriptionJa: 'RDS DB インスタンスでストレージの暗号化が有効になっているかどうかを確認します。無効なら失敗します。',
    severity: 'MEDIUM',
    configRule: 'rds-storage-encrypted',
    schedule: '変更がトリガーされた場合',
    standards: { fsbp: 'RDS.3' },
    evaluate: (env) => dbChecks(env, (d) => !d.storageEncrypted && 'Storage is not encrypted.'),
  },
  {
    id: 'RDS.5',
    title: 'RDS DB instances should be configured with multiple Availability Zones',
    titleJa: 'RDS DB インスタンスは、複数のアベイラビリティーゾーンで設定する必要があります',
    description: "This control checks whether high availability is enabled for your RDS DB instances. The control fails if the DB instance isn't configured with multiple Availability Zones.",
    descriptionJa: 'RDS DB インスタンスでマルチ AZ 配置が有効になっているかどうかを確認します。シングル AZ なら失敗します。',
    severity: 'MEDIUM',
    configRule: 'rds-multi-az-support',
    schedule: '変更がトリガーされた場合',
    standards: { fsbp: 'RDS.5' },
    evaluate: (env) => dbChecks(env, (d) => !d.multiAZ && 'MultiAZ is false.'),
  },
  {
    id: 'RDS.11',
    title: 'RDS instances should have automatic backups enabled',
    titleJa: 'RDS インスタンスでは、自動バックアップが有効になっている必要があります',
    description: 'This control checks whether Amazon Relational Database Service instances have automated backups enabled, and the backup retention period is greater than or equal to seven days.',
    descriptionJa: 'RDS DB インスタンスで自動バックアップが有効 (バックアップ保持期間が 7 日以上) かどうかを確認します。',
    severity: 'MEDIUM',
    configRule: 'db-instance-backup-enabled',
    schedule: '変更がトリガーされた場合',
    standards: { fsbp: 'RDS.11' },
    evaluate: (env) => dbChecks(env, (d) => d.backupRetentionPeriod < 7 && `BackupRetentionPeriod is ${d.backupRetentionPeriod}.`),
  },
  {
    id: 'S3.8',
    title: 'S3 general purpose buckets should block public access',
    titleJa: 'S3 汎用バケットはパブリックアクセスをブロックする必要があります',
    description: 'This control checks whether an Amazon S3 general purpose bucket blocks public access at the bucket level. The control fails if any of the following settings are set to false: ignorePublicAcls, blockPublicPolicy, blockPublicAcls, restrictPublicBuckets.',
    descriptionJa: 'S3 汎用バケットで、バケットレベルのブロックパブリックアクセスの 4 つの設定 (BlockPublicAcls / IgnorePublicAcls / BlockPublicPolicy / RestrictPublicBuckets) がすべてオンかどうかを確認します。1 つでもオフなら失敗します。',
    severity: 'HIGH',
    configRule: 's3-bucket-level-public-access-prohibited',
    schedule: '変更がトリガーされた場合',
    standards: { fsbp: 'S3.8' },
    evaluate: (env) =>
      env.buckets
        .filter((b) => b.region === env.region)
        .map((b) => {
          const off = Object.entries(b.blockPublicAccess).filter(([, v]) => !v).map(([k]) => k[0].toUpperCase() + k.slice(1));
          return { resource: { type: 'AwsS3Bucket', id: `arn:aws:s3:::${b.name}`, region: env.region, tags: tagMap(b.tags) }, status: off.length ? 'FAILED' : 'PASSED', ...(off.length ? { annotation: `Block public access settings are off: ${off.join(', ')}.` } : {}), config: JSON.stringify({ ...b, objects: undefined }) };
        }),
  },
];

export const controlDef = (id: string) => CONTROLS.find((c) => c.id === id);
const enabledKeys = (env: AwsEnv) => (env.securityHub?.standards ?? []).map((s) => s.key);
/** controls of the enabled standards (each once), in catalog order */
export const enabledControls = (env: AwsEnv, only?: StandardKey) => CONTROLS.filter((c) => (only ? [only] : enabledKeys(env)).some((k) => enabledKeys(env).includes(k) && c.standards[k]));

/* ---------------- findings ---------------- */

const uuid = (seed: string) => {
  const h = stableChars(seed, '0123456789abcdef', 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
export const SH_PRODUCT = (region: string) => `arn:aws:securityhub:${region}::product/aws/securityhub`;
const controlFindingId = (env: AwsEnv, controlId: string, resourceId: string) => `arn:aws:securityhub:${env.region}:${env.accountId}:security-control/${controlId}/finding/${uuid(`${controlId}|${resourceId}`)}`;

export function requireHub(env: AwsEnv): SecurityHubState {
  const s = env.securityHub;
  if (!s?.hub) throw new AwsError('InvalidAccessException', `Account ${env.accountId} is not subscribed to AWS Security Hub`);
  return s;
}

export const findingMatches = (env: AwsEnv, f: Finding, filters: FindingFilters) => Object.entries(filters).every(([field, conds]) => matchField(env, f, field, conds));

/** Apply the enabled automation rules (lowest RuleOrder first, a terminal rule stops the rest) to a new or updated finding. */
function applyRules(env: AwsEnv, s: SecurityHubState, f: Finding, now: number) {
  const rules = [...s.automationRules].sort((a, b) => a.ruleOrder - b.ruleOrder || a.updatedAt - b.updatedAt);
  for (const r of rules) {
    if (r.ruleStatus !== 'ENABLED' || !findingMatches(env, f, r.criteria)) continue;
    for (const a of r.actions) applyUpdate(f, a.FindingFieldsUpdate, now);
    if (r.isTerminal) break;
  }
}

function applyUpdate(f: Finding, u: FieldsUpdate, now: number) {
  if (u.Severity?.Label) f.severity = u.Severity.Label as SeverityLabel;
  if (u.Workflow?.Status) f.workflow = u.Workflow.Status as WorkflowStatus;
  if (u.Note?.Text !== undefined) f.note = { text: u.Note.Text, updatedBy: u.Note.UpdatedBy ?? '', updatedAt: now };
}

/**
 * Run the checks of the enabled controls and bring the stored findings up to date. A control without any resource
 * gets one PASSED finding for the account. Returns true when something changed.
 */
export function checkControls(env: AwsEnv, now = Date.now()): boolean {
  const s = env.securityHub;
  if (!s?.hub) return false;
  let changed = false;
  const seen = new Set<string>();
  for (const c of enabledControls(env)) {
    const results = c.evaluate(env);
    if (!results.length) results.push({ resource: { type: 'AwsAccount', id: `AWS::::Account:${env.accountId}`, region: env.region, tags: {} }, status: 'PASSED', config: 'account' });
    for (const r of results) {
      const id = controlFindingId(env, c.id, r.resource.id);
      seen.add(id);
      const f = s.findings.find((x) => x.id === id);
      if (!f) {
        const nf: Finding = {
          id,
          productArn: SH_PRODUCT(env.region),
          productName: 'Security Hub CSPM',
          companyName: 'AWS',
          generatorId: `security-control/${c.id}`,
          types: ['Software and Configuration Checks/Industry and Regulatory Standards'],
          title: c.title,
          description: c.description,
          severity: c.severity,
          providerSeverity: { label: c.severity, original: c.severity },
          resource: r.resource,
          controlId: c.id,
          compliance: r.status,
          annotation: r.annotation,
          // control findings that pass are resolved, the others wait for someone to look at them
          workflow: r.status === 'PASSED' ? 'RESOLVED' : 'NEW',
          recordState: 'ACTIVE',
          firstObservedAt: now,
          lastObservedAt: now,
          createdAt: now,
          updatedAt: now,
          checked: r.config,
        };
        applyRules(env, s, nf, now);
        s.findings.push(nf);
        changed = true;
        continue;
      }
      if (f.compliance === r.status && f.checked === r.config && f.recordState === 'ACTIVE') continue;
      const reopened = f.recordState === 'ARCHIVED' || (f.compliance === 'PASSED' && r.status !== 'PASSED');
      Object.assign(f, { compliance: r.status, annotation: r.annotation, checked: r.config, resource: r.resource, recordState: 'ACTIVE', updatedAt: now, lastObservedAt: now });
      // workflow status follows the result unless someone suppressed the finding
      if (f.workflow !== 'SUPPRESSED') {
        if (r.status === 'PASSED') f.workflow = 'RESOLVED';
        else if (reopened && (f.workflow === 'NOTIFIED' || f.workflow === 'RESOLVED')) f.workflow = 'NEW';
      }
      applyRules(env, s, f, now);
      changed = true;
    }
  }
  // the resource is gone (or no enabled standard has the control any more): NOT_AVAILABLE and archived
  for (const f of s.findings) {
    if (!f.controlId || seen.has(f.id) || f.recordState === 'ARCHIVED') continue;
    Object.assign(f, { compliance: 'NOT_AVAILABLE', annotation: undefined, recordState: 'ARCHIVED', updatedAt: now });
    changed = true;
  }
  return changed;
}

/** The env with Security Hub up to date, without touching the original (readers: console pages, CLI, lesson checks). */
export function fresh(env: AwsEnv, now = Date.now()): AwsEnv {
  if (!env.securityHub?.hub) return env;
  const copy = { ...env, securityHub: structuredClone(env.securityHub) };
  return checkControls(copy, now) ? copy : env;
}

/** Control status as the console shows it: archived and suppressed findings are ignored. */
export function controlStatus(env: AwsEnv, controlId: string): ControlStatus {
  const fs = (env.securityHub?.findings ?? []).filter((f) => f.controlId === controlId && f.recordState === 'ACTIVE' && f.workflow !== 'SUPPRESSED');
  if (!fs.length) return 'NO_DATA';
  if (fs.some((f) => f.compliance === 'FAILED')) return 'FAILED';
  if (fs.some((f) => f.compliance !== 'PASSED')) return 'UNKNOWN';
  return 'PASSED';
}

/** Security score: passed / (passed + failed + unknown) of the enabled controls, each control once. null = no data yet */
export function securityScore(env: AwsEnv, only?: StandardKey): { score: number | null; passed: number; total: number } {
  const statuses = enabledControls(env, only).map((c) => controlStatus(env, c.id)).filter((x) => x !== 'NO_DATA');
  const passed = statuses.filter((x) => x === 'PASSED').length;
  return { score: statuses.length ? Math.round((passed / statuses.length) * 100) : null, passed, total: statuses.length };
}

/* ---------------- filters (GetFindings, automation rule criteria) ---------------- */

const STRING_FIELDS: Record<string, (f: Finding, env: AwsEnv) => string | string[] | undefined> = {
  Id: (f) => f.id,
  ProductArn: (f) => f.productArn,
  ProductName: (f) => f.productName,
  CompanyName: (f) => f.companyName,
  GeneratorId: (f) => f.generatorId,
  AwsAccountId: (_, env) => env.accountId,
  Region: (_, env) => env.region,
  Type: (f) => f.types,
  Title: (f) => f.title,
  Description: (f) => f.description,
  SeverityLabel: (f) => f.severity,
  ComplianceStatus: (f) => f.compliance,
  ComplianceSecurityControlId: (f) => f.controlId,
  ComplianceAssociatedStandardsId: (f, env) => associatedStandards(env, f).map((s) => s.standardsId),
  WorkflowStatus: (f) => f.workflow,
  RecordState: (f) => f.recordState,
  ResourceType: (f) => f.resource.type,
  ResourceId: (f) => f.resource.id,
  ResourceRegion: (f) => f.resource.region,
  NoteText: (f) => f.note?.text,
  NoteUpdatedBy: (f) => f.note?.updatedBy,
};
const STRING_COMPARISONS = ['EQUALS', 'PREFIX', 'NOT_EQUALS', 'PREFIX_NOT_EQUALS', 'CONTAINS', 'NOT_CONTAINS'];
const MAP_COMPARISONS = ['EQUALS', 'NOT_EQUALS', 'CONTAINS', 'NOT_CONTAINS'];
/** filter names this simulator understands (the real API has more) */
export const FILTER_FIELDS = [...Object.keys(STRING_FIELDS), 'ResourceTags'];

function matchField(env: AwsEnv, f: Finding, field: string, conds: Record<string, unknown>[]): boolean {
  const test = (cmp: string, got: string | undefined, want: string) => {
    const g = got ?? '';
    switch (cmp) {
      case 'EQUALS':
        return got !== undefined && g === want;
      case 'PREFIX':
        return got !== undefined && g.startsWith(want);
      case 'CONTAINS':
        return got !== undefined && g.includes(want);
      case 'NOT_EQUALS':
        return g !== want;
      case 'PREFIX_NOT_EQUALS':
        return !g.startsWith(want);
      default:
        return !g.includes(want);
    }
  };
  const negative = (c: Record<string, unknown>) => String(c.Comparison).startsWith('NOT_') || c.Comparison === 'PREFIX_NOT_EQUALS';
  // EQUALS / PREFIX / CONTAINS filters on the same field are ORed, the NOT_ ones are ANDed
  const pos = conds.filter((c) => !negative(c));
  const neg = conds.filter(negative);
  if (field === 'ResourceTags') {
    const tag = (c: Record<string, unknown>) => f.resource.tags[String(c.Key)];
    return (!pos.length || pos.some((c) => test(String(c.Comparison), tag(c), String(c.Value)))) && neg.every((c) => test(String(c.Comparison), tag(c), String(c.Value)));
  }
  const raw = STRING_FIELDS[field]?.(f, env);
  const values = raw === undefined ? [undefined] : Array.isArray(raw) ? raw : [raw];
  return (!pos.length || pos.some((c) => values.some((v) => test(String(c.Comparison), v, String(c.Value))))) && neg.every((c) => values.every((v) => test(String(c.Comparison), v, String(c.Value))));
}

/** InvalidInputException for comparisons the API doesn't know (unknown filter names are the CLI's to reject) */
export function checkFilters(filters: FindingFilters, what = 'Filters') {
  for (const [field, conds] of Object.entries(filters)) {
    if (!Array.isArray(conds)) throw new AwsError('InvalidInputException', `Invalid ${what}: ${field} must be a list of filters.`);
    const allowed = field === 'ResourceTags' ? MAP_COMPARISONS : STRING_COMPARISONS;
    for (const c of conds) {
      if (!allowed.includes(String(c.Comparison))) throw new AwsError('InvalidInputException', `Invalid ${what}: Comparison '${String(c.Comparison)}' is not valid for ${field}. Valid values: ${allowed.join(', ')}`);
      if (c.Value === undefined || (field === 'ResourceTags' && c.Key === undefined)) throw new AwsError('InvalidInputException', `Invalid ${what}: ${field} requires ${field === 'ResourceTags' ? 'Key, Value' : 'Value'} and Comparison.`);
    }
  }
}

/** GetFindings: findings matching the filters (newest update first) */
export function getFindings(env: AwsEnv, filters: FindingFilters = {}): Finding[] {
  const s = requireHub(env);
  checkFilters(filters);
  return s.findings.filter((f) => findingMatches(env, f, filters)).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** console preview of an automation rule: findings its criteria match now */
export function previewRule(env: AwsEnv, criteria: FindingFilters): Finding[] {
  return (env.securityHub?.findings ?? []).filter((f) => f.recordState === 'ACTIVE' && findingMatches(env, f, criteria));
}

/** standards of the finding's control that are enabled now */
export const associatedStandards = (env: AwsEnv, f: Finding) => (f.controlId ? STANDARDS.filter((s) => enabledKeys(env).includes(s.key) && controlDef(f.controlId!)?.standards[s.key]) : []);

/* ---------------- ASFF ---------------- */

const asffTime = (t: number) => new Date(t).toISOString();

/** The finding in the AWS Security Finding Format (what GetFindings returns) */
export function asff(env: AwsEnv, f: Finding) {
  const c = f.controlId ? controlDef(f.controlId) : undefined;
  return {
    SchemaVersion: '2018-10-08',
    Id: f.id,
    ProductArn: f.productArn,
    ProductName: f.productName,
    CompanyName: f.companyName,
    Region: env.region,
    GeneratorId: f.generatorId,
    AwsAccountId: env.accountId,
    Types: f.types,
    FirstObservedAt: asffTime(f.firstObservedAt),
    LastObservedAt: asffTime(f.lastObservedAt),
    CreatedAt: asffTime(f.createdAt),
    UpdatedAt: asffTime(f.updatedAt),
    Severity: { Label: f.severity, Normalized: NORMALIZED[f.severity], Original: f.providerSeverity.original },
    Title: c ? c.title : f.title,
    Description: f.description,
    ...(c ? { Remediation: { Recommendation: { Text: 'For information on how to correct this issue, consult the AWS Security Hub CSPM controls documentation.', Url: `https://docs.aws.amazon.com/console/securityhub/${c.id}/remediation` } } } : {}),
    ProductFields: {
      ...(c ? { 'RelatedAWSResources:0/name': `securityhub-${c.configRule}-${stableChars(c.id, '0123456789abcdef', 8)}`, 'RelatedAWSResources:0/type': 'AWS::Config::ConfigRule' } : {}),
      'aws/securityhub/ProductName': f.productName,
      'aws/securityhub/CompanyName': f.companyName,
      ...(f.annotation ? { 'aws/securityhub/annotation': f.annotation } : {}),
      'Resources:0/Id': f.resource.id,
      'aws/securityhub/FindingId': `${f.productArn}/${f.id}`,
    },
    Resources: [{ Type: f.resource.type, Id: f.resource.id, Partition: 'aws', Region: f.resource.region, ...(Object.keys(f.resource.tags).length ? { Tags: f.resource.tags } : {}) }],
    ...(c
      ? {
          Compliance: {
            Status: f.compliance,
            SecurityControlId: c.id,
            ...(c.standards.cis ? { RelatedRequirements: [`CIS AWS Foundations Benchmark v1.2.0/${c.standards.cis}`] } : {}),
            AssociatedStandards: associatedStandards(env, f).map((s) => ({ StandardsId: s.standardsId })),
          },
        }
      : {}),
    WorkflowState: 'NEW',
    Workflow: { Status: f.workflow },
    RecordState: f.recordState,
    ...(f.note ? { Note: { Text: f.note.text, UpdatedBy: f.note.updatedBy, UpdatedAt: asffTime(f.note.updatedAt) } } : {}),
    FindingProviderFields: { Severity: { Label: f.providerSeverity.label, Original: f.providerSeverity.original }, Types: f.types },
    ProcessedAt: asffTime(f.updatedAt + 1500),
  };
}

/* ---------------- operations ---------------- */

const SH: EventSource = 'securityhub';
const hubArn = (env: AwsEnv) => `arn:aws:securityhub:${env.region}:${env.accountId}:hub/default`;

export function emptySecurityHub(): SecurityHubState {
  return { standards: [], findings: [], automationRules: [] };
}

/** EnableSecurityHub (the default standards are FSBP and CIS v1.2.0). Findings queued by other products come in. */
export function enableSecurityHub(env: AwsEnv, o: { enableDefaultStandards?: boolean } = {}, now = Date.now()) {
  const s = (env.securityHub ??= emptySecurityHub());
  if (s.hub) throw new AwsError('ResourceConflictException', `Account ${env.accountId} is already subscribed to Security Hub`);
  s.hub = { hubArn: hubArn(env), subscribedAt: now };
  if (o.enableDefaultStandards ?? true) s.standards = STANDARDS.map((x) => ({ key: x.key, subscribedAt: now }));
  for (const f of s.queued ?? []) {
    applyRules(env, s, f, now);
    s.findings.push(f);
  }
  s.queued = [];
  checkControls(env, now);
  trail(env, { source: SH, name: 'EnableSecurityHub', resources: [['AWS::SecurityHub::Hub', s.hub.hubArn]], request: { enableDefaultStandards: o.enableDefaultStandards ?? true }, response: null });
}

export function batchEnableStandards(env: AwsEnv, arns: string[], now = Date.now()): StandardKey[] {
  const s = requireHub(env);
  checkControls(env, now);
  if (!arns.length) throw new AwsError('InvalidInputException', 'StandardsSubscriptionRequests must contain at least one request.');
  const keys = arns.map((a) => standardByArn(env, a)?.key ?? (() => { throw new AwsError('InvalidInputException', `Invalid StandardsArn: ${a}`); })());
  for (const k of keys) if (!s.standards.some((x) => x.key === k)) s.standards.push({ key: k, subscribedAt: now });
  checkControls(env, now);
  trail(env, { source: SH, name: 'BatchEnableStandards', resources: keys.map((k) => ['AWS::SecurityHub::Standard', subscriptionArn(env, k)]), request: { standardsSubscriptionRequests: arns.map((a) => ({ standardsArn: a })) }, response: null });
  return keys;
}

export function batchDisableStandards(env: AwsEnv, subscriptionArns: string[], now = Date.now()): StandardKey[] {
  const s = requireHub(env);
  checkControls(env, now);
  const keys = subscriptionArns.map((a) => STANDARDS.find((x) => subscriptionArn(env, x.key) === a && s.standards.some((y) => y.key === x.key))?.key ?? (() => { throw new AwsError('InvalidInputException', `Invalid StandardsSubscriptionArn: ${a}`); })());
  s.standards = s.standards.filter((x) => !keys.includes(x.key));
  checkControls(env, now);
  trail(env, { source: SH, name: 'BatchDisableStandards', resources: keys.map((k) => ['AWS::SecurityHub::Standard', subscriptionArn(env, k)]), request: { standardsSubscriptionArns: subscriptionArns }, response: null });
  return keys;
}

function checkUpdate(u: FieldsUpdate) {
  if (u.Severity?.Label !== undefined && !SEVERITIES.includes(u.Severity.Label as SeverityLabel)) throw new AwsError('InvalidInputException', `Invalid Severity.Label: ${u.Severity.Label}. Valid values: ${SEVERITIES.join(', ')}`);
  if (u.Workflow?.Status !== undefined && !WORKFLOW_STATUSES.includes(u.Workflow.Status as WorkflowStatus)) throw new AwsError('InvalidInputException', `Invalid Workflow.Status: ${u.Workflow.Status}. Valid values: ${WORKFLOW_STATUSES.join(', ')}`);
  if (u.Note && (!u.Note.Text || !u.Note.UpdatedBy)) throw new AwsError('InvalidInputException', 'Note requires both Text and UpdatedBy.');
  if (u.Note?.Text && u.Note.Text.length > 512) throw new AwsError('InvalidInputException', 'Note.Text must be 512 characters or less.');
}

/** BatchUpdateFindings: people change workflow status / severity / note. UpdatedAt stays (it belongs to the product). */
export function batchUpdateFindings(env: AwsEnv, ids: { Id: string; ProductArn: string }[], u: FieldsUpdate, now = Date.now()) {
  const s = requireHub(env);
  checkControls(env, now);
  if (!ids.length) throw new AwsError('InvalidInputException', 'FindingIdentifiers must contain at least one finding.');
  checkUpdate(u);
  const processed: { Id: string; ProductArn: string }[] = [];
  const unprocessed: { FindingIdentifier: { Id: string; ProductArn: string }; ErrorCode: string; ErrorMessage: string }[] = [];
  for (const x of ids) {
    const f = s.findings.find((y) => y.id === x.Id && y.productArn === x.ProductArn);
    if (!f) {
      unprocessed.push({ FindingIdentifier: x, ErrorCode: 'FindingNotFound', ErrorMessage: 'Finding Not Found' });
      continue;
    }
    applyUpdate(f, u, now);
    processed.push(x);
  }
  if (processed.length) trail(env, { source: SH, name: 'BatchUpdateFindings', request: { findingIdentifiers: ids, ...u }, response: { processedFindings: processed, unprocessedFindings: unprocessed } });
  return { processed, unprocessed };
}

export interface RuleInput {
  ruleName: string;
  description: string;
  ruleOrder: number;
  ruleStatus?: string;
  isTerminal?: boolean;
  criteria: FindingFilters;
  actions: { Type?: string; FindingFieldsUpdate?: FieldsUpdate }[];
}

/** CreateAutomationRule. It applies to findings created or updated after this (not to the ones already there). */
export function createAutomationRule(env: AwsEnv, input: RuleInput, createdBy: string, now = Date.now()): AutomationRule {
  const s = requireHub(env);
  checkControls(env, now);
  const name = input.ruleName.trim();
  if (!name || name.length > 256) throw new AwsError('InvalidInputException', 'RuleName must be 1-256 characters.');
  if (!input.description.trim()) throw new AwsError('InvalidInputException', 'Description is required.');
  if (!Number.isInteger(input.ruleOrder) || input.ruleOrder < 1 || input.ruleOrder > 1000) throw new AwsError('InvalidInputException', 'RuleOrder must be an integer from 1 to 1000.');
  const status = input.ruleStatus ?? 'ENABLED';
  if (status !== 'ENABLED' && status !== 'DISABLED') throw new AwsError('InvalidInputException', `Invalid RuleStatus: ${status}. Valid values: ENABLED, DISABLED`);
  if (!Object.keys(input.criteria).length) throw new AwsError('InvalidInputException', 'Criteria must contain at least one filter.');
  checkFilters(input.criteria, 'Criteria');
  if (!input.actions.length) throw new AwsError('InvalidInputException', 'Actions must contain at least one action.');
  for (const a of input.actions) {
    if (a.Type !== 'FINDING_FIELDS_UPDATE') throw new AwsError('InvalidInputException', `Invalid action Type: ${String(a.Type)}. Valid values: FINDING_FIELDS_UPDATE`);
    const u = a.FindingFieldsUpdate ?? {};
    if (!u.Severity?.Label && !u.Workflow?.Status && !u.Note) throw new AwsError('InvalidInputException', 'FindingFieldsUpdate must update at least one field.');
    checkUpdate(u);
  }
  if (s.automationRules.length >= 100) throw new AwsError('LimitExceededException', 'You can create up to 100 automation rules.');
  const rule: AutomationRule = {
    ruleArn: `arn:aws:securityhub:${env.region}:${env.accountId}:automation-rule/${uuid(`${name}|${now}|${s.automationRules.length}`)}`,
    ruleName: name,
    description: input.description,
    ruleOrder: input.ruleOrder,
    ruleStatus: status,
    isTerminal: !!input.isTerminal,
    criteria: input.criteria,
    actions: input.actions.map((a) => ({ Type: 'FINDING_FIELDS_UPDATE', FindingFieldsUpdate: a.FindingFieldsUpdate ?? {} })),
    createdAt: now,
    updatedAt: now,
    createdBy,
  };
  s.automationRules.push(rule);
  trail(env, { source: SH, name: 'CreateAutomationRule', resources: [['AWS::SecurityHub::AutomationRule', rule.ruleArn]], request: { ruleName: name, ruleOrder: rule.ruleOrder, criteria: rule.criteria, actions: rule.actions }, response: { ruleArn: rule.ruleArn } });
  return rule;
}

export function deleteAutomationRules(env: AwsEnv, arns: string[]) {
  const s = requireHub(env);
  const gone = arns.filter((a) => s.automationRules.some((r) => r.ruleArn === a));
  s.automationRules = s.automationRules.filter((r) => !gone.includes(r.ruleArn));
  if (gone.length) trail(env, { source: SH, name: 'BatchDeleteAutomationRules', resources: gone.map((a) => ['AWS::SecurityHub::AutomationRule', a]), request: { automationRulesArns: arns }, response: null });
  return { processed: gone, unprocessed: arns.filter((a) => !gone.includes(a)) };
}

/* ---------------- clock ---------------- */

/** Finish transitions whose time has passed (called from advanceTime). true = something changed */
export function advanceSecurityHub(env: AwsEnv, now: number): boolean {
  return checkControls(env, Number.isFinite(now) ? now : Date.now());
}

/** Does this feature need the 1-second clock (a check would change a finding)? */
export function hasSecurityHubTransitions(env: AwsEnv): boolean {
  return fresh(env) !== env;
}
