/* aws arc-zonal-shift — Route 53 ARC のゾーンシフト (1 つの AZ からトラフィックを一時的に移す)、ゾーンオートシフトと練習実行。
   リソースは ARN、AZ は AZ ID (apne1-az1 など。aws ec2 describe-availability-zones の ZoneId) で指定する */
import { getLb } from '../../../sim/env';
import {
  appliedWeights,
  autoshiftsAt,
  azIdOf,
  cancelZonalShift,
  configOf,
  createPracticeRunConfiguration,
  deletePracticeRunConfiguration,
  getManagedResource,
  lbAzs,
  managedResources,
  shiftsOf,
  startPracticeRun,
  startZonalShift,
  updatePracticeRunConfiguration,
  updateZonalAutoshiftConfiguration,
  updateZonalShift,
  AUTOSHIFT_DETECT_MS,
  type ControlCondition,
  type ManagedResource,
  type PracticeRunConfiguration,
  type ZonalShift,
} from '../../../sim/ext/zonalshift';
import type { AwsEnv } from '../../../sim/types';
import { AwsError, iso, req, service, str, strs, structs, type OpContext, type OperationSpec } from '../types';

const RESOURCE = { name: 'resource-identifier', type: 'string' as const, required: true, desc: 'リソースの ARN (ロードバランサーの ARN)' };
const SHIFT_ID = { name: 'zonal-shift-id', type: 'string' as const, required: true, desc: 'ゾーンシフトの ID (list-zonal-shifts の zonalShiftId)' };

const shiftOut = (s: ZonalShift) => ({ zonalShiftId: s.zonalShiftId, resourceIdentifier: s.resourceIdentifier, awayFrom: s.awayFrom, expiryTime: iso(s.expiryTime), startTime: iso(s.startTime), status: s.status, comment: s.comment });
const summaryOut = (s: ZonalShift) => ({ ...shiftOut(s), shiftType: s.shiftType, ...(s.practiceRunOutcome ? { practiceRunOutcome: s.practiceRunOutcome } : {}) });
const practiceOut = (p?: PracticeRunConfiguration) =>
  p && {
    ...(p.blockingAlarms.length ? { blockingAlarms: p.blockingAlarms } : {}),
    outcomeAlarms: p.outcomeAlarms,
    ...(p.blockedWindows.length ? { blockedWindows: p.blockedWindows } : {}),
    ...(p.allowedWindows.length ? { allowedWindows: p.allowedWindows } : {}),
    ...(p.blockedDates.length ? { blockedDates: p.blockedDates } : {}),
  };

/** zonalShifts / autoshifts of a managed resource (ACTIVE ones, with appliedStatus) */
function inResource(env: AwsEnv, r: ManagedResource, now: number) {
  const shifts = shiftsOf(env, r, now);
  const customerApplied = shifts.some((s) => s.shiftType === 'ZONAL_SHIFT');
  return {
    zonalShifts: shifts.map((s) => ({ appliedStatus: s.appliedStatus, zonalShiftId: s.zonalShiftId, resourceIdentifier: s.resourceIdentifier, awayFrom: s.awayFrom, expiryTime: iso(s.expiryTime), startTime: iso(s.startTime), comment: s.comment, shiftType: s.shiftType, ...(s.practiceRunOutcome ? { practiceRunOutcome: s.practiceRunOutcome } : {}) })),
    autoshifts: autoshiftsAt(env, r.lb, now).map((a, n) => ({ appliedStatus: !customerApplied && n === 0 ? 'APPLIED' : 'NOT_APPLIED', awayFrom: a.awayFrom, startTime: iso(a.startTime) })),
  };
}

const conds = (ctx: OpContext, name: string): ControlCondition[] | undefined =>
  ctx.p[name] === undefined ? undefined : structs(ctx, name).map((c) => ({ type: String(c.type ?? '') as 'CLOUDWATCH', alarmIdentifier: String(c.alarmIdentifier ?? '') }));
const lists = (ctx: OpContext, name: string) => (ctx.p[name] === undefined ? undefined : strs(ctx, name));
const practiceIn = (ctx: OpContext): Partial<PracticeRunConfiguration> =>
  Object.fromEntries(
    Object.entries({ outcomeAlarms: conds(ctx, 'outcome-alarms'), blockingAlarms: conds(ctx, 'blocking-alarms'), blockedWindows: lists(ctx, 'blocked-windows'), allowedWindows: lists(ctx, 'allowed-windows'), blockedDates: lists(ctx, 'blocked-dates') }).filter(([, v]) => v !== undefined),
  );
const practiceParams = [
  { name: 'blocking-alarms', type: 'list' as const, of: 'structure' as const, desc: 'ブロッキングアラーム: type=CLOUDWATCH,alarmIdentifier=<アラームの ARN>。ALARM の間は練習実行を始めない' },
  { name: 'blocked-windows', type: 'list' as const, desc: '練習実行をしない曜日と時間帯 (UTC): Mon:00:00-Mon:10:00' },
  { name: 'allowed-windows', type: 'list' as const, desc: '練習実行をしてよい曜日と時間帯 (UTC): Wed:12:00-Wed:17:00' },
  { name: 'blocked-dates', type: 'list' as const, desc: '練習実行をしない日 (UTC): 2026-12-24' },
];

const ops: OperationSpec[] = [
  {
    name: 'list-managed-resources',
    desc: 'ゾーンシフトできるリソース (マネージドリソース) の一覧。ALB はゾーンシフトの属性を有効にすると載る',
    params: [{ name: 'max-items', type: 'integer', desc: '最大件数' }],
    readOnly: true,
    examples: ["aws arc-zonal-shift list-managed-resources --query 'items[].[name,arn]' --output table"],
    run(ctx) {
      return {
        items: managedResources(ctx.env).map((r) => {
          const c = configOf(ctx.env, r.arn);
          return { arn: r.arn, name: r.name, availabilityZones: r.availabilityZones, appliedWeights: appliedWeights(ctx.env, r, ctx.now), ...inResource(ctx.env, r, ctx.now), zonalAutoshiftStatus: c?.zonalAutoshiftStatus ?? 'DISABLED', practiceRunStatus: c?.practiceRunConfiguration ? 'ENABLED' : 'DISABLED' };
        }),
      };
    },
  },
  {
    name: 'get-managed-resource',
    desc: 'マネージドリソース 1 つの詳細 (AZ ごとの重み appliedWeights、ゾーンシフト、練習実行設定)',
    params: [RESOURCE],
    readOnly: true,
    examples: ["aws arc-zonal-shift get-managed-resource --resource-identifier arn:aws:elasticloadbalancing:... --query appliedWeights"],
    run(ctx) {
      const r = getManagedResource(ctx.env, req(ctx, 'resource-identifier'));
      const c = configOf(ctx.env, r.arn);
      return { arn: r.arn, name: r.name, appliedWeights: appliedWeights(ctx.env, r, ctx.now), ...inResource(ctx.env, r, ctx.now), ...(c?.practiceRunConfiguration ? { practiceRunConfiguration: practiceOut(c.practiceRunConfiguration) } : {}), zonalAutoshiftStatus: c?.zonalAutoshiftStatus ?? 'DISABLED' };
    },
  },
  {
    name: 'start-zonal-shift',
    desc: 'ゾーンシフトを開始する (その AZ のリソースに新しいトラフィックを送らない。期限付き)',
    params: [
      RESOURCE,
      { name: 'away-from', type: 'string', required: true, desc: 'トラフィックを移す元の AZ の ID (apne1-az1 など。AZ 名ではない)' },
      { name: 'expires-in', type: 'string', required: true, desc: '有効期間: 30m / 1h など (1 分〜72 時間)' },
      { name: 'comment', type: 'string', required: true, desc: 'コメント (128 文字まで)' },
    ],
    examples: ['aws arc-zonal-shift start-zonal-shift --resource-identifier arn:aws:elasticloadbalancing:... --away-from apne1-az2 --expires-in 1h --comment "AZ 1c gray failure"'],
    run: (ctx) => shiftOut(startZonalShift(ctx.env, { resourceIdentifier: req(ctx, 'resource-identifier'), awayFrom: str(ctx, 'away-from') ?? '', expiresIn: str(ctx, 'expires-in') ?? '', comment: str(ctx, 'comment') ?? '' }, ctx.now)),
  },
  {
    name: 'update-zonal-shift',
    desc: 'ACTIVE なゾーンシフトの有効期限 (今からの長さ) かコメントを変える',
    params: [SHIFT_ID, { name: 'expires-in', type: 'string', desc: '今から何分 / 何時間で終えるか: 30m / 2h' }, { name: 'comment', type: 'string', desc: '新しいコメント (前のコメントは残らない)' }],
    examples: ['aws arc-zonal-shift update-zonal-shift --zonal-shift-id 12345678-... --expires-in 2h'],
    run: (ctx) => shiftOut(updateZonalShift(ctx.env, req(ctx, 'zonal-shift-id'), { expiresIn: str(ctx, 'expires-in'), comment: str(ctx, 'comment') }, ctx.now)),
  },
  {
    name: 'cancel-zonal-shift',
    desc: 'ゾーンシフトを終える (トラフィックがその AZ に戻る)',
    params: [SHIFT_ID],
    examples: ['aws arc-zonal-shift cancel-zonal-shift --zonal-shift-id 12345678-...'],
    run: (ctx) => shiftOut(cancelZonalShift(ctx.env, req(ctx, 'zonal-shift-id'), ctx.now)),
  },
  {
    name: 'list-zonal-shifts',
    desc: 'ゾーンシフトの一覧 (終わったものも。練習実行を含む)',
    params: [
      { name: 'status', type: 'string', desc: 'ACTIVE / EXPIRED / CANCELED で絞る' },
      { name: 'resource-identifier', type: 'string', desc: 'リソースの ARN で絞る' },
      { name: 'max-items', type: 'integer', desc: '最大件数' },
    ],
    readOnly: true,
    examples: ["aws arc-zonal-shift list-zonal-shifts --status ACTIVE --query 'items[].[zonalShiftId,awayFrom,expiryTime]' --output table"],
    run(ctx) {
      const status = str(ctx, 'status');
      if (status && !['ACTIVE', 'EXPIRED', 'CANCELED'].includes(status)) throw new AwsError('ValidationException', `1 validation error detected: Value '${status}' at 'status' failed to satisfy constraint: Member must satisfy enum value set: [ACTIVE, EXPIRED, CANCELED]`);
      const arn = str(ctx, 'resource-identifier');
      return { items: [...(ctx.env.zonalShift?.shifts ?? [])].reverse().filter((s) => (!status || s.status === status) && (!arn || s.resourceIdentifier === arn)).map(summaryOut) };
    },
  },
  {
    name: 'list-autoshifts',
    desc: 'AWS が始めたオートシフトの一覧 (ゾーンオートシフトを有効にしたリソースのアカウント)',
    params: [{ name: 'status', type: 'string', desc: 'ACTIVE / COMPLETED で絞る' }],
    readOnly: true,
    run(ctx) {
      const status = str(ctx, 'status');
      const enabled = (ctx.env.zonalShift?.configs ?? []).filter((c) => c.zonalAutoshiftStatus === 'ENABLED' && c.enabledAt !== undefined);
      const items = (ctx.env.zonalShift?.impairments ?? []).flatMap((i) => {
        const on = enabled.filter((c) => lbAzs(ctx.env, getLb(ctx.env, c.resourceArn)).includes(i.availabilityZone));
        if (!on.length) return [];
        const start = Math.max(Math.min(...on.map((c) => c.enabledAt!)), i.startedAt + AUTOSHIFT_DETECT_MS);
        if (start > ctx.now || (i.endsAt !== undefined && start >= i.endsAt)) return [];
        const done = i.endsAt !== undefined && i.endsAt <= ctx.now;
        return [{ awayFrom: azIdOf(i.availabilityZone), startTime: iso(start), ...(done ? { endTime: iso(i.endsAt) } : {}), status: done ? 'COMPLETED' : 'ACTIVE' }];
      });
      return { items: items.filter((x) => !status || x.status === status) };
    },
  },
  {
    name: 'update-zonal-autoshift-configuration',
    desc: 'ゾーンオートシフトを有効 / 無効にする (有効にするには練習実行設定が要る)',
    params: [RESOURCE, { name: 'zonal-autoshift-status', type: 'string', required: true, desc: 'ENABLED / DISABLED' }],
    examples: ['aws arc-zonal-shift update-zonal-autoshift-configuration --resource-identifier arn:aws:elasticloadbalancing:... --zonal-autoshift-status ENABLED'],
    run: (ctx) => updateZonalAutoshiftConfiguration(ctx.env, req(ctx, 'resource-identifier'), req(ctx, 'zonal-autoshift-status'), ctx.now),
  },
  {
    name: 'create-practice-run-configuration',
    desc: '練習実行設定を作る (結果アラームは必須。週 1 回 30 分、AWS が 1 つの AZ からトラフィックを移して確かめる)',
    params: [RESOURCE, { name: 'outcome-alarms', type: 'list', of: 'structure', required: true, desc: '結果アラーム: type=CLOUDWATCH,alarmIdentifier=<アラームの ARN>。練習中に ALARM になると失敗 (FAILED) として終える' }, ...practiceParams],
    examples: ['aws arc-zonal-shift create-practice-run-configuration --resource-identifier arn:aws:elasticloadbalancing:... --outcome-alarms type=CLOUDWATCH,alarmIdentifier=arn:aws:cloudwatch:ap-northeast-1:123456789012:alarm:web-alb-5xx'],
    run(ctx) {
      const r = createPracticeRunConfiguration(ctx.env, req(ctx, 'resource-identifier'), { ...practiceIn(ctx), outcomeAlarms: conds(ctx, 'outcome-alarms') ?? [] });
      return { arn: r.arn, name: r.name, zonalAutoshiftStatus: r.zonalAutoshiftStatus, practiceRunConfiguration: practiceOut(r.practiceRunConfiguration) };
    },
  },
  {
    name: 'update-practice-run-configuration',
    desc: '練習実行設定を変える (指定したものだけ置き換える)',
    params: [RESOURCE, { name: 'outcome-alarms', type: 'list', of: 'structure', desc: '結果アラーム: type=CLOUDWATCH,alarmIdentifier=<アラームの ARN>' }, ...practiceParams],
    run(ctx) {
      const r = updatePracticeRunConfiguration(ctx.env, req(ctx, 'resource-identifier'), practiceIn(ctx));
      return { arn: r.arn, name: r.name, zonalAutoshiftStatus: r.zonalAutoshiftStatus, practiceRunConfiguration: practiceOut(r.practiceRunConfiguration) };
    },
  },
  {
    name: 'delete-practice-run-configuration',
    desc: '練習実行設定を消す (先にゾーンオートシフトを無効にする)',
    params: [RESOURCE],
    run: (ctx) => deletePracticeRunConfiguration(ctx.env, req(ctx, 'resource-identifier')),
  },
  {
    name: 'start-practice-run',
    desc: '練習実行 (30 分のゾーンシフト) をすぐに始める。ゾーンオートシフトが有効なときだけ',
    params: [RESOURCE, { name: 'away-from', type: 'string', required: true, desc: 'トラフィックを移す元の AZ の ID' }, { name: 'comment', type: 'string', required: true, desc: 'コメント' }],
    run: (ctx) => shiftOut(startPracticeRun(ctx.env, { resourceIdentifier: req(ctx, 'resource-identifier'), awayFrom: str(ctx, 'away-from') ?? '', comment: str(ctx, 'comment') ?? '' }, ctx.now)),
  },
  {
    name: 'cancel-practice-run',
    desc: '実行中の練習実行を止める (結果は INTERRUPTED)',
    params: [SHIFT_ID],
    run: (ctx) => shiftOut(cancelZonalShift(ctx.env, req(ctx, 'zonal-shift-id'), ctx.now, 'CancelPracticeRun')),
  },
];

export default service('arc-zonal-shift', 'Route 53 Application Recovery Controller (ゾーンシフト・ゾーンオートシフト)', ops);
