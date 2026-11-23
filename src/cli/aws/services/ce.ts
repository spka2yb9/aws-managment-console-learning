/* aws ce (Cost Explorer) と aws budgets (AWS Budgets)。
   金額は sim/cost.ts の見積もり「今の構成のまま 1 か月動いたらいくらか」(請求とコスト管理の画面と同じ)。
   ponytail: 本物の get-cost-and-usage は実際に使った分を返すが、このシミュレーターは過去の請求を持たないので、どの期間も今の構成の見積もり (Estimated: true) を返す */
import { costLines, totalOf, type CostCategory, type CostLine } from '../../../sim/cost';
import { AwsError, req, service, strs, struct, structs, type OpContext, type OperationSpec } from '../types';

/** Cost Explorer の SERVICE の名前。NAT ゲートウェイとデータ転送は、本物と同じく EC2 - Other に入る */
const SERVICE_NAMES: Record<CostCategory, string> = {
  EC2: 'Amazon Elastic Compute Cloud - Compute',
  RDS: 'Amazon Relational Database Service',
  バックアップ: 'Amazon Relational Database Service',
  ELB: 'Amazon Elastic Load Balancing',
  'NAT ゲートウェイ': 'EC2 - Other',
  データ転送: 'EC2 - Other',
  'CloudWatch Logs': 'AmazonCloudWatch',
};
const COST_METRICS = ['UnblendedCost', 'BlendedCost', 'AmortizedCost', 'NetUnblendedCost', 'NetAmortizedCost'];
const DAY = 86_400_000;
const date = (t: number) => new Date(t).toISOString().slice(0, 10);
const monthStart = (t: number) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), 1);
const nextMonth = (t: number) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1);
const usd = (n: number) => ({ Amount: n.toFixed(2), Unit: 'USD' });

function parseDate(v: unknown, name: string): number {
  const s = String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new AwsError('ValidationException', `${name} date is invalid: ${s} (YYYY-MM-DD で指定します)`);
  return Date.parse(s);
}

/** --group-by の 1 つ分: その明細がどのグループに入るか */
function grouper(g: Record<string, unknown>): (l: CostLine) => string {
  const key = String(g.Key ?? '');
  if (g.Type === 'DIMENSION' && key === 'SERVICE') return (l) => SERVICE_NAMES[l.category];
  if (g.Type === 'TAG' && key === 'Environment') return (l) => `Environment$${l.environment === '開発' ? 'dev' : 'prod'}`;
  if (g.Type === 'TAG' && key === 'Name') return (l) => `Name$${l.resource}`;
  if (g.Type === 'TAG') return () => `${key}$`;
  if (g.Type === 'DIMENSION') throw new AwsError('ValidationException', `(シミュレーター) このシミュレーターの Cost Explorer で分けられる DIMENSION は SERVICE だけです (${key})`);
  throw new AwsError('ValidationException', `1 validation error detected: Value '${String(g.Type)}' at 'groupBy.1.member.type' failed to satisfy constraint: Member must satisfy enum value set: [DIMENSION, TAG, COST_CATEGORY]`);
}

function costAndUsage(ctx: OpContext) {
  const tp = struct(ctx, 'time-period') ?? {};
  const start = parseDate(tp.Start, 'Start');
  const end = parseDate(tp.End, 'End');
  if (start >= end) throw new AwsError('ValidationException', 'Start date (and hour) should be before end date (and hour)');
  const granularity = req(ctx, 'granularity');
  if (granularity !== 'MONTHLY' && granularity !== 'DAILY') throw new AwsError('ValidationException', `(シミュレーター) このシミュレーターの Cost Explorer は --granularity MONTHLY / DAILY だけに対応しています (${granularity})`);
  const metrics = strs(ctx, 'metrics');
  const bad = metrics.filter((m) => !COST_METRICS.includes(m));
  if (bad.length) throw new AwsError('ValidationException', `Metrics are invalid: ${bad.join(', ')} (このシミュレーターで使えるのは ${COST_METRICS.join(' / ')})`);
  const groupBy = structs(ctx, 'group-by');
  if (groupBy.length > 2) throw new AwsError('ValidationException', 'You can only group by up to two different dimensions, tags or cost categories.');
  const keys = groupBy.map(grouper);
  const lines = costLines(ctx.env, ctx.now);
  const ResultsByTime = [];
  for (let s = start; s < end; ) {
    const e = Math.min(end, granularity === 'DAILY' ? s + DAY : nextMonth(s));
    // その期間が月のどれだけか (月額の見積もりを日割りにする)
    const share = (e - s) / (nextMonth(s) - monthStart(s));
    const metricsOf = (ls: CostLine[]) => Object.fromEntries(metrics.map((m) => [m, usd(totalOf(ls) * share)]));
    const groups = new Map<string, CostLine[]>();
    for (const l of keys.length ? lines : []) {
      const k = JSON.stringify(keys.map((f) => f(l)));
      groups.set(k, [...(groups.get(k) ?? []), l]);
    }
    ResultsByTime.push({
      TimePeriod: { Start: date(s), End: date(e) },
      Total: keys.length ? {} : metricsOf(lines),
      Groups: [...groups].sort((a, b) => totalOf(b[1]) - totalOf(a[1])).map(([k, ls]) => ({ Keys: JSON.parse(k) as string[], Metrics: metricsOf(ls) })),
      Estimated: true,
    });
    s = e;
  }
  return { GroupDefinitions: groupBy.map((g) => ({ Type: g.Type, Key: g.Key })), ResultsByTime, DimensionValueAttributes: [] };
}

const ce: OperationSpec[] = [
  {
    name: 'get-cost-and-usage',
    desc: '期間のコストを、サービス別・タグ別などに分けて見る (このシミュレーターでは、今の構成のまま 1 か月動いた場合の見積もり)',
    params: [
      { name: 'time-period', type: 'structure', required: true, desc: '期間。例: Start=2026-11-01,End=2026-12-01 (End の日は含まない)' },
      { name: 'granularity', type: 'string', required: true, desc: 'MONTHLY / DAILY' },
      { name: 'metrics', type: 'list', required: true, desc: 'UnblendedCost など' },
      { name: 'group-by', type: 'list', of: 'structure', desc: '分け方 (2 つまで)。例: Type=DIMENSION,Key=SERVICE / Type=TAG,Key=Environment' },
    ],
    readOnly: true,
    scope: 'global',
    examples: ['aws ce get-cost-and-usage --time-period Start=2026-11-01,End=2026-12-01 --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE'],
    run: costAndUsage,
  },
];

const budgets: OperationSpec[] = [
  {
    name: 'describe-budgets',
    desc: '予算の一覧 (予算額と、今月の実績・月末の予測)',
    params: [{ name: 'account-id', type: 'string', required: true, desc: 'AWS アカウント ID (aws sts get-caller-identity の Account)' }],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const account = req(ctx, 'account-id');
      if (account !== ctx.env.accountId) throw new AwsError('AccessDeniedException', `User: arn:aws:iam::${ctx.env.accountId}:user/learner is not authorized to perform: budgets:ViewBudget on resource: arn:aws:budgets::${account}:budget/*`);
      const total = totalOf(costLines(ctx.env, ctx.now));
      const from = monthStart(ctx.now);
      const actual = (total * (ctx.now - from)) / (nextMonth(ctx.now) - from);
      return {
        Budgets: ctx.env.budgets.map((b) => ({
          BudgetName: b.budgetName,
          BudgetLimit: { Amount: b.limitUsd.toFixed(1), Unit: 'USD' },
          CostFilters: {},
          TimeUnit: 'MONTHLY',
          TimePeriod: { Start: `${date(Date.UTC(new Date(ctx.now).getUTCFullYear(), 0, 1))}T00:00:00+00:00`, End: '2087-06-15T00:00:00+00:00' },
          CalculatedSpend: { ActualSpend: usd(actual), ForecastedSpend: usd(total) },
          BudgetType: 'COST',
          LastUpdatedTime: new Date(ctx.now).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
        })),
      };
    },
  },
];

export default [service('ce', 'AWS Cost Explorer (コストをサービス別・タグ別に見る)', ce), service('budgets', 'AWS Budgets (予算と予測)', budgets)];
