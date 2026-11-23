/* aws securityhub — Security Hub CSPM: セキュリティ標準とコントロール、検出結果 (ASFF) のワークフロー、自動化ルール。
   コントロールの評価はコンソールと同じ sim/ext/securityhub.ts で、いまの環境からその場で計算する */
import {
  asff,
  batchDisableStandards,
  batchEnableStandards,
  batchUpdateFindings,
  CONTROLS,
  createAutomationRule,
  deleteAutomationRules,
  enableSecurityHub,
  enabledControls,
  FILTER_FIELDS,
  fresh,
  getFindings,
  NORMALIZED,
  requireHub,
  standardByArn,
  standardDef,
  STANDARDS,
  subscriptionArn,
  type AutomationRule,
  type ControlDef,
  type FieldsUpdate,
  type Finding,
  type FindingFilters,
  type StandardKey,
} from '../../../sim/ext/securityhub';
import type { AwsEnv } from '../../../sim/types';
import { AwsError, bool, int, iso, ParamError, req, service, str, strs, struct, structs, type OpContext, type OperationSpec } from '../types';

const learnerArn = (env: AwsEnv) => `arn:aws:iam::${env.accountId}:user/learner`;
const remediationUrl = (id: string) => `https://docs.aws.amazon.com/console/securityhub/${id}/remediation`;
/** 参照系は、まだ時計が進んでいない変更も反映した環境で答える */
const view = (ctx: OpContext) => {
  const env = fresh(ctx.env, ctx.now);
  requireHub(env);
  return env;
};

/* ---- botocore と同じ引数の検査 (API を呼ぶ前に CLI が止める) ---- */

const RULE_FIELDS = FILTER_FIELDS.filter((f) => f !== 'Region');

function filtersOf(ctx: OpContext, name: string, what: string, fields: string[]): FindingFilters {
  const v = struct(ctx, name) ?? {};
  const errors: string[] = [];
  for (const [k, conds] of Object.entries(v)) {
    if (!fields.includes(k)) errors.push(`Unknown parameter in ${what}: "${k}", must be one of: ${fields.join(', ')}`);
    else if (!Array.isArray(conds)) errors.push(`Invalid type for parameter ${what}.${k}, value: ${JSON.stringify(conds)}, type: <class 'dict'>, valid types: <class 'list'>, <class 'tuple'>`);
  }
  if (errors.length) throw new ParamError(`Parameter validation failed:\n${errors.join('\n')}`);
  return v as FindingFilters;
}

function required(obj: Record<string, unknown> | undefined, keys: string[], where: string): string[] {
  return obj ? keys.filter((k) => obj[k] === undefined || obj[k] === '').map((k) => `Missing required parameter in ${where}: "${k}"`) : [];
}

/* ---- 応答の形 ---- */

const standardsSubscription = (env: AwsEnv, key: StandardKey, status = 'READY') => ({
  StandardsSubscriptionArn: subscriptionArn(env, key),
  StandardsArn: standardDef(key).arn(env.region),
  StandardsInput: {},
  StandardsStatus: status,
  StandardsControlsUpdatable: 'READY_FOR_UPDATES',
});

const controlEnabled = (env: AwsEnv, c: ControlDef) => enabledControls(env).includes(c);

const ruleMeta = (r: AutomationRule) => ({ RuleArn: r.ruleArn, RuleStatus: r.ruleStatus, RuleOrder: r.ruleOrder, RuleName: r.ruleName, Description: r.description, IsTerminal: r.isTerminal, CreatedAt: iso(r.createdAt), UpdatedAt: iso(r.updatedAt), CreatedBy: r.createdBy });

const SORT_FIELDS: Record<string, (f: Finding) => string | number> = {
  SeverityNormalized: (f) => NORMALIZED[f.severity],
  SeverityLabel: (f) => NORMALIZED[f.severity],
  UpdatedAt: (f) => f.updatedAt,
  CreatedAt: (f) => f.createdAt,
  Title: (f) => f.title,
  ComplianceSecurityControlId: (f) => f.controlId ?? '',
  ComplianceStatus: (f) => f.compliance ?? '',
  WorkflowStatus: (f) => f.workflow,
  ResourceId: (f) => f.resource.id,
  ProductName: (f) => f.productName,
};

function sortFindings(ctx: OpContext, items: Finding[]): Finding[] {
  const criteria = structs(ctx, 'sort-criteria');
  if (!criteria.length) return items;
  return [...items].sort((a, b) => {
    for (const c of criteria) {
      if (typeof c.Field !== 'string') throw new ParamError('Parameter validation failed:\nMissing required parameter in SortCriteria[0]: "Field"');
      const key = SORT_FIELDS[c.Field];
      if (!key) throw new AwsError('InvalidInputException', `(シミュレーター) SortCriteria の Field ${c.Field} には対応していません。対応: ${Object.keys(SORT_FIELDS).join(', ')}`);
      const x = key(a);
      const y = key(b);
      if (x !== y) return (x < y ? -1 : 1) * (String(c.SortOrder).toLowerCase() === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

const ruleArns = { name: 'automation-rules-arns', type: 'list' as const, required: true, desc: '自動化ルールの ARN (複数可)' };

const ops: OperationSpec[] = [
  {
    name: 'enable-security-hub',
    desc: 'このリージョンで Security Hub CSPM を有効にする (既定でセキュリティ標準 FSBP と CIS v1.2.0 も有効になる)',
    params: [
      { name: 'enable-default-standards', type: 'boolean', desc: '既定の標準を有効にする (--no-enable-default-standards で有効にしない)' },
      { name: 'control-finding-generator', type: 'string', desc: 'SECURITY_CONTROL (既定。コントロールごとに 1 つの検出結果) / STANDARD_CONTROL' },
      { name: 'tags', type: 'map', desc: 'Hub リソースのタグ (Key1=Value1,Key2=Value2)' },
    ],
    examples: ['aws securityhub enable-security-hub', 'aws securityhub enable-security-hub --no-enable-default-standards'],
    run(ctx) {
      const gen = str(ctx, 'control-finding-generator');
      if (gen && gen !== 'SECURITY_CONTROL') throw new AwsError('InvalidInputException', gen === 'STANDARD_CONTROL' ? '(シミュレーター) STANDARD_CONTROL (標準ごとの検出結果) には対応していません。SECURITY_CONTROL を使ってください' : `Invalid ControlFindingGenerator: ${gen}. Valid values: STANDARD_CONTROL, SECURITY_CONTROL`);
      enableSecurityHub(ctx.env, { enableDefaultStandards: bool(ctx, 'enable-default-standards') }, ctx.now);
      return undefined;
    },
  },
  {
    name: 'describe-hub',
    desc: 'Hub (このアカウント・リージョンの Security Hub CSPM) の ARN と、有効にした日時',
    params: [{ name: 'hub-arn', type: 'string', desc: 'Hub の ARN (省略可)' }],
    readOnly: true,
    run(ctx) {
      const hub = requireHub(ctx.env).hub!;
      const arn = str(ctx, 'hub-arn');
      if (arn && arn !== hub.hubArn) throw new AwsError('InvalidInputException', `Invalid HubArn: ${arn}`);
      return { HubArn: hub.hubArn, SubscribedAt: new Date(hub.subscribedAt).toISOString(), AutoEnableControls: true, ControlFindingGenerator: 'SECURITY_CONTROL' };
    },
  },
  {
    name: 'describe-standards',
    desc: '使えるセキュリティ標準の一覧 (このシミュレーターは FSBP と CIS v1.2.0)',
    params: [],
    readOnly: true,
    run(ctx) {
      requireHub(ctx.env);
      return { Standards: STANDARDS.map((s) => ({ StandardsArn: s.arn(ctx.env.region), Name: s.name, Description: s.description, EnabledByDefault: true, StandardsManagedBy: { Company: 'AWS', Product: 'Security Hub' } })) };
    },
  },
  {
    name: 'get-enabled-standards',
    desc: '有効にしているセキュリティ標準 (サブスクリプション) の一覧',
    params: [{ name: 'standards-subscription-arns', type: 'list', desc: 'サブスクリプションの ARN で絞る' }],
    readOnly: true,
    run(ctx) {
      const s = requireHub(ctx.env);
      const want = strs(ctx, 'standards-subscription-arns');
      return { StandardsSubscriptions: s.standards.map((x) => standardsSubscription(ctx.env, x.key)).filter((x) => !want.length || want.includes(x.StandardsSubscriptionArn)) };
    },
  },
  {
    name: 'batch-enable-standards',
    desc: 'セキュリティ標準を有効にする',
    params: [{ name: 'standards-subscription-requests', type: 'list', of: 'structure', required: true, desc: 'StandardsArn=arn:aws:securityhub:ap-northeast-1::standards/aws-foundational-security-best-practices/v/1.0.0' }],
    examples: ['aws securityhub batch-enable-standards --standards-subscription-requests StandardsArn=arn:aws:securityhub:ap-northeast-1::standards/aws-foundational-security-best-practices/v/1.0.0'],
    run(ctx) {
      const reqs = structs(ctx, 'standards-subscription-requests');
      const missing = reqs.flatMap((r, n) => required(r, ['StandardsArn'], `StandardsSubscriptionRequests[${n}]`));
      if (missing.length) throw new ParamError(`Parameter validation failed:\n${missing.join('\n')}`);
      const keys = batchEnableStandards(ctx.env, reqs.map((r) => String(r.StandardsArn)), ctx.now);
      return { StandardsSubscriptions: keys.map((k) => standardsSubscription(ctx.env, k)) };
    },
  },
  {
    name: 'batch-disable-standards',
    desc: 'セキュリティ標準を無効にする (その標準だけのコントロールの検出結果はアーカイブされる)',
    params: [{ name: 'standards-subscription-arns', type: 'list', required: true, desc: 'サブスクリプションの ARN (get-enabled-standards の StandardsSubscriptionArn)' }],
    run(ctx) {
      const keys = batchDisableStandards(ctx.env, strs(ctx, 'standards-subscription-arns'), ctx.now);
      return { StandardsSubscriptions: keys.map((k) => standardsSubscription(ctx.env, k, 'DELETING')) };
    },
  },
  {
    name: 'describe-standards-controls',
    desc: '有効にしている標準のコントロールの一覧 (重要度・説明・修復方法の URL)',
    params: [{ name: 'standards-subscription-arn', type: 'string', required: true, desc: 'サブスクリプションの ARN' }],
    readOnly: true,
    run(ctx) {
      const env = view(ctx);
      const arn = req(ctx, 'standards-subscription-arn');
      const s = env.securityHub!.standards.find((x) => subscriptionArn(env, x.key) === arn);
      if (!s) throw new AwsError('InvalidInputException', `Invalid StandardsSubscriptionArn: ${arn}`);
      const def = standardDef(s.key);
      return {
        Controls: CONTROLS.filter((c) => c.standards[s.key]).map((c) => ({
          StandardsControlArn: `arn:aws:securityhub:${env.region}:${env.accountId}:control/${def.path}/${c.standards[s.key]}`,
          ControlStatus: 'ENABLED',
          ControlStatusUpdatedAt: iso(s.subscribedAt),
          ControlId: s.key === 'cis' ? `CIS.${c.standards.cis}` : c.id,
          Title: c.title,
          Description: c.description,
          RemediationUrl: remediationUrl(c.id),
          SeverityRating: c.severity,
          RelatedRequirements: s.key === 'cis' ? [`CIS AWS Foundations Benchmark v1.2.0/${c.standards.cis}`] : [],
        })),
      };
    },
  },
  {
    name: 'list-security-control-definitions',
    desc: 'コントロール (EC2.19 など) の定義の一覧。--standards-arn で 1 つの標準に絞れる',
    params: [{ name: 'standards-arn', type: 'string', desc: '標準の ARN (describe-standards の StandardsArn)' }],
    readOnly: true,
    run(ctx) {
      requireHub(ctx.env);
      const arn = str(ctx, 'standards-arn');
      const std = arn ? standardByArn(ctx.env, arn) : undefined;
      if (arn && !std) throw new AwsError('InvalidInputException', `Invalid StandardsArn: ${arn}`);
      return {
        SecurityControlDefinitions: CONTROLS.filter((c) => !std || c.standards[std.key]).map((c) => ({ SecurityControlId: c.id, Title: c.title, Description: c.description, RemediationUrl: remediationUrl(c.id), SeverityRating: c.severity, CurrentRegionAvailability: 'AVAILABLE' })),
      };
    },
  },
  {
    name: 'batch-get-security-controls',
    desc: 'コントロールの詳細 (重要度、有効/無効)。合格・失敗は get-findings で調べる',
    params: [{ name: 'security-control-ids', type: 'list', required: true, desc: 'コントロール ID (EC2.19 RDS.2 など、複数可)' }],
    readOnly: true,
    examples: ['aws securityhub batch-get-security-controls --security-control-ids EC2.19 RDS.2'],
    run(ctx) {
      const env = view(ctx);
      const want = strs(ctx, 'security-control-ids');
      const found = want.map((id) => CONTROLS.find((c) => c.id === id)).filter((c): c is ControlDef => !!c);
      return {
        SecurityControls: found.map((c) => ({
          SecurityControlId: c.id,
          SecurityControlArn: `arn:aws:securityhub:${env.region}:${env.accountId}:security-control/${c.id}`,
          Title: c.title,
          Description: c.description,
          RemediationUrl: remediationUrl(c.id),
          SeverityRating: c.severity,
          SecurityControlStatus: controlEnabled(env, c) ? 'ENABLED' : 'DISABLED',
          UpdateStatus: 'READY',
          Parameters: {},
        })),
        UnprocessedIds: want.filter((id) => !found.some((c) => c.id === id)).map((id) => ({ SecurityControlId: id, ErrorCode: 'NOT_FOUND', ErrorReason: `Security control ${id} was not found.` })),
      };
    },
  },
  {
    name: 'get-findings',
    desc: '検出結果 (ASFF) の一覧。--filters で絞り、--sort-criteria で並べる',
    params: [
      { name: 'filters', type: 'structure', desc: "例: 'SeverityLabel=[{Value=CRITICAL,Comparison=EQUALS}],ComplianceStatus=[{Value=FAILED,Comparison=EQUALS}]'" },
      { name: 'sort-criteria', type: 'list', of: 'structure', desc: 'Field=SeverityNormalized,SortOrder=desc' },
      { name: 'max-results', type: 'integer', desc: '最大件数' },
    ],
    readOnly: true,
    examples: [
      "aws securityhub get-findings --filters 'SeverityLabel=[{Value=CRITICAL,Comparison=EQUALS}],ComplianceStatus=[{Value=FAILED,Comparison=EQUALS}]'",
      "aws securityhub get-findings --filters 'ComplianceSecurityControlId=[{Value=EC2.19,Comparison=EQUALS}]' --query 'Findings[].[Resources[0].Id,Compliance.Status,Workflow.Status]' --output table",
    ],
    run(ctx) {
      const env = view(ctx);
      const filters = filtersOf(ctx, 'filters', 'Filters', FILTER_FIELDS);
      const max = int(ctx, 'max-results');
      if (max !== undefined && (max < 1 || max > 100)) throw new AwsError('InvalidInputException', 'MaxResults must be between 1 and 100.');
      const items = sortFindings(ctx, getFindings(env, filters));
      return { Findings: items.slice(0, max ?? items.length).map((f) => asff(env, f)) };
    },
  },
  {
    name: 'batch-update-findings',
    desc: '検出結果のワークフローのステータス・重要度・メモを変える (確認した人が使う)',
    params: [
      { name: 'finding-identifiers', type: 'list', of: 'structure', required: true, desc: 'Id=検出結果の ID,ProductArn=製品の ARN (get-findings の Id と ProductArn)' },
      { name: 'workflow', type: 'structure', desc: 'Status=NEW / NOTIFIED / SUPPRESSED / RESOLVED' },
      { name: 'note', type: 'structure', desc: 'Text=メモ,UpdatedBy=書いた人' },
      { name: 'severity', type: 'structure', desc: 'Label=CRITICAL / HIGH / MEDIUM / LOW / INFORMATIONAL' },
    ],
    examples: ["aws securityhub batch-update-findings --finding-identifiers Id=arn:aws:securityhub:...,ProductArn=arn:aws:securityhub:ap-northeast-1::product/aws/securityhub --workflow Status=SUPPRESSED --note 'Text=\"理由\",UpdatedBy=learner'"],
    run(ctx) {
      const ids = structs(ctx, 'finding-identifiers');
      const workflow = struct(ctx, 'workflow');
      const note = struct(ctx, 'note');
      const severity = struct(ctx, 'severity');
      const missing = [...ids.flatMap((x, n) => required(x, ['Id', 'ProductArn'], `FindingIdentifiers[${n}]`)), ...required(note, ['Text', 'UpdatedBy'], 'Note')];
      if (missing.length) throw new ParamError(`Parameter validation failed:\n${missing.join('\n')}`);
      const u: FieldsUpdate = {
        ...(workflow ? { Workflow: { Status: String(workflow.Status ?? '') } } : {}),
        ...(note ? { Note: { Text: String(note.Text), UpdatedBy: String(note.UpdatedBy) } } : {}),
        ...(severity ? { Severity: { Label: String(severity.Label ?? '') } } : {}),
      };
      const r = batchUpdateFindings(ctx.env, ids.map((x) => ({ Id: String(x.Id), ProductArn: String(x.ProductArn) })), u, ctx.now);
      return { ProcessedFindings: r.processed, UnprocessedFindings: r.unprocessed };
    },
  },
  {
    name: 'create-automation-rule',
    desc: '自動化ルールを作る (条件に合う検出結果が作られた・更新されたときに、項目を自動で書き換える)',
    params: [
      { name: 'rule-name', type: 'string', required: true, desc: 'ルール名' },
      { name: 'rule-order', type: 'integer', required: true, desc: 'ルールの順序 (1〜1000。小さいものから適用)' },
      { name: 'description', type: 'string', required: true, desc: '説明' },
      { name: 'criteria', type: 'structure', required: true, desc: '条件 (get-findings の --filters と同じ形。file://criteria.json)' },
      { name: 'actions', type: 'list', of: 'structure', required: true, desc: '[{"Type":"FINDING_FIELDS_UPDATE","FindingFieldsUpdate":{...}}] (file://actions.json)' },
      { name: 'rule-status', type: 'string', desc: 'ENABLED (既定) / DISABLED' },
      { name: 'is-terminal', type: 'boolean', desc: '条件に合ったら後続のルールを適用しない' },
      { name: 'tags', type: 'map', desc: 'ルールのタグ' },
    ],
    examples: ['aws securityhub create-automation-rule --rule-name dev-low --rule-order 1 --description "dev は優先度を下げる" --criteria file://criteria.json --actions file://actions.json'],
    run(ctx) {
      const criteria = filtersOf(ctx, 'criteria', 'Criteria', RULE_FIELDS);
      const actions = structs(ctx, 'actions');
      const rule = createAutomationRule(
        ctx.env,
        { ruleName: req(ctx, 'rule-name'), description: req(ctx, 'description'), ruleOrder: int(ctx, 'rule-order')!, ruleStatus: str(ctx, 'rule-status'), isTerminal: bool(ctx, 'is-terminal'), criteria, actions: actions as { Type?: string; FindingFieldsUpdate?: FieldsUpdate }[] },
        learnerArn(ctx.env),
        ctx.now,
      );
      return { RuleArn: rule.ruleArn };
    },
  },
  {
    name: 'list-automation-rules',
    desc: '自動化ルールの一覧 (ルールの順序の順)',
    params: [{ name: 'max-results', type: 'integer', desc: '最大件数' }],
    readOnly: true,
    run(ctx) {
      const s = requireHub(ctx.env);
      const rules = [...s.automationRules].sort((a, b) => a.ruleOrder - b.ruleOrder);
      return { AutomationRulesMetadata: rules.slice(0, int(ctx, 'max-results') ?? rules.length).map(ruleMeta) };
    },
  },
  {
    name: 'batch-get-automation-rules',
    desc: '自動化ルールの中身 (条件とアクション)',
    params: [ruleArns],
    readOnly: true,
    run(ctx) {
      const s = requireHub(ctx.env);
      const arns = strs(ctx, 'automation-rules-arns');
      const rules = arns.map((a) => s.automationRules.find((r) => r.ruleArn === a)).filter((r): r is AutomationRule => !!r);
      return {
        Rules: rules.map((r) => ({ ...ruleMeta(r), Criteria: r.criteria, Actions: r.actions })),
        UnprocessedAutomationRules: arns.filter((a) => !rules.some((r) => r.ruleArn === a)).map((a) => ({ RuleArn: a, ErrorCode: 404, ErrorMessage: 'Automation rule not found.' })),
      };
    },
  },
  {
    name: 'batch-delete-automation-rules',
    desc: '自動化ルールを削除する',
    params: [ruleArns],
    run(ctx) {
      const r = deleteAutomationRules(ctx.env, strs(ctx, 'automation-rules-arns'));
      return { ProcessedAutomationRules: r.processed, UnprocessedAutomationRules: r.unprocessed.map((a) => ({ RuleArn: a, ErrorCode: 404, ErrorMessage: 'Automation rule not found.' })) };
    },
  },
];

export default service('securityhub', 'AWS Security Hub CSPM (セキュリティ標準・コントロール・検出結果・自動化ルール)', ops);
