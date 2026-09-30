import { trail } from './cloudtrail';
import { newId } from './ids';
import { isPolicyPublic } from './s3';
import { AwsError, type AwsEnv, type ConfigRule } from './types';

/**
 * AWS Config. The recorder is always on and rules are change-triggered, so every evaluation is simply
 * computed from the current env: fix the resource and the rule is COMPLIANT on the next look.
 */

export type Compliance = 'COMPLIANT' | 'NON_COMPLIANT';

export interface Evaluation {
  resourceType: string;
  resourceId: string;
  /** name shown next to the id (Name tag, bucket name ...) */
  resourceName: string;
  compliance: Compliance;
  annotation?: string;
}

interface ManagedRule {
  identifier: string;
  /** the name the console suggests */
  name: string;
  description: string;
  resourceType: string;
  evaluate(env: AwsEnv): Evaluation[];
}

const nameTag = (r: { tags: { key: string; value: string }[] }) => r.tags.find((t) => t.key === 'Name')?.value ?? '';
const ev = (resourceType: string, resourceId: string, resourceName: string, bad: string | false): Evaluation => ({ resourceType, resourceId, resourceName, compliance: bad ? 'NON_COMPLIANT' : 'COMPLIANT', ...(bad ? { annotation: bad } : {}) });
const OPEN = ['0.0.0.0/0'];

export const MANAGED_RULES: ManagedRule[] = [
  {
    identifier: 'INCOMING_SSH_DISABLED',
    name: 'restricted-ssh',
    description: 'セキュリティグループのインバウンド SSH トラフィックが制限されているかどうかを確認します。0.0.0.0/0 から TCP 22 へのインバウンドトラフィックを許可するセキュリティグループは NON_COMPLIANT です。',
    resourceType: 'AWS::EC2::SecurityGroup',
    evaluate: (env) =>
      env.securityGroups.map((g) => {
        const open = g.ingress.find((r) => r.cidrIpv4 && OPEN.includes(r.cidrIpv4) && (r.ipProtocol === '-1' || (r.ipProtocol === 'tcp' && (r.fromPort === -1 || (r.fromPort <= 22 && 22 <= r.toPort)))));
        return ev('AWS::EC2::SecurityGroup', g.groupId, g.groupName, open ? `${open.securityGroupRuleId} が ${open.cidrIpv4} からの SSH (TCP 22) を許可しています。` : false);
      }),
  },
  {
    identifier: 'S3_BUCKET_PUBLIC_READ_PROHIBITED',
    name: 's3-bucket-public-read-prohibited',
    description: 'S3 バケットがパブリック読み取りアクセスを許可していないかどうかを確認します。ブロックパブリックアクセス設定とバケットポリシーを評価し、誰でも読み取れるバケットは NON_COMPLIANT です。',
    resourceType: 'AWS::S3::Bucket',
    evaluate: (env) =>
      env.buckets.map((b) => ev('AWS::S3::Bucket', b.name, b.name, isPolicyPublic(b.policy) && !b.blockPublicAccess.restrictPublicBuckets ? 'バケットポリシーが Principal "*" に読み取りを許可しており、ブロックパブリックアクセスで制限されていません。' : false)),
  },
  {
    identifier: 'RDS_INSTANCE_PUBLIC_ACCESS_CHECK',
    name: 'rds-instance-public-access-check',
    description: 'RDS DB インスタンスがパブリックにアクセス可能でないかどうかを確認します。PubliclyAccessible が true の DB インスタンスは NON_COMPLIANT です。',
    resourceType: 'AWS::RDS::DBInstance',
    evaluate: (env) => env.dbInstances.map((d) => ev('AWS::RDS::DBInstance', d.dbiResourceId, d.dbInstanceIdentifier, d.publiclyAccessible ? 'パブリックアクセス可能 (PubliclyAccessible = true) です。' : false)),
  },
  {
    identifier: 'RDS_STORAGE_ENCRYPTED',
    name: 'rds-storage-encrypted',
    description: 'RDS DB インスタンスでストレージの暗号化が有効になっているかどうかを確認します。',
    resourceType: 'AWS::RDS::DBInstance',
    evaluate: (env) => env.dbInstances.map((d) => ev('AWS::RDS::DBInstance', d.dbiResourceId, d.dbInstanceIdentifier, !d.storageEncrypted && 'ストレージが暗号化されていません。')),
  },
  {
    identifier: 'S3_BUCKET_VERSIONING_ENABLED',
    name: 's3-bucket-versioning-enabled',
    description: 'S3 バケットでバージョニングが有効になっているかどうかを確認します。',
    resourceType: 'AWS::S3::Bucket',
    evaluate: (env) => env.buckets.map((b) => ev('AWS::S3::Bucket', b.name, b.name, b.versioning !== 'Enabled' && `バージョニングが ${b.versioning === 'Suspended' ? '停止' : '無効'} です。`)),
  },
  {
    identifier: 'EC2_INSTANCE_NO_PUBLIC_IP',
    name: 'ec2-instance-no-public-ip',
    description: 'EC2 インスタンスにパブリック IP アドレスが関連付けられていないかどうかを確認します。',
    resourceType: 'AWS::EC2::Instance',
    evaluate: (env) => env.instances.filter((i) => i.state !== 'terminated').map((i) => ev('AWS::EC2::Instance', i.instanceId, nameTag(i), !!i.publicIpAddress && `パブリック IP ${i.publicIpAddress} が関連付けられています。`)),
  },
];

export const managedRule = (identifier: string) => MANAGED_RULES.find((r) => r.identifier === identifier);

/** PutConfigRule with an AWS managed rule */
export function putConfigRule(env: AwsEnv, input: { configRuleName: string; identifier: string }, now = Date.now()): ConfigRule {
  const name = input.configRuleName.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new AwsError('InvalidParameterValueException', 'ConfigRuleName must contain 1-128 letters, numbers, hyphens or underscores.');
  if (!managedRule(input.identifier)) throw new AwsError('InvalidParameterValueException', `The sourceIdentifier ${input.identifier} is invalid.`);
  if (env.configRules.some((r) => r.configRuleName === name)) throw new AwsError('InvalidParameterValueException', `A rule with the name ${name} already exists.`);
  const configRuleId = `config-rule-${newId('x', 6).slice(2)}`;
  const rule: ConfigRule = { configRuleName: name, identifier: input.identifier, configRuleId, configRuleArn: `arn:aws:config:${env.region}:${env.accountId}:config-rule/${configRuleId}`, createdAt: now };
  env.configRules.push(rule);
  trail(env, { source: 'config', name: 'PutConfigRule', resources: [['AWS::Config::ConfigRule', rule.configRuleArn]], request: { configRule: { configRuleName: name, source: { owner: 'AWS', sourceIdentifier: input.identifier }, scope: { complianceResourceTypes: [managedRule(input.identifier)!.resourceType] } } }, response: null });
  return rule;
}

export function deleteConfigRule(env: AwsEnv, name: string) {
  const r = env.configRules.find((x) => x.configRuleName === name);
  if (!r) throw new AwsError('NoSuchConfigRuleException', `The ConfigRule '${name}' provided in the request is invalid. Please check the configRule name.`);
  env.configRules = env.configRules.filter((x) => x !== r);
  trail(env, { source: 'config', name: 'DeleteConfigRule', resources: [['AWS::Config::ConfigRule', r.configRuleArn]], request: { configRuleName: name }, response: null });
}

export function evaluateRule(env: AwsEnv, rule: ConfigRule): Evaluation[] {
  return managedRule(rule.identifier)?.evaluate(env) ?? [];
}

/** the rule is NON_COMPLIANT as soon as one resource in scope is */
export function ruleCompliance(env: AwsEnv, rule: ConfigRule): { compliance: Compliance; nonCompliant: number } {
  const n = evaluateRule(env, rule).filter((e) => e.compliance === 'NON_COMPLIANT').length;
  return { compliance: n ? 'NON_COMPLIANT' : 'COMPLIANT', nonCompliant: n };
}

/** The resource's current configuration item (what the Config timeline shows as the latest state). */
export function configurationItem(env: AwsEnv, resourceType: string, resourceId: string): unknown {
  switch (resourceType) {
    case 'AWS::EC2::SecurityGroup':
      return env.securityGroups.find((g) => g.groupId === resourceId);
    case 'AWS::S3::Bucket':
      return env.buckets.find((b) => b.name === resourceId) && { ...env.buckets.find((b) => b.name === resourceId), objects: undefined };
    case 'AWS::RDS::DBInstance':
      return env.dbInstances.find((d) => d.dbiResourceId === resourceId);
    case 'AWS::EC2::Instance':
      return env.instances.find((i) => i.instanceId === resourceId);
  }
}

/** CloudTrail events about the resource (the Config timeline's "CloudTrail events"); RDS is keyed by identifier in CloudTrail */
export function resourceEvents(env: AwsEnv, resourceType: string, resourceId: string) {
  const name = resourceType === 'AWS::RDS::DBInstance' ? env.dbInstances.find((d) => d.dbiResourceId === resourceId)?.dbInstanceIdentifier : resourceId;
  return [...env.trailEvents].reverse().filter((e) => e.resources.some(([t, n]) => t === resourceType && n === name)).sort((a, b) => b.eventTime - a.eventTime);
}
