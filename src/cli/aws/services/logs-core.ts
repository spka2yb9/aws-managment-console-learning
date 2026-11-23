/* aws logs — 参照系 (ロググループ・ログストリーム・ログイベントの検索、tail) */
import { filterLogEvents, logStreams, MINUTE } from '../../../sim/cloudwatch';
import { AwsError, int, iso, service, str, strs, type OpContext, type OperationSpec } from '../types';

/** 開始時刻を省いたとき: 本物はロググループ (ストリーム) の頭から読む。生成するログは 1 分ずつ作るので、作成時刻か 1 日前の遅いほうから */
const from = (ctx: OpContext, g: { creationTime: number }) => int(ctx, 'start-time') ?? Math.max(g.creationTime, ctx.now - 1440 * MINUTE);

const groupOf = (ctx: OpContext, name: string) => {
  const g = ctx.env.logGroups.find((x) => x.logGroupName === name);
  if (!g) throw new AwsError('ResourceNotFoundException', 'The specified log group does not exist.');
  return g;
};

/** --since 10m / 1h / 2d (aws logs tail の書き方) */
function since(v: string | undefined, now: number): number {
  const m = /^(\d+)\s*([smhdw])$/.exec(v ?? '10m');
  if (!m) return now - 10 * MINUTE;
  return now - Number(m[1]) * { s: 1000, m: MINUTE, h: 60 * MINUTE, d: 1440 * MINUTE, w: 7 * 1440 * MINUTE }[m[2] as 's']!;
}

const ops: OperationSpec[] = [
  {
    name: 'describe-log-groups',
    desc: 'ロググループの一覧 (保持期間・保存量)',
    params: [{ name: 'log-group-name-prefix', type: 'string', desc: '名前の頭で絞る' }],
    readOnly: true,
    run(ctx) {
      const prefix = str(ctx, 'log-group-name-prefix') ?? '';
      return {
        logGroups: ctx.env.logGroups
          .filter((g) => g.logGroupName.startsWith(prefix))
          .sort((a, b) => a.logGroupName.localeCompare(b.logGroupName))
          .map((g) => ({ logGroupName: g.logGroupName, creationTime: g.creationTime, ...(g.retentionInDays ? { retentionInDays: g.retentionInDays } : {}), metricFilterCount: 0, arn: g.arn, storedBytes: 0, logGroupClass: 'STANDARD', logGroupArn: g.arn.replace(/:\*$/, '') })),
      };
    },
  },
  {
    name: 'describe-log-streams',
    desc: 'ロググループの中のログストリームの一覧',
    params: [
      { name: 'log-group-name', type: 'string', required: true, desc: 'ロググループ名' },
      { name: 'order-by', type: 'string', desc: 'LogStreamName / LastEventTime' },
      { name: 'descending', type: 'boolean', desc: '新しい順' },
    ],
    readOnly: true,
    run(ctx) {
      const g = groupOf(ctx, str(ctx, 'log-group-name')!);
      return { logStreams: logStreams(ctx.env, g, ctx.now).map((s) => ({ logStreamName: s.logStreamName, creationTime: g.creationTime, ...(s.lastEventTime ? { firstEventTimestamp: g.creationTime, lastEventTimestamp: s.lastEventTime, lastIngestionTime: s.lastEventTime + 200 } : {}), arn: `${g.arn.replace(/:\*$/, '')}:log-stream:${s.logStreamName}`, storedBytes: 0 })) };
    },
  },
  {
    name: 'filter-log-events',
    desc: 'ロググループのイベントを、時間とフィルターパターンで検索する',
    params: [
      { name: 'log-group-name', type: 'string', required: true, desc: 'ロググループ名' },
      { name: 'log-stream-names', type: 'list', desc: 'ログストリームで絞る' },
      { name: 'start-time', type: 'integer', desc: '開始 (エポックミリ秒)。省略するとロググループの最初から' },
      { name: 'end-time', type: 'integer', desc: '終了 (エポックミリ秒)' },
      { name: 'filter-pattern', type: 'string', desc: '例: ERROR / "Query_time" / ?WARN ?ERROR' },
      { name: 'limit', type: 'integer', desc: '最大件数' },
    ],
    readOnly: true,
    examples: ['aws logs filter-log-events --log-group-name /webapp/app --filter-pattern ERROR --limit 5'],
    run(ctx) {
      const g = groupOf(ctx, str(ctx, 'log-group-name')!);
      const streams = strs(ctx, 'log-stream-names');
      const events = filterLogEvents(ctx.env, g, { start: from(ctx, g), end: int(ctx, 'end-time') ?? ctx.now, pattern: str(ctx, 'filter-pattern'), limit: int(ctx, 'limit') ?? 200 }).filter((e) => !streams.length || streams.includes(e.logStreamName));
      return { events: events.map((e, n) => ({ logStreamName: e.logStreamName, timestamp: e.timestamp, message: e.message, ingestionTime: e.timestamp + 200, eventId: `${e.timestamp}${String(n).padStart(6, '0')}` })), searchedLogStreams: [] };
    },
  },
  {
    name: 'get-log-events',
    desc: '1 つのログストリームのイベントを読む',
    params: [
      { name: 'log-group-name', type: 'string', required: true, desc: 'ロググループ名' },
      { name: 'log-stream-name', type: 'string', required: true, desc: 'ログストリーム名' },
      { name: 'start-time', type: 'integer', desc: '開始 (エポックミリ秒)' },
      { name: 'end-time', type: 'integer', desc: '終了 (エポックミリ秒)' },
      { name: 'limit', type: 'integer', desc: '最大件数' },
      { name: 'start-from-head', type: 'boolean', desc: '古いほうから読む' },
    ],
    readOnly: true,
    run(ctx) {
      const g = groupOf(ctx, str(ctx, 'log-group-name')!);
      const events = filterLogEvents(ctx.env, g, { start: from(ctx, g), end: int(ctx, 'end-time') ?? ctx.now, stream: str(ctx, 'log-stream-name'), limit: int(ctx, 'limit') ?? 100 });
      return { events: events.map((e) => ({ timestamp: e.timestamp, message: e.message, ingestionTime: e.timestamp + 200 })), nextForwardToken: 'f/00000000000000000000000000000000000000000000000000000000', nextBackwardToken: 'b/00000000000000000000000000000000000000000000000000000000' };
    },
  },
  {
    name: 'tail',
    desc: 'ロググループの最近のログを、時刻つきで読みやすく表示する',
    params: [
      { name: 'group-name', type: 'string', required: true, positional: true, desc: 'ロググループ名' },
      { name: 'since', type: 'string', desc: 'どれだけ前から (例: 10m、1h、2d。既定 10m)' },
      { name: 'filter-pattern', type: 'string', desc: 'フィルターパターン' },
      { name: 'log-stream-names', type: 'list', desc: 'ログストリームで絞る' },
      { name: 'format', type: 'string', desc: 'detailed (既定) / short' },
      { name: 'follow', type: 'boolean', desc: '(このシミュレーターでは無視) 新しいログを待ち続ける' },
    ],
    readOnly: true,
    raw: true,
    examples: ['aws logs tail /webapp/app --since 30m --filter-pattern ERROR'],
    run(ctx) {
      const g = groupOf(ctx, str(ctx, 'group-name')!);
      const streams = strs(ctx, 'log-stream-names');
      const events = filterLogEvents(ctx.env, g, { start: since(str(ctx, 'since'), ctx.now), end: ctx.now, pattern: str(ctx, 'filter-pattern'), limit: 300 }).filter((e) => !streams.length || streams.includes(e.logStreamName));
      const short = str(ctx, 'format') === 'short';
      return events.map((e) => (short ? `${iso(e.timestamp)!.slice(0, 19)} ${e.message}` : `${iso(e.timestamp)!.replace('+00:00', '.000000+00:00')} ${e.logStreamName} ${e.message}`)).join('\n');
    },
  },
];

export default service('logs', 'Amazon CloudWatch Logs (ロググループ・ログの検索)', ops);
