// Route 53 ARC zonal shift (lesson 47): AZ impairment ("gray failure"), managed resources, zonal shifts, zonal autoshift
// and practice runs. The state lives in AwsEnv as an optional field (sessions saved by older versions don't have it).
// What the traffic sees (http.ts: the ALB request path, cloudwatch.ts: metrics) comes from shiftedAwayAz / impairedAt.
import { trail, type EventSource } from '../cloudtrail';
import { evaluateAlarm } from '../cloudwatch';
import { getLb, regionOf } from '../env';
import { newUuid } from '../ids';
import { AwsError, type AwsEnv, type LoadBalancer } from '../types';

/** An AZ where requests to targets are slow / time out while the light health checks still pass (a gray failure). */
export interface AzImpairment {
  /** AZ name, e.g. ap-northeast-1c */
  availabilityZone: string;
  startedAt: number;
  /** AWS fixed it (set when traffic is first shifted away from the AZ: the lesson's "an hour later") */
  endsAt?: number;
}

export type ZonalShiftStatus = 'ACTIVE' | 'EXPIRED' | 'CANCELED';
export type PracticeRunOutcome = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';

export interface ZonalShift {
  zonalShiftId: string;
  resourceIdentifier: string;
  /** AZ ID, e.g. apne1-az2 */
  awayFrom: string;
  startTime: number;
  expiryTime: number;
  comment: string;
  status: ZonalShiftStatus;
  shiftType: 'ZONAL_SHIFT' | 'PRACTICE_RUN';
  practiceRunOutcome?: PracticeRunOutcome;
  /** when it stopped moving traffic (canceled / ended early); undefined = at expiryTime */
  endedAt?: number;
}

export interface ControlCondition {
  type: 'CLOUDWATCH';
  /** CloudWatch alarm ARN */
  alarmIdentifier: string;
}

export interface PracticeRunConfiguration {
  outcomeAlarms: ControlCondition[];
  blockingAlarms: ControlCondition[];
  /** UTC, "Mon:09:00-Mon:10:00" */
  blockedWindows: string[];
  allowedWindows: string[];
  /** UTC, "2026-12-24" */
  blockedDates: string[];
}

export interface AutoshiftConfig {
  resourceArn: string;
  zonalAutoshiftStatus: 'ENABLED' | 'DISABLED';
  enabledAt?: number;
  practiceRunConfiguration?: PracticeRunConfiguration;
}

export interface ZonalShiftState {
  impairments: AzImpairment[];
  shifts: ZonalShift[];
  configs: AutoshiftConfig[];
}

const MINUTE = 60_000;
/** customer zonal shifts: 1 minute .. 3 days */
export const MAX_EXPIRES_MIN = 72 * 60;
export const PRACTICE_RUN_MS = 30 * MINUTE;
/** AWS's own monitoring notices an impairment this long after it starts (what an autoshift reacts to) */
export const AUTOSHIFT_DETECT_MS = 5 * MINUTE;
/** ponytail: the impairment heals this long after traffic is first shifted away (the lesson skips "an hour later"); a scripted end time if a lesson needs one */
export const RECOVERY_AFTER_SHIFT_MS = 5000;

const SOURCE: EventSource = 'arc-zonal-shift';
const state = (env: AwsEnv): ZonalShiftState => (env.zonalShift ??= { impairments: [], shifts: [], configs: [] });

// ---------------- AZ IDs ----------------

/** ap-northeast-1 → apne1 */
function regionShort(region: string): string {
  const [geo, dir, n] = region.split('-');
  return geo + dir.replace('north', 'n').replace('south', 's').replace('east', 'e').replace('west', 'w').replace('central', 'c') + n;
}

/** AZ name → AZ ID (ap-northeast-1c → apne1-az2). Same mapping as the CLI's describe-availability-zones (cli/aws/shapes.ts zoneId). */
export function azIdOf(az: string): string {
  const region = az.slice(0, -1);
  return `${regionShort(region)}-az${regionOf(region).azs.indexOf(az) + 1}`;
}

/** AZ ID → AZ name in the env's region */
export function azNameOf(env: AwsEnv, id: string): string | undefined {
  return regionOf(env.region).azs.find((az) => azIdOf(az) === id);
}

export const lbAzs = (env: AwsEnv, lb: LoadBalancer): string[] => lb.subnetIds.map((s) => env.subnets.find((x) => x.subnetId === s)?.availabilityZone ?? '').filter(Boolean);

// ---------------- load balancer attributes ----------------

export const ZONAL_SHIFT_ATTRIBUTE = 'zonal_shift.config.enabled';

/** ALB attributes and their defaults (DescribeLoadBalancerAttributes). Only zonal shift changes what the simulator does. */
export const ALB_ATTRIBUTES: Record<string, string> = {
  'access_logs.s3.enabled': 'false',
  'access_logs.s3.bucket': '',
  'access_logs.s3.prefix': '',
  'client_keep_alive.seconds': '3600',
  'connection_logs.s3.enabled': 'false',
  'connection_logs.s3.bucket': '',
  'connection_logs.s3.prefix': '',
  'deletion_protection.enabled': 'false',
  'health_check_logs.s3.enabled': 'false',
  'health_check_logs.s3.bucket': '',
  'health_check_logs.s3.prefix': '',
  'idle_timeout.timeout_seconds': '60',
  'ipv6.deny_all_igw_traffic': 'false',
  'load_balancing.cross_zone.enabled': 'true',
  'routing.http.desync_mitigation_mode': 'defensive',
  'routing.http.drop_invalid_header_fields.enabled': 'false',
  'routing.http.preserve_host_header.enabled': 'false',
  'routing.http.x_amzn_tls_version_and_cipher_suite.enabled': 'false',
  'routing.http.xff_client_port.enabled': 'false',
  'routing.http.xff_header_processing.mode': 'append',
  'routing.http2.enabled': 'true',
  'waf.fail_open.enabled': 'false',
  [ZONAL_SHIFT_ATTRIBUTE]: 'false',
};

const ENUMS: Record<string, string[]> = { 'routing.http.desync_mitigation_mode': ['monitor', 'defensive', 'strictest'], 'routing.http.xff_header_processing.mode': ['append', 'preserve', 'remove'] };
const RANGES: Record<string, [number, number]> = { 'idle_timeout.timeout_seconds': [1, 4000], 'client_keep_alive.seconds': [60, 604800] };

export const lbAttributes = (lb: LoadBalancer): Record<string, string> => ({ ...ALB_ATTRIBUTES, ...lb.attributes });
export const zonalShiftEnabled = (lb: LoadBalancer) => lb.attributes?.[ZONAL_SHIFT_ATTRIBUTE] === 'true';

/** ModifyLoadBalancerAttributes: returns every attribute after the change */
export function modifyLoadBalancerAttributes(env: AwsEnv, arn: string, changes: { key: string; value: string }[]): Record<string, string> {
  const lb = getLb(env, arn);
  if (!changes.length) throw new AwsError('ValidationError', 'Attributes must contain at least one attribute');
  const next = lbAttributes(lb);
  for (const { key, value } of changes) {
    if (!(key in ALB_ATTRIBUTES)) throw new AwsError('ValidationError', `Load balancer attribute key '${key}' is not recognized`);
    if (key === 'load_balancing.cross_zone.enabled' && value !== 'true') throw new AwsError('InvalidConfigurationRequest', `Load balancer attribute key '${key}' is not supported on load balancers with type 'application'`);
    const bool = ALB_ATTRIBUTES[key] === 'true' || ALB_ATTRIBUTES[key] === 'false';
    const range = RANGES[key];
    const ok = bool ? value === 'true' || value === 'false' : range ? /^\d+$/.test(value) && Number(value) >= range[0] && Number(value) <= range[1] : ENUMS[key] ? ENUMS[key].includes(value) : true;
    if (!ok) throw new AwsError('ValidationError', `Load balancer attribute value '${value}' is not valid for key '${key}'`);
    next[key] = value;
  }
  for (const kind of ['access_logs', 'connection_logs', 'health_check_logs'])
    if (next[`${kind}.s3.enabled`] === 'true' && !next[`${kind}.s3.bucket`]) throw new AwsError('ValidationError', `The value of '${kind}.s3.bucket' cannot be empty when '${kind}.s3.enabled' is 'true'`);
  lb.attributes = Object.fromEntries(Object.entries(next).filter(([k, v]) => ALB_ATTRIBUTES[k] !== v));
  if (!Object.keys(lb.attributes).length) delete lb.attributes;
  const out = changes.map(({ key }) => ({ key, value: next[key] }));
  trail(env, { source: 'elasticloadbalancing', name: 'ModifyLoadBalancerAttributes', resources: [['AWS::ElasticLoadBalancingV2::LoadBalancer', arn]], request: { loadBalancerArn: arn, attributes: changes }, response: { attributes: out } });
  return next;
}

// ---------------- managed resources and what traffic sees ----------------

export interface ManagedResource {
  arn: string;
  name: string;
  lb: LoadBalancer;
  /** AZ IDs */
  availabilityZones: string[];
}

/** Resources registered with ARC: load balancers with the zonal shift attribute on. */
export function managedResources(env: AwsEnv): ManagedResource[] {
  return env.loadBalancers.filter(zonalShiftEnabled).map((lb) => ({ arn: lb.loadBalancerArn, name: lb.loadBalancerName, lb, availabilityZones: lbAzs(env, lb).map(azIdOf) }));
}

export function getManagedResource(env: AwsEnv, id: string): ManagedResource {
  if (!/^arn:/.test(id)) throw new AwsError('ValidationException', `Invalid resource identifier: ${id}. Specify the Amazon Resource Name (ARN) of the resource.`);
  const r = managedResources(env).find((x) => x.arn === id);
  if (!r) throw new AwsError('ResourceNotFoundException', `Resource not found: ${id}`);
  return r;
}

export const shiftActiveAt = (s: ZonalShift, t: number) => s.startTime <= t && t < (s.endedAt ?? s.expiryTime);
export const configOf = (env: AwsEnv, arn: string) => env.zonalShift?.configs.find((c) => c.resourceArn === arn);

export function impairedAt(env: AwsEnv, az: string, t: number): boolean {
  return !!env.zonalShift?.impairments.some((i) => i.availabilityZone === az && i.startedAt <= t && t < (i.endsAt ?? Infinity));
}

/** autoshifts AWS runs for the resource at t: zonal autoshift is on and AWS has noticed an impaired AZ of the resource */
export function autoshiftsAt(env: AwsEnv, lb: LoadBalancer, t: number): { awayFrom: string; startTime: number }[] {
  const c = configOf(env, lb.loadBalancerArn);
  if (c?.zonalAutoshiftStatus !== 'ENABLED' || c.enabledAt === undefined) return [];
  const azs = lbAzs(env, lb);
  return (env.zonalShift?.impairments ?? [])
    .filter((i) => azs.includes(i.availabilityZone))
    .map((i) => ({ i, startTime: Math.max(c.enabledAt!, i.startedAt + AUTOSHIFT_DETECT_MS) }))
    .filter(({ i, startTime }) => startTime <= t && t < (i.endsAt ?? Infinity))
    .map(({ i, startTime }) => ({ awayFrom: azIdOf(i.availabilityZone), startTime }));
}

export interface AppliedShift {
  awayFrom: string;
  shiftType: 'ZONAL_SHIFT' | 'ZONAL_AUTOSHIFT' | 'PRACTICE_RUN';
  zonalShiftId?: string;
}

/** The shift in effect for the load balancer at t: customer zonal shifts > autoshifts > practice runs */
export function appliedShift(env: AwsEnv, lb: LoadBalancer, t: number): AppliedShift | undefined {
  if (!env.zonalShift || !zonalShiftEnabled(lb)) return undefined;
  const active = env.zonalShift.shifts.filter((s) => s.resourceIdentifier === lb.loadBalancerArn && shiftActiveAt(s, t));
  const customer = active.find((s) => s.shiftType === 'ZONAL_SHIFT');
  if (customer) return { awayFrom: customer.awayFrom, shiftType: 'ZONAL_SHIFT', zonalShiftId: customer.zonalShiftId };
  const auto = autoshiftsAt(env, lb, t)[0];
  if (auto) return { awayFrom: auto.awayFrom, shiftType: 'ZONAL_AUTOSHIFT' };
  const practice = active.find((s) => s.shiftType === 'PRACTICE_RUN');
  return practice && { awayFrom: practice.awayFrom, shiftType: 'PRACTICE_RUN', zonalShiftId: practice.zonalShiftId };
}

/** AZ name the load balancer sends no new requests to at t (with cross-zone on, ALB nodes in every AZ skip its targets) */
export function shiftedAwayAz(env: AwsEnv, lb: LoadBalancer, t: number): string | undefined {
  const a = appliedShift(env, lb, t);
  return a && azNameOf(env, a.awayFrom);
}

/** appliedWeights of GetManagedResource: 0 for the AZ traffic is shifted away from */
export function appliedWeights(env: AwsEnv, r: ManagedResource, t: number): Record<string, number> {
  const away = appliedShift(env, r.lb, t)?.awayFrom;
  return Object.fromEntries(r.availabilityZones.map((id) => [id, id === away ? 0 : 1]));
}

/** zonal shifts of the resource as the API lists them, with appliedStatus */
export function shiftsOf(env: AwsEnv, r: ManagedResource, t: number) {
  const applied = appliedShift(env, r.lb, t);
  return (env.zonalShift?.shifts ?? []).filter((s) => s.resourceIdentifier === r.arn && s.status === 'ACTIVE').map((s) => ({ ...s, appliedStatus: applied?.zonalShiftId === s.zonalShiftId ? ('APPLIED' as const) : ('NOT_APPLIED' as const) }));
}

// ---------------- zonal shifts ----------------

/** "1h" / "90m" → minutes. Pattern ([1-9][0-9]*)(m|h), 1 minute .. 72 hours */
export function parseExpiresIn(v: string): number {
  const m = /^([1-9][0-9]*)(m|h)$/.exec(v);
  if (!m) throw new AwsError('ValidationException', `Invalid expiresIn value: ${v}. Specify a whole number followed by m (minutes) or h (hours), for example 30m or 2h.`);
  const min = Number(m[1]) * (m[2] === 'h' ? 60 : 1);
  if (min > MAX_EXPIRES_MIN) throw new AwsError('ValidationException', `Invalid expiresIn value: ${v}. A zonal shift can be active for up to 3 days (72 hours).`);
  return min;
}

function checkAz(r: ManagedResource, awayFrom: string) {
  if (!/^[a-z]+[0-9]+-az[0-9]+$/.test(awayFrom)) throw new AwsError('ValidationException', `${awayFrom} is not a valid Availability Zone ID. Specify an AZ ID, for example use1-az1.`);
  if (!r.availabilityZones.includes(awayFrom)) throw new AwsError('ValidationException', `The resource is not deployed in the Availability Zone ${awayFrom}.`);
}

function checkComment(comment: string) {
  if (comment.length > 128) throw new AwsError('ValidationException', '1 validation error detected: Value at \'comment\' failed to satisfy constraint: Member must have length less than or equal to 128');
}

/** the AZ heals a little after traffic is first moved away from it (see RECOVERY_AFTER_SHIFT_MS) */
function startRecoveryClock(env: AwsEnv, azId: string, now: number) {
  for (const i of env.zonalShift?.impairments ?? []) if (azIdOf(i.availabilityZone) === azId && i.endsAt === undefined && i.startedAt <= now) i.endsAt = now + RECOVERY_AFTER_SHIFT_MS;
}

const shiftOut = (s: ZonalShift) => ({ zonalShiftId: s.zonalShiftId, resourceIdentifier: s.resourceIdentifier, awayFrom: s.awayFrom, expiryTime: s.expiryTime, startTime: s.startTime, status: s.status, comment: s.comment });

export function startZonalShift(env: AwsEnv, input: { resourceIdentifier: string; awayFrom: string; expiresIn: string; comment: string }, now = Date.now()): ZonalShift {
  const r = getManagedResource(env, input.resourceIdentifier);
  checkAz(r, input.awayFrom);
  const minutes = parseExpiresIn(input.expiresIn);
  checkComment(input.comment);
  const st = state(env);
  const existing = st.shifts.find((s) => s.resourceIdentifier === r.arn && s.status === 'ACTIVE' && s.shiftType === 'ZONAL_SHIFT');
  if (existing) throw new AwsError('ConflictException', `A zonal shift is already active for resource ${r.arn} (zonal shift ${existing.zonalShiftId}). Update or cancel it instead.`);
  const s: ZonalShift = { zonalShiftId: newUuid(), resourceIdentifier: r.arn, awayFrom: input.awayFrom, startTime: now, expiryTime: now + minutes * MINUTE, comment: input.comment, status: 'ACTIVE', shiftType: 'ZONAL_SHIFT' };
  st.shifts.push(s);
  startRecoveryClock(env, s.awayFrom, now);
  trail(env, { source: SOURCE, name: 'StartZonalShift', resources: [['AWS::ARCZonalShift::ZonalShift', s.zonalShiftId]], request: { resourceIdentifier: r.arn, awayFrom: s.awayFrom, expiresIn: input.expiresIn, comment: s.comment }, response: shiftOut(s) });
  return s;
}

function getShift(env: AwsEnv, id: string): ZonalShift {
  const s = env.zonalShift?.shifts.find((x) => x.zonalShiftId === id);
  if (!s) throw new AwsError('ResourceNotFoundException', `Zonal shift ${id} not found.`);
  if (s.status !== 'ACTIVE') throw new AwsError('ConflictException', `Zonal shift ${id} is not active (status: ${s.status}).`);
  return s;
}

export function updateZonalShift(env: AwsEnv, id: string, input: { expiresIn?: string; comment?: string }, now = Date.now()): ZonalShift {
  const s = getShift(env, id);
  if (s.shiftType === 'PRACTICE_RUN') throw new AwsError('ValidationException', 'Practice run zonal shifts cannot be updated.');
  if (input.expiresIn === undefined && input.comment === undefined) throw new AwsError('ValidationException', 'Specify a new expiresIn or comment for the zonal shift.');
  const minutes = input.expiresIn === undefined ? undefined : parseExpiresIn(input.expiresIn);
  if (input.comment !== undefined) checkComment(input.comment);
  if (minutes !== undefined) s.expiryTime = now + minutes * MINUTE;
  if (input.comment !== undefined) s.comment = input.comment;
  trail(env, { source: SOURCE, name: 'UpdateZonalShift', resources: [['AWS::ARCZonalShift::ZonalShift', id]], request: { zonalShiftId: id, ...input }, response: shiftOut(s) });
  return s;
}

/** CancelZonalShift (and CancelPracticeRun): traffic goes back to the AZ */
export function cancelZonalShift(env: AwsEnv, id: string, now = Date.now(), api: 'CancelZonalShift' | 'CancelPracticeRun' = 'CancelZonalShift'): ZonalShift {
  const s = getShift(env, id);
  if (api === 'CancelPracticeRun' && s.shiftType !== 'PRACTICE_RUN') throw new AwsError('ValidationException', `Zonal shift ${id} is not a practice run. Use CancelZonalShift.`);
  s.status = 'CANCELED';
  s.endedAt = now;
  if (s.shiftType === 'PRACTICE_RUN') s.practiceRunOutcome = 'INTERRUPTED';
  trail(env, { source: SOURCE, name: api, resources: [['AWS::ARCZonalShift::ZonalShift', id]], request: { zonalShiftId: id }, response: shiftOut(s) });
  return s;
}

// ---------------- zonal autoshift and practice runs ----------------

const DAY = '(Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const WINDOW = new RegExp(`^${DAY}:([01][0-9]|2[0-3]):[0-5][0-9]-${DAY}:([01][0-9]|2[0-3]):[0-5][0-9]$`);

function conditions(env: AwsEnv, list: ControlCondition[], what: string, min: number): ControlCondition[] {
  if (list.length < min) throw new AwsError('ValidationException', `At least ${min} ${what} must be specified.`);
  if (list.length > 10) throw new AwsError('ValidationException', `You can specify up to 10 ${what}.`);
  for (const c of list) {
    if (c.type !== 'CLOUDWATCH') throw new AwsError('ValidationException', `Invalid control condition type: ${c.type}. The only supported type is CLOUDWATCH.`);
    if (!env.alarms.some((a) => a.alarmArn === c.alarmIdentifier)) throw new AwsError('ValidationException', `Invalid alarm condition: the CloudWatch alarm ${c.alarmIdentifier} does not exist.`);
  }
  return list.map((c) => ({ type: 'CLOUDWATCH', alarmIdentifier: c.alarmIdentifier }));
}

function blockers(p: Partial<PracticeRunConfiguration>) {
  for (const [k, list] of [['blockedWindows', p.blockedWindows], ['allowedWindows', p.allowedWindows]] as const)
    for (const w of list ?? []) {
      const m = WINDOW.exec(w);
      if (!m || m[1] !== m[3]) throw new AwsError('ValidationException', `Invalid ${k} value: ${w}. Use DAY:HH:MM-DAY:HH:MM in UTC, starting and ending on the same day (for example Mon:09:00-Mon:10:00).`);
    }
  for (const d of p.blockedDates ?? []) if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new AwsError('ValidationException', `Invalid blockedDates value: ${d}. Use YYYY-MM-DD in UTC.`);
}

function practiceOut(env: AwsEnv, r: ManagedResource) {
  const c = configOf(env, r.arn);
  return { arn: r.arn, name: r.name, zonalAutoshiftStatus: c?.zonalAutoshiftStatus ?? 'DISABLED', practiceRunConfiguration: c?.practiceRunConfiguration };
}

export function createPracticeRunConfiguration(env: AwsEnv, arn: string, input: Partial<PracticeRunConfiguration> & { outcomeAlarms: ControlCondition[] }) {
  const r = getManagedResource(env, arn);
  const prev = configOf(env, r.arn);
  if (prev?.practiceRunConfiguration) throw new AwsError('ConflictException', `A practice run configuration already exists for resource ${r.arn}. Update it instead.`);
  blockers(input);
  const cfg: PracticeRunConfiguration = { outcomeAlarms: conditions(env, input.outcomeAlarms, 'outcome alarm', 1), blockingAlarms: conditions(env, input.blockingAlarms ?? [], 'blocking alarm', 0), blockedWindows: input.blockedWindows ?? [], allowedWindows: input.allowedWindows ?? [], blockedDates: input.blockedDates ?? [] };
  if (prev) prev.practiceRunConfiguration = cfg;
  else state(env).configs.push({ resourceArn: r.arn, zonalAutoshiftStatus: 'DISABLED', practiceRunConfiguration: cfg });
  const out = practiceOut(env, r);
  trail(env, { source: SOURCE, name: 'CreatePracticeRunConfiguration', resources: [['AWS::ARCZonalShift::ZonalAutoshiftConfiguration', r.arn]], request: { resourceIdentifier: r.arn, ...input }, response: out });
  return out;
}

export function updatePracticeRunConfiguration(env: AwsEnv, arn: string, input: Partial<PracticeRunConfiguration>) {
  const r = getManagedResource(env, arn);
  const c = configOf(env, r.arn);
  if (!c?.practiceRunConfiguration) throw new AwsError('ConflictException', `There is no practice run configuration for resource ${r.arn}. Create one first.`);
  blockers(input);
  const p = c.practiceRunConfiguration;
  c.practiceRunConfiguration = {
    outcomeAlarms: input.outcomeAlarms ? conditions(env, input.outcomeAlarms, 'outcome alarm', 1) : p.outcomeAlarms,
    blockingAlarms: input.blockingAlarms ? conditions(env, input.blockingAlarms, 'blocking alarm', 0) : p.blockingAlarms,
    blockedWindows: input.blockedWindows ?? p.blockedWindows,
    allowedWindows: input.allowedWindows ?? p.allowedWindows,
    blockedDates: input.blockedDates ?? p.blockedDates,
  };
  const out = practiceOut(env, r);
  trail(env, { source: SOURCE, name: 'UpdatePracticeRunConfiguration', resources: [['AWS::ARCZonalShift::ZonalAutoshiftConfiguration', r.arn]], request: { resourceIdentifier: r.arn, ...input }, response: out });
  return out;
}

/** the API refuses while autoshift is on (the console turns autoshift off first) */
export function deletePracticeRunConfiguration(env: AwsEnv, arn: string) {
  const r = getManagedResource(env, arn);
  const c = configOf(env, r.arn);
  if (!c?.practiceRunConfiguration) throw new AwsError('ResourceNotFoundException', `There is no practice run configuration for resource ${r.arn}.`);
  if (c.zonalAutoshiftStatus === 'ENABLED') throw new AwsError('ConflictException', `Zonal autoshift is enabled for resource ${r.arn}. Disable zonal autoshift before you delete the practice run configuration.`);
  delete c.practiceRunConfiguration;
  trail(env, { source: SOURCE, name: 'DeletePracticeRunConfiguration', resources: [['AWS::ARCZonalShift::ZonalAutoshiftConfiguration', r.arn]], request: { resourceIdentifier: r.arn }, response: { arn: r.arn, name: r.name, zonalAutoshiftStatus: c.zonalAutoshiftStatus } });
  return { arn: r.arn, name: r.name, zonalAutoshiftStatus: c.zonalAutoshiftStatus };
}

export function updateZonalAutoshiftConfiguration(env: AwsEnv, arn: string, status: string, now = Date.now()) {
  const r = getManagedResource(env, arn);
  if (status !== 'ENABLED' && status !== 'DISABLED') throw new AwsError('ValidationException', `1 validation error detected: Value '${status}' at 'zonalAutoshiftStatus' failed to satisfy constraint: Member must satisfy enum value set: [ENABLED, DISABLED]`);
  const c = configOf(env, r.arn);
  if (status === 'ENABLED' && !c?.practiceRunConfiguration) throw new AwsError('ConflictException', `A practice run configuration is required before you can enable zonal autoshift for resource ${r.arn}.`);
  if (c) {
    if (status === 'ENABLED' && c.zonalAutoshiftStatus !== 'ENABLED') c.enabledAt = now;
    if (status === 'DISABLED') delete c.enabledAt;
    c.zonalAutoshiftStatus = status;
  }
  // an autoshift that starts now also moves traffic away: the impaired AZ starts healing like with a manual shift
  for (const a of autoshiftsAt(env, r.lb, now)) startRecoveryClock(env, a.awayFrom, now);
  trail(env, { source: SOURCE, name: 'UpdateZonalAutoshiftConfiguration', resources: [['AWS::ARCZonalShift::ZonalAutoshiftConfiguration', r.arn]], request: { resourceIdentifier: r.arn, zonalAutoshiftStatus: status }, response: { resourceIdentifier: r.arn, zonalAutoshiftStatus: status } });
  return { resourceIdentifier: r.arn, zonalAutoshiftStatus: status };
}

const alarmsIn = (env: AwsEnv, list: ControlCondition[], now: number) =>
  list.filter((c) => {
    const a = env.alarms.find((x) => x.alarmArn === c.alarmIdentifier);
    return a && evaluateAlarm(env, a, now).state === 'ALARM';
  });

/** StartPracticeRun: an on-demand 30-minute practice zonal shift (needs the practice run configuration and autoshift on) */
export function startPracticeRun(env: AwsEnv, input: { resourceIdentifier: string; awayFrom: string; comment: string }, now = Date.now()): ZonalShift {
  const r = getManagedResource(env, input.resourceIdentifier);
  checkAz(r, input.awayFrom);
  checkComment(input.comment);
  const c = configOf(env, r.arn);
  if (!c?.practiceRunConfiguration) throw new AwsError('ConflictException', `A practice run configuration is required to start a practice run for resource ${r.arn}.`);
  if (c.zonalAutoshiftStatus !== 'ENABLED') throw new AwsError('ConflictException', `Zonal autoshift must be enabled for resource ${r.arn} to start an on-demand practice run.`);
  if (alarmsIn(env, c.practiceRunConfiguration.blockingAlarms, now).length) throw new AwsError('ConflictException', 'The practice run was not started because one or more blocking alarms are in the ALARM state.');
  if (alarmsIn(env, c.practiceRunConfiguration.outcomeAlarms, now).length) throw new AwsError('ConflictException', 'The practice run was not started because one or more outcome alarms are in the ALARM state.');
  const st = state(env);
  const busy = st.shifts.find((s) => s.resourceIdentifier === r.arn && s.status === 'ACTIVE');
  if (busy) throw new AwsError('ConflictException', `Another zonal shift (${busy.zonalShiftId}) is active for resource ${r.arn}.`);
  const s: ZonalShift = { zonalShiftId: newUuid(), resourceIdentifier: r.arn, awayFrom: input.awayFrom, startTime: now, expiryTime: now + PRACTICE_RUN_MS, comment: input.comment, status: 'ACTIVE', shiftType: 'PRACTICE_RUN', practiceRunOutcome: 'PENDING' };
  st.shifts.push(s);
  startRecoveryClock(env, s.awayFrom, now);
  trail(env, { source: SOURCE, name: 'StartPracticeRun', resources: [['AWS::ARCZonalShift::ZonalShift', s.zonalShiftId]], request: { resourceIdentifier: r.arn, awayFrom: s.awayFrom, comment: s.comment }, response: shiftOut(s) });
  return s;
}

// ---------------- the clock ----------------

/** Finish transitions whose time has passed (called from advanceTime). true = something changed */
export function advanceZonalShift(env: AwsEnv, now: number): boolean {
  let changed = false;
  for (const s of env.zonalShift?.shifts ?? []) {
    if (s.status !== 'ACTIVE') continue;
    // practice runs end early when a blocking alarm (interrupted) or an outcome alarm (failed) goes into ALARM
    const cfg = s.shiftType === 'PRACTICE_RUN' && Number.isFinite(now) && now < s.expiryTime ? configOf(env, s.resourceIdentifier)?.practiceRunConfiguration : undefined;
    const outcome = cfg && (alarmsIn(env, cfg.blockingAlarms, now).length ? 'INTERRUPTED' : alarmsIn(env, cfg.outcomeAlarms, now).length ? 'FAILED' : undefined);
    if (outcome) {
      Object.assign(s, { status: 'CANCELED', endedAt: now, practiceRunOutcome: outcome });
      changed = true;
    } else if (now >= s.expiryTime) {
      s.status = 'EXPIRED';
      if (s.shiftType === 'PRACTICE_RUN') s.practiceRunOutcome = 'SUCCEEDED';
      changed = true;
    }
  }
  return changed;
}

/** Does this feature need the 1-second clock (something is in progress)? */
export function hasZonalShiftTransitions(env: AwsEnv): boolean {
  return !!env.zonalShift?.shifts.some((s) => s.status === 'ACTIVE');
}
