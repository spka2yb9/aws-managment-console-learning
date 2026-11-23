/* aws configservice — AWS Config のルールと評価、リソースの設定履歴。評価はコンソールと同じ sim/config.ts で、いまの環境からその場で計算する */
import { quietly } from '../../../sim/cloudtrail';
import { configurationItem, deleteConfigRule, evaluateRule, managedRule, putConfigRule, resourceEvents } from '../../../sim/config';
import type { AwsEnv, ConfigRule } from '../../../sim/types';
import { dbOut, instanceOut, sgOut } from '../shapes';
import { AwsError, iso, req, service, strs, struct, type OpContext, type OperationSpec } from '../types';

const TYPES = ['COMPLIANT', 'NON_COMPLIANT', 'NOT_APPLICABLE', 'INSUFFICIENT_DATA'];

const noSuchRule = (name: string) => new AwsError('NoSuchConfigRuleException', `The ConfigRule '${name}' provided in the request is invalid. Please check the configRule name.`);
const ruleNamed = (env: AwsEnv, name: string) => env.configRules.find((r) => r.configRuleName === name) ?? (() => { throw noSuchRule(name); })();

function complianceTypes(ctx: OpContext): string[] {
  const types = strs(ctx, 'compliance-types');
  for (const t of types) if (!TYPES.includes(t)) throw new AwsError('InvalidParameterValueException', `1 validation error detected: Value '[${types.join(', ')}]' at 'complianceTypes' failed to satisfy constraint: Member must satisfy enum value set: [${TYPES.join(', ')}]`);
  return types;
}

/** 設定が変わるたびに評価し直す (変更をきっかけにするルール): 評価した時刻 = ルールの作成とリソースの最後の変更の、遅いほう */
const evaluatedAt = (env: AwsEnv, rule: ConfigRule, type: string, id: string) => Math.max(rule.createdAt, resourceEvents(env, type, id)[0]?.eventTime ?? 0);

/** Config の設定項目の configuration は、API の応答をキャメルケースにしたもの (dBInstanceIdentifier のような形も実物どおり) */
const camel = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(camel) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k[0].toLowerCase() + k.slice(1), camel(x)])) : v;

function resourceInfo(env: AwsEnv, type: string, id: string) {
  const arn = (svc: string, rest: string) => `arn:aws:${svc}:${env.region}:${env.accountId}:${rest}`;
  const tags = (t: { key: string; value: string }[]) => Object.fromEntries(t.map((x) => [x.key, x.value]));
  switch (type) {
    case 'AWS::EC2::SecurityGroup': {
      const g = env.securityGroups.find((x) => x.groupId === id)!;
      return { arn: arn('ec2', `security-group/${id}`), resourceName: g.groupName, availabilityZone: 'Not Applicable', tags: tags(g.tags), configuration: camel(sgOut(env, g)) };
    }
    case 'AWS::EC2::Instance': {
      const i = env.instances.find((x) => x.instanceId === id)!;
      return { arn: arn('ec2', `instance/${id}`), availabilityZone: i.availabilityZone, tags: tags(i.tags), configuration: camel(instanceOut(env, i)) };
    }
    case 'AWS::RDS::DBInstance': {
      const d = env.dbInstances.find((x) => x.dbiResourceId === id)!;
      return { arn: arn('rds', `db:${d.dbInstanceIdentifier}`), resourceName: d.dbInstanceIdentifier, availabilityZone: d.availabilityZone, tags: {}, configuration: camel(dbOut(env, d)) };
    }
    default:
      return { arn: `arn:aws:s3:::${id}`, resourceName: id, availabilityZone: 'Regional', tags: {}, configuration: configurationItem(env, type, id) };
  }
}

const ops: OperationSpec[] = [
  {
    name: 'describe-config-rules',
    desc: 'Config ルールの一覧 (どのマネージドルールか、何のリソースを見るか)',
    params: [{ name: 'config-rule-names', type: 'list', desc: 'ルール名で絞る (複数可)' }],
    readOnly: true,
    run(ctx) {
      const names = strs(ctx, 'config-rule-names');
      const rules = names.length ? names.map((n) => ruleNamed(ctx.env, n)) : ctx.env.configRules;
      return {
        ConfigRules: rules.map((r) => ({
          ConfigRuleName: r.configRuleName,
          ConfigRuleArn: r.configRuleArn,
          ConfigRuleId: r.configRuleId,
          Description: managedRule(r.identifier)?.description,
          Scope: { ComplianceResourceTypes: [managedRule(r.identifier)?.resourceType] },
          Source: { Owner: 'AWS', SourceIdentifier: r.identifier },
          ConfigRuleState: 'ACTIVE',
          EvaluationModes: [{ Mode: 'DETECTIVE' }],
        })),
      };
    },
  },
  {
    name: 'put-config-rule',
    desc: 'Config ルールを追加する (同じ名前があれば更新)。AWS マネージドルールに対応',
    params: [{ name: 'config-rule', type: 'structure', required: true, desc: "ConfigRuleName=名前,Source={Owner=AWS,SourceIdentifier=RDS_STORAGE_ENCRYPTED}" }],
    examples: ["aws configservice put-config-rule --config-rule 'ConfigRuleName=rds-storage-encrypted,Source={Owner=AWS,SourceIdentifier=RDS_STORAGE_ENCRYPTED}'"],
    run(ctx) {
      const rule = struct(ctx, 'config-rule') ?? {};
      const source = rule.Source as Record<string, unknown> | undefined;
      const name = String(rule.ConfigRuleName ?? '');
      if (!name || !source?.Owner) throw new AwsError('InvalidParameterValueException', 'The ConfigRule must contain ConfigRuleName and Source (Owner, SourceIdentifier).');
      if (source.Owner !== 'AWS') throw new AwsError('InvalidParameterValueException', `(シミュレーター) Owner ${String(source.Owner)} (カスタムルール) には対応していません。AWS マネージドルール (Owner=AWS) を使ってください`);
      const identifier = String(source.SourceIdentifier ?? '');
      const old = ctx.env.configRules.find((r) => r.configRuleName === name);
      // 同じ名前なら更新 (ID と ARN はそのまま)。sim の putConfigRule は重複を拒むので、記録せずに消してから入れ直す (失敗すれば下書きごと捨てられる)
      if (old) quietly(() => deleteConfigRule(ctx.env, name));
      const r = putConfigRule(ctx.env, { configRuleName: name, identifier }, ctx.now);
      if (old) Object.assign(r, { configRuleId: old.configRuleId, configRuleArn: old.configRuleArn, createdAt: old.createdAt });
      return undefined;
    },
  },
  {
    name: 'describe-compliance-by-config-rule',
    desc: 'ルールごとの準拠状況 (COMPLIANT / NON_COMPLIANT と、非準拠のリソースの数)',
    params: [
      { name: 'config-rule-names', type: 'list', desc: 'ルール名で絞る (複数可)' },
      { name: 'compliance-types', type: 'list', desc: 'COMPLIANT / NON_COMPLIANT / INSUFFICIENT_DATA で絞る' },
    ],
    readOnly: true,
    examples: ['aws configservice describe-compliance-by-config-rule --compliance-types NON_COMPLIANT'],
    run(ctx) {
      const names = strs(ctx, 'config-rule-names');
      const types = complianceTypes(ctx);
      const rules = names.length ? names.map((n) => ruleNamed(ctx.env, n)) : ctx.env.configRules;
      return {
        ComplianceByConfigRules: rules
          .map((r) => {
            const evals = evaluateRule(ctx.env, r);
            const bad = evals.filter((e) => e.compliance === 'NON_COMPLIANT').length;
            const type = !evals.length ? 'INSUFFICIENT_DATA' : bad ? 'NON_COMPLIANT' : 'COMPLIANT';
            return { ConfigRuleName: r.configRuleName, Compliance: { ComplianceType: type, ...(bad ? { ComplianceContributorCount: { CappedCount: bad, CapExceeded: false } } : {}) } };
          })
          .filter((x) => !types.length || types.includes(x.Compliance.ComplianceType)),
      };
    },
  },
  {
    name: 'get-compliance-details-by-config-rule',
    desc: '1 つのルールが評価したリソースごとの結果 (どのリソースが非準拠か)',
    params: [
      { name: 'config-rule-name', type: 'string', required: true, desc: 'ルール名' },
      { name: 'compliance-types', type: 'list', desc: 'COMPLIANT / NON_COMPLIANT で絞る' },
    ],
    readOnly: true,
    examples: ['aws configservice get-compliance-details-by-config-rule --config-rule-name restricted-ssh --compliance-types NON_COMPLIANT'],
    run(ctx) {
      const r = ruleNamed(ctx.env, req(ctx, 'config-rule-name'));
      const types = complianceTypes(ctx);
      return {
        EvaluationResults: evaluateRule(ctx.env, r)
          .filter((e) => !types.length || types.includes(e.compliance))
          .map((e) => {
            const at = evaluatedAt(ctx.env, r, e.resourceType, e.resourceId);
            return {
              EvaluationResultIdentifier: { EvaluationResultQualifier: { ConfigRuleName: r.configRuleName, ResourceType: e.resourceType, ResourceId: e.resourceId, EvaluationMode: 'DETECTIVE' }, OrderingTimestamp: iso(at) },
              ComplianceType: e.compliance,
              ResultRecordedTime: iso(at + 2000),
              ConfigRuleInvokedTime: iso(at + 1000),
              ...(e.annotation ? { Annotation: e.annotation } : {}),
            };
          }),
      };
    },
  },
  {
    name: 'get-resource-config-history',
    desc: 'リソースの設定項目 (いまの設定と、それを記録した時刻) を引く',
    params: [
      { name: 'resource-type', type: 'string', required: true, desc: 'AWS::EC2::SecurityGroup / AWS::EC2::Instance / AWS::RDS::DBInstance / AWS::S3::Bucket' },
      { name: 'resource-id', type: 'string', required: true, desc: 'リソース ID (sg-...、i-...、RDS は db-...、S3 はバケット名)' },
    ],
    readOnly: true,
    examples: ['aws configservice get-resource-config-history --resource-type AWS::EC2::SecurityGroup --resource-id sg-0123456789abcdef0'],
    run(ctx) {
      const type = req(ctx, 'resource-type');
      const id = req(ctx, 'resource-id');
      if (!configurationItem(ctx.env, type, id)) throw new AwsError('ResourceNotDiscoveredException', `Resource ${id} of resourceType:${type} is unknown or has not been discovered`);
      // ponytail: sim は過去の設定を持たないので、いまの設定項目 1 つだけ (記録した時刻 = 最後の変更)。過去の設定が要るレッスンが来たら履歴を持たせる
      const last = resourceEvents(ctx.env, type, id)[0]?.eventTime ?? Math.min(...ctx.env.configRules.map((r) => r.createdAt), ctx.now);
      const info = resourceInfo(ctx.env, type, id);
      return {
        configurationItems: [
          {
            version: '1.3',
            accountId: ctx.env.accountId,
            configurationItemCaptureTime: iso(last),
            configurationItemStatus: 'OK',
            configurationStateId: String(last),
            configurationItemMD5Hash: '',
            arn: info.arn,
            resourceType: type,
            resourceId: id,
            ...(info.resourceName ? { resourceName: info.resourceName } : {}),
            awsRegion: ctx.env.region,
            availabilityZone: info.availabilityZone,
            tags: info.tags,
            // version 1.3 の設定項目では relatedEvents は空。誰が変えたかは CloudTrail (lookup-events) で引く
            relatedEvents: [],
            relationships: [],
            configuration: JSON.stringify(info.configuration),
            supplementaryConfiguration: {},
          },
        ],
      };
    },
  },
];

export default service('configservice', 'AWS Config (設定がルールどおりかの評価・設定の履歴)', ops);
