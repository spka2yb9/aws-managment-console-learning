/* aws guardduty — ディテクター、検出結果 (一覧・取得・統計・アーカイブ)、フィルター (action ARCHIVE = 抑制ルール)。
   コンソールと同じ sim/ext/guardduty.ts の関数を使う。検出結果は GuardDuty の JSON (キャメルケース) で持っているので、キーをパスカルケースにして返す */
import { countBySeverity, createFilter, deleteFilter, getDetector, listFindings, parseCriterion, setArchived, type Criterion, type FindingFilter } from '../../../sim/ext/guardduty';
import { AwsError, int, iso, req, service, str, strs, struct, type OpContext, type OperationSpec } from '../types';

/** { accessKeyDetails: { userName } } → { AccessKeyDetails: { UserName } } (the CLI's output shape) */
const pascalKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(pascalKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k[0].toUpperCase() + k.slice(1), pascalKeys(x)])) : v;

const detector = { name: 'detector-id', type: 'string' as const, required: true, desc: 'ディテクター ID (aws guardduty list-detectors で調べる)' };
const criteriaParam = { name: 'finding-criteria', type: 'structure' as const, desc: `絞り込みの条件。'{"Criterion":{"severity":{"Gte":7}}}' (条件: Eq / Neq / Gt / Gte / Lt / Lte / Equals / NotEquals ...)` };
const sortParam = { name: 'sort-criteria', type: 'structure' as const, desc: 'AttributeName=severity,OrderBy=DESC' };
const findingIds = { name: 'finding-ids', type: 'list' as const, required: true, desc: '検出結果 ID (空白区切りで複数可)' };
const filterName = { name: 'filter-name', type: 'string' as const, required: true, desc: 'フィルター (抑制ルール) の名前' };

const detectorId = (ctx: OpContext) => getDetector(ctx.env, req(ctx, 'detector-id')).detectorId;
const criterion = (ctx: OpContext, wildcards = false): Criterion => {
  const c = struct(ctx, 'finding-criteria');
  return c ? parseCriterion(c, { wildcards }) : {};
};
const sort = (ctx: OpContext) => {
  const s = struct(ctx, 'sort-criteria');
  if (!s) return undefined;
  const orderBy = String(s.OrderBy ?? 'ASC');
  if (orderBy !== 'ASC' && orderBy !== 'DESC') throw new AwsError('BadRequestException', 'The request is rejected because an invalid or out-of-range value is specified as an input parameter.');
  return { attributeName: String(s.AttributeName ?? 'updatedAt'), orderBy: orderBy as 'ASC' | 'DESC' };
};
const filterOut = (f: FindingFilter) => ({ Name: f.name, ...(f.description ? { Description: f.description } : {}), Action: f.action, Rank: f.rank, FindingCriteria: { Criterion: f.criterion }, Tags: {} });

const ops: OperationSpec[] = [
  {
    name: 'list-detectors',
    desc: 'このリージョンのディテクター (GuardDuty 本体。リージョンに 1 つ) の ID',
    params: [],
    readOnly: true,
    run: (ctx) => ({ DetectorIds: ctx.env.guardDuty ? [ctx.env.guardDuty.detectorId] : [] }),
  },
  {
    name: 'get-detector',
    desc: 'ディテクターの状態と設定',
    params: [detector],
    readOnly: true,
    run(ctx) {
      const d = getDetector(ctx.env, req(ctx, 'detector-id'));
      return {
        CreatedAt: iso(d.createdAt)?.replace('+00:00', '.000Z'),
        FindingPublishingFrequency: d.findingPublishingFrequency,
        ServiceRole: `arn:aws:iam::${ctx.env.accountId}:role/aws-service-role/guardduty.amazonaws.com/AWSServiceRoleForAmazonGuardDuty`,
        Status: d.status,
        UpdatedAt: iso(d.createdAt)?.replace('+00:00', '.000Z'),
        Features: ['CLOUD_TRAIL', 'DNS_LOGS', 'FLOW_LOGS'].map((Name) => ({ Name, Status: 'ENABLED', UpdatedAt: iso(d.createdAt) })),
        Tags: {},
      };
    },
  },
  {
    name: 'list-findings',
    desc: '検出結果の ID の一覧 (アーカイブ済みも含む。--finding-criteria で絞る)',
    params: [detector, criteriaParam, sortParam, { name: 'max-results', type: 'integer', desc: '最大件数 (1〜50)' }],
    readOnly: true,
    examples: [`aws guardduty list-findings --detector-id <ID> --finding-criteria '{"Criterion":{"severity":{"Gte":7},"service.archived":{"Eq":["false"]}}}'`],
    run(ctx) {
      const found = listFindings(ctx.env, detectorId(ctx), criterion(ctx), sort(ctx));
      return { FindingIds: found.slice(0, int(ctx, 'max-results') ?? 50).map((f) => f.id) };
    },
  },
  {
    name: 'get-findings',
    desc: '検出結果の中身 (重要度、タイプ、リソース、アクション、アクターなど)',
    params: [detector, findingIds, sortParam],
    readOnly: true,
    examples: ['aws guardduty get-findings --detector-id <ID> --finding-ids <検出結果 ID>'],
    run(ctx) {
      const ids = strs(ctx, 'finding-ids');
      // unknown ids are simply not returned (like the API)
      return { Findings: listFindings(ctx.env, detectorId(ctx), {}, sort(ctx)).filter((f) => ids.includes(f.id)).map(pascalKeys) };
    },
  },
  {
    name: 'get-findings-statistics',
    desc: '検出結果の件数を重要度やタイプごとに数える',
    params: [detector, { name: 'finding-statistic-types', type: 'list', desc: 'COUNT_BY_SEVERITY' }, criteriaParam, { name: 'group-by', type: 'string', desc: 'SEVERITY / FINDING_TYPE (--finding-statistic-types とは同時に使えない)' }],
    readOnly: true,
    examples: [`aws guardduty get-findings-statistics --detector-id <ID> --finding-statistic-types COUNT_BY_SEVERITY --finding-criteria '{"Criterion":{"service.archived":{"Eq":["false"]}}}'`],
    run(ctx) {
      const types = strs(ctx, 'finding-statistic-types');
      const groupBy = str(ctx, 'group-by');
      if (types.length && groupBy) throw new AwsError('BadRequestException', 'The request is rejected because both findingStatisticTypes and groupBy are specified. Specify only one of them.');
      if (types.some((t) => t !== 'COUNT_BY_SEVERITY')) throw new AwsError('BadRequestException', 'The request is rejected because an invalid or out-of-range value is specified as an input parameter.');
      const found = listFindings(ctx.env, detectorId(ctx), criterion(ctx));
      if (!groupBy) return { FindingStatistics: { CountBySeverity: countBySeverity(found) } };
      const group = (key: (f: (typeof found)[number]) => string | number) => [...new Set(found.map(key))].map((k) => {
        const of = found.filter((f) => key(f) === k);
        return { k, TotalFindings: of.length, LastGeneratedAt: iso(Math.max(...of.map((f) => Date.parse(f.updatedAt)))) };
      }).sort((a, b) => b.TotalFindings - a.TotalFindings);
      if (groupBy === 'SEVERITY') return { FindingStatistics: { GroupedBySeverity: group((f) => f.severity).map(({ k, ...g }) => ({ Severity: k, ...g })) } };
      if (groupBy === 'FINDING_TYPE') return { FindingStatistics: { GroupedByFindingType: group((f) => f.type).map(({ k, ...g }) => ({ FindingType: k, ...g })) } };
      throw new AwsError('BadRequestException', `The request is rejected because an invalid or out-of-range value is specified as an input parameter. (このシミュレーターの --group-by は SEVERITY / FINDING_TYPE)`);
    },
  },
  {
    name: 'archive-findings',
    desc: '検出結果をアーカイブする (対応済み・問題なしとして「現在」の一覧から外す)',
    params: [detector, findingIds],
    run(ctx) {
      setArchived(ctx.env, detectorId(ctx), strs(ctx, 'finding-ids'), true);
      return undefined;
    },
  },
  {
    name: 'unarchive-findings',
    desc: 'アーカイブした検出結果を「現在」に戻す',
    params: [detector, findingIds],
    run(ctx) {
      setArchived(ctx.env, detectorId(ctx), strs(ctx, 'finding-ids'), false);
      return undefined;
    },
  },
  {
    name: 'create-filter',
    desc: 'フィルターを保存する。--action ARCHIVE なら抑制ルール (一致する新しい検出結果を自動でアーカイブ)',
    params: [
      detector,
      { name: 'name', type: 'string', required: true, desc: '名前 (3〜64 文字。英数字と . - _)' },
      { name: 'action', type: 'string', desc: 'NOOP (既定。保存するだけ) / ARCHIVE (抑制ルール)' },
      { name: 'description', type: 'string', desc: '説明' },
      { name: 'rank', type: 'integer', desc: '順番 (1 から)' },
      { ...criteriaParam, required: true, desc: `${criteriaParam.desc}。フィルターでは Matches / NotMatches (ワイルドカード * ?) も使える` },
    ],
    examples: [`aws guardduty create-filter --detector-id <ID> --name scanner-portscan --action ARCHIVE --finding-criteria '{"Criterion":{"type":{"Eq":["Recon:EC2/Portscan"]},"resource.instanceDetails.instanceId":{"Eq":["i-0123456789abcdef0"]}}}'`],
    run(ctx) {
      const action = str(ctx, 'action');
      const f = createFilter(ctx.env, detectorId(ctx), { name: req(ctx, 'name'), description: str(ctx, 'description'), action: action as FindingFilter['action'] | undefined, rank: int(ctx, 'rank'), criterion: criterion(ctx, true) }, ctx.now);
      return { Name: f.name };
    },
  },
  {
    name: 'list-filters',
    desc: '保存したフィルター (抑制ルールを含む) の名前',
    params: [detector],
    readOnly: true,
    run: (ctx) => ({ FilterNames: getDetector(ctx.env, req(ctx, 'detector-id')).filters.map((f) => f.name) }),
  },
  {
    name: 'get-filter',
    desc: 'フィルターの中身 (Action が ARCHIVE なら抑制ルール)',
    params: [detector, filterName],
    readOnly: true,
    run(ctx) {
      const f = getDetector(ctx.env, req(ctx, 'detector-id')).filters.find((x) => x.name === req(ctx, 'filter-name'));
      if (!f) throw new AwsError('BadRequestException', 'The request is rejected because the input filterName does not exist.');
      return filterOut(f);
    },
  },
  {
    name: 'delete-filter',
    desc: 'フィルター (抑制ルール) を削除する',
    params: [detector, filterName],
    run(ctx) {
      deleteFilter(ctx.env, detectorId(ctx), req(ctx, 'filter-name'));
      return undefined;
    },
  },
];

export default service('guardduty', 'Amazon GuardDuty (脅威の検出)', ops);
