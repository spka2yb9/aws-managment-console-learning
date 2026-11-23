/* aws accessanalyzer — IAM Access Analyzer。リージョンごとのサービス (scope は既定の regional)。
   応答のキーは実物と同じキャメルケース (analyzers / findings / findingDetails ...)。変更はコンソールと同じ sim/ext/accessanalyzer.ts の関数で行う */
import { analyzersOf, applyArchiveRule, checkFilter, createAnalyzer, createArchiveRule, deleteAnalyzer, deleteArchiveRule, getAnalyzer, getArchiveRule, getFinding, matchesFilter, startResourceScan, updateFindings, type Analyzer, type ArchiveRule, type Finding, type FindingFilter } from '../../../sim/ext/accessanalyzer';
import { AwsError, iso, list, req, service, str, strs, struct, structs, type OperationSpec } from '../types';

const analyzerOut = (a: Analyzer) => ({
  arn: a.arn,
  name: a.name,
  type: a.type,
  createdAt: iso(a.createdAt),
  ...(a.lastResourceAnalyzed ? { lastResourceAnalyzed: a.lastResourceAnalyzed, lastResourceAnalyzedAt: iso(a.lastResourceAnalyzedAt) } : {}),
  tags: {},
  status: a.status,
  ...(a.unusedAccessAge ? { configuration: { unusedAccess: { unusedAccessAge: a.unusedAccessAge, analysisRule: { exclusions: [] } } } } : {}),
});

const ruleOut = (r: ArchiveRule) => ({ ruleName: r.ruleName, filter: r.filter, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) });

const summaryOut = (f: Finding) => ({ analyzedAt: iso(f.analyzedAt), createdAt: iso(f.createdAt), id: f.id, resource: f.resource, resourceType: f.resourceType, resourceOwnerAccount: f.resourceOwnerAccount, status: f.status, updatedAt: iso(f.updatedAt), findingType: f.findingType });

function detailsOut(f: Finding) {
  if (f.findingType === 'UnusedIAMRole') return [{ unusedIamRoleDetails: f.lastAccessed ? { lastAccessed: iso(f.lastAccessed) } : {} }];
  if (f.findingType === 'UnusedPermission') return (f.unusedServices ?? []).map((s) => ({ unusedPermissionDetails: { serviceNamespace: s.serviceNamespace, ...(s.lastAccessed ? { lastAccessed: iso(s.lastAccessed) } : {}) } }));
  return [{ externalAccessDetails: { action: f.action, condition: f.condition ?? {}, isPublic: !!f.isPublic, principal: f.principal, ...(f.sources ? { sources: f.sources } : {}), resourceControlPolicyRestriction: 'NOT_APPLICABLE' } }];
}

/** --filter (shorthand principal.AWS={eq=[999988887777]} か JSON) を sim の形へ。値は 1 つでも配列にする */
function filterIn(raw: unknown): FindingFilter {
  return Object.fromEntries(
    Object.entries(raw && typeof raw === 'object' ? raw : {}).map(([key, v]) => {
      const c = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      return [key, { ...(c.eq !== undefined ? { eq: list(c.eq) } : {}), ...(c.neq !== undefined ? { neq: list(c.neq) } : {}), ...(c.contains !== undefined ? { contains: list(c.contains) } : {}), ...(c.exists !== undefined ? { exists: c.exists === true || c.exists === 'true' } : {}) }];
    }),
  );
}

const analyzerName = { name: 'analyzer-name', type: 'string' as const, required: true, desc: 'アナライザーの名前' };
const analyzerArn = { name: 'analyzer-arn', type: 'string' as const, required: true, desc: 'アナライザーの ARN (create-analyzer の arn)' };
const clientToken = { name: 'client-token', type: 'string' as const, desc: '冪等性のためのトークン (シミュレーターでは使わない)' };
const filterParam = { name: 'filter', type: 'map' as const, desc: '絞り込み。例: \'{"status": {"eq": ["ACTIVE"]}}\' / status={eq=[ACTIVE]}' };

const ops: OperationSpec[] = [
  /* ---- アナライザー ---- */
  {
    name: 'create-analyzer',
    desc: 'アナライザーを作る (--type ACCOUNT: 外部アクセス / ACCOUNT_UNUSED_ACCESS: 未使用のアクセス)',
    params: [
      analyzerName,
      { name: 'type', type: 'string', required: true, desc: 'ACCOUNT (信頼ゾーン = このアカウント) か ACCOUNT_UNUSED_ACCESS' },
      { name: 'configuration', type: 'structure', desc: "未使用のアクセスの追跡期間: '{\"unusedAccess\": {\"unusedAccessAge\": 90}}'" },
      { name: 'archive-rules', type: 'list', of: 'structure', desc: '作るときに付けるアーカイブルール (ruleName と filter)' },
      { name: 'tags', type: 'map', desc: 'タグ (Key=Value)' },
      clientToken,
    ],
    examples: ['aws accessanalyzer create-analyzer --analyzer-name webapp-external --type ACCOUNT', "aws accessanalyzer create-analyzer --analyzer-name webapp-unused --type ACCOUNT_UNUSED_ACCESS --configuration '{\"unusedAccess\": {\"unusedAccessAge\": 90}}'"],
    run(ctx) {
      const unused = (struct(ctx, 'configuration')?.unusedAccess ?? undefined) as Record<string, unknown> | undefined;
      const age = unused?.unusedAccessAge;
      if (age !== undefined && !/^\d+$/.test(String(age))) throw new AwsError('ValidationException', `Invalid value for unusedAccessAge: ${String(age)}`);
      const archiveRules = structs(ctx, 'archive-rules').map((r) => ({ ruleName: String(r.ruleName ?? ''), filter: filterIn(r.filter) }));
      return { arn: createAnalyzer(ctx.env, { name: req(ctx, 'analyzer-name'), type: req(ctx, 'type'), unusedAccessAge: age === undefined ? undefined : Number(age), archiveRules }, ctx.now) };
    },
  },
  {
    name: 'list-analyzers',
    desc: 'アナライザーの一覧',
    params: [{ name: 'type', type: 'string', desc: 'この種類だけ (ACCOUNT / ACCOUNT_UNUSED_ACCESS ...)' }],
    readOnly: true,
    run: (ctx) => ({ analyzers: analyzersOf(ctx.env).filter((a) => !str(ctx, 'type') || a.type === str(ctx, 'type')).map(analyzerOut) }),
  },
  {
    name: 'get-analyzer',
    desc: 'アナライザーの詳細',
    params: [analyzerName],
    readOnly: true,
    run: (ctx) => ({ analyzer: analyzerOut(getAnalyzer(ctx.env, req(ctx, 'analyzer-name'))) }),
  },
  {
    name: 'delete-analyzer',
    desc: 'アナライザーを削除する (検出結果とアーカイブルールも消える)',
    params: [analyzerName, clientToken],
    run(ctx) {
      deleteAnalyzer(ctx.env, getAnalyzer(ctx.env, req(ctx, 'analyzer-name')).name);
      return undefined;
    },
  },

  /* ---- 検出結果 ---- */
  {
    name: 'list-findings-v2',
    desc: '検出結果の一覧 (外部アクセス・未使用のアクセスとも。--filter で絞る)',
    params: [analyzerArn, filterParam, { name: 'sort', type: 'structure', desc: '並べ替え: attributeName=updatedAt,orderBy=DESC' }],
    readOnly: true,
    examples: ["aws accessanalyzer list-findings-v2 --analyzer-arn $ANALYZER_ARN --filter '{\"status\": {\"eq\": [\"ACTIVE\"]}}'"],
    run(ctx) {
      const a = getAnalyzer(ctx.env, req(ctx, 'analyzer-arn'));
      const filter = filterIn(struct(ctx, 'filter'));
      checkFilter(a, filter, false);
      const sort = struct(ctx, 'sort');
      const key = String(sort?.attributeName ?? '') as 'createdAt' | 'updatedAt' | 'analyzedAt';
      const items = a.findings.filter((f) => matchesFilter(f, filter));
      if (['createdAt', 'updatedAt', 'analyzedAt'].includes(key)) items.sort((x, y) => (x[key] - y[key]) * (sort?.orderBy === 'DESC' ? -1 : 1));
      return { findings: items.map(summaryOut) };
    },
  },
  {
    name: 'get-finding-v2',
    desc: '検出結果の詳細 (findingDetails に外部プリンシパルや未使用のサービス)',
    params: [analyzerArn, { name: 'id', type: 'string', required: true, desc: '検出結果の ID' }],
    readOnly: true,
    run(ctx) {
      const f = getFinding(getAnalyzer(ctx.env, req(ctx, 'analyzer-arn')), req(ctx, 'id'));
      return { ...summaryOut(f), findingDetails: detailsOut(f) };
    },
  },
  {
    name: 'update-findings',
    desc: '検出結果をアーカイブする (--status ARCHIVED) / アクティブに戻す (--status ACTIVE)',
    params: [analyzerArn, { name: 'status', type: 'string', required: true, desc: 'ARCHIVED か ACTIVE' }, { name: 'ids', type: 'list', desc: '検出結果の ID (複数可)' }, { name: 'resource-arn', type: 'string', desc: 'このリソースの検出結果すべて' }, clientToken],
    run(ctx) {
      updateFindings(ctx.env, req(ctx, 'analyzer-arn'), { status: req(ctx, 'status'), ids: strs(ctx, 'ids'), resourceArn: str(ctx, 'resource-arn') }, ctx.now);
      return undefined;
    },
  },
  {
    name: 'start-resource-scan',
    desc: 'リソースをすぐに分析し直す (外部アクセスのアナライザーだけ)',
    params: [analyzerArn, { name: 'resource-arn', type: 'string', required: true, desc: '分析するリソースの ARN' }, { name: 'resource-owner-account', type: 'string', desc: 'リソースを持つアカウント (省略するとこのアカウント)' }],
    run(ctx) {
      startResourceScan(ctx.env, req(ctx, 'analyzer-arn'), req(ctx, 'resource-arn'), ctx.now);
      return undefined;
    },
  },

  /* ---- アーカイブルール ---- */
  {
    name: 'create-archive-rule',
    desc: 'アーカイブルールを作る (自動でアーカイブするのはこれから見つかる検出結果。今ある検出結果には apply-archive-rule)',
    params: [analyzerName, { name: 'rule-name', type: 'string', required: true, desc: 'ルールの名前' }, { ...filterParam, required: true, desc: 'ルールの条件。例: \'{"principal.AWS": {"eq": ["999988887777"]}}\'' }, clientToken],
    examples: ["aws accessanalyzer create-archive-rule --analyzer-name webapp-external --rule-name partner-hayate --filter '{\"principal.AWS\": {\"eq\": [\"999988887777\"]}}'"],
    run(ctx) {
      createArchiveRule(ctx.env, req(ctx, 'analyzer-name'), req(ctx, 'rule-name'), filterIn(struct(ctx, 'filter')), ctx.now);
      return undefined;
    },
  },
  {
    name: 'list-archive-rules',
    desc: 'アナライザーのアーカイブルールの一覧',
    params: [analyzerName],
    readOnly: true,
    run: (ctx) => ({ archiveRules: getAnalyzer(ctx.env, req(ctx, 'analyzer-name')).archiveRules.map(ruleOut) }),
  },
  {
    name: 'get-archive-rule',
    desc: 'アーカイブルールの詳細',
    params: [analyzerName, { name: 'rule-name', type: 'string', required: true, desc: 'ルールの名前' }],
    readOnly: true,
    run: (ctx) => ({ archiveRule: ruleOut(getArchiveRule(getAnalyzer(ctx.env, req(ctx, 'analyzer-name')), req(ctx, 'rule-name'))) }),
  },
  {
    name: 'delete-archive-rule',
    desc: 'アーカイブルールを削除する (アーカイブ済みの検出結果はそのまま)',
    params: [analyzerName, { name: 'rule-name', type: 'string', required: true, desc: 'ルールの名前' }, clientToken],
    run(ctx) {
      deleteArchiveRule(ctx.env, req(ctx, 'analyzer-name'), req(ctx, 'rule-name'));
      return undefined;
    },
  },
  {
    name: 'apply-archive-rule',
    desc: 'アーカイブルールを今あるアクティブな検出結果にも当てて、一致するものをアーカイブする',
    params: [analyzerArn, { name: 'rule-name', type: 'string', required: true, desc: 'ルールの名前' }, clientToken],
    run(ctx) {
      applyArchiveRule(ctx.env, req(ctx, 'analyzer-arn'), req(ctx, 'rule-name'), ctx.now);
      return undefined;
    },
  },
];

export default service('accessanalyzer', 'IAM Access Analyzer (外部アクセスと未使用のアクセスの分析)', ops);
