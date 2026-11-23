// AWS Systems Manager Session Manager (lesson 46): managed nodes, sessions, preferences.
// The state lives in AwsEnv as an optional field (sessions saved by older versions don't have it).
//
// An instance becomes a managed node when SSM Agent (preinstalled on the simulator's AMIs) has
// credentials from the instance profile with the agent permissions (AmazonSSMManagedInstanceCore) and
// can open HTTPS to ssm / ssmmessages / ec2messages: over the internet (IGW + public IP, or NAT) or through
// interface VPC endpoints with private DNS. The agent connects outward, so no inbound rule (port 22) is needed.
import { trail, type EventSource } from '../cloudtrail';
import { appendLog } from '../cloudwatch';
import { execCli, type CliResult } from '../cli';
import { AMIS, privateDnsName } from '../ec2';
import { nameOf } from '../env';
import { evaluateIamPermission, instanceRole } from '../iam';
import { newId } from '../ids';
import { canReachInternetFrom, type Check } from '../network';
import { evaluateSecurityGroup } from '../sg';
import { AwsError, type AwsEnv, type Instance } from '../types';
import { endpointDnsName, flowPath } from '../vpc';

export interface SsmNode {
  instanceId: string;
  /** when the agent first had credentials and a path to the endpoints (registration in progress) */
  readySince?: number;
  registeredAt?: number;
  online: boolean;
  /** the last ping before the connection was lost */
  lastPingAt?: number;
}

export interface SsmSession {
  sessionId: string;
  /** instance id */
  target: string;
  status: 'Connected' | 'Terminated';
  startDate: number;
  endDate?: number;
  /** ARN of the IAM principal that started it */
  owner: string;
  reason?: string;
  /** CloudWatch Logs logging, fixed when the session starts (preferences apply to new sessions) */
  logGroupName?: string;
  streaming?: boolean;
  /** upload mode: the session output, written to the log group when the session ends */
  transcript?: string[];
}

/** inputs of the SSM-SessionManagerRunShell document (Session Manager preferences), as in the AWS template */
export interface SessionPreferences {
  s3BucketName: string;
  s3KeyPrefix: string;
  s3EncryptionEnabled: boolean;
  cloudWatchLogGroupName: string;
  cloudWatchEncryptionEnabled: boolean;
  cloudWatchStreamingEnabled: boolean;
  kmsKeyId: string;
  runAsEnabled: boolean;
  runAsDefaultUser: string;
  idleSessionTimeout: string;
  maxSessionDuration: string;
  shellProfile: { windows: string; linux: string };
}

export interface SsmState {
  nodes: SsmNode[];
  sessions: SsmSession[];
  preferences: SessionPreferences;
  /** latest version of the SSM-SessionManagerRunShell document */
  documentVersion: number;
  documentCreatedAt: number;
}

const SSM_SOURCE: EventSource = 'ssm';
export const PREFERENCES_DOCUMENT = 'SSM-SessionManagerRunShell';
/** the shell an SSM session gets on Amazon Linux 2023 */
export const SSM_PROMPT = 'sh-5.2$';
export const AGENT_VERSION = '3.3.2299.0';
/** how long the agent takes to register once it has credentials and a network path (real: up to a few minutes) */
export const REGISTER_MS = 5000;
const PING_MS = 5 * 60_000;

export const DEFAULT_PREFERENCES: SessionPreferences = {
  s3BucketName: '',
  s3KeyPrefix: '',
  s3EncryptionEnabled: true,
  cloudWatchLogGroupName: '',
  // the simulator's log groups are not KMS-encrypted, so enforcing encryption would block logging
  cloudWatchEncryptionEnabled: false,
  cloudWatchStreamingEnabled: true,
  kmsKeyId: '',
  runAsEnabled: false,
  runAsDefaultUser: '',
  idleSessionTimeout: '20',
  maxSessionDuration: '',
  shellProfile: { windows: '', linux: '' },
};

export const emptySsm = (now: number): SsmState => ({ nodes: [], sessions: [], preferences: structuredClone(DEFAULT_PREFERENCES), documentVersion: 1, documentCreatedAt: now });

function state(env: AwsEnv, now = Date.now()): SsmState {
  env.ssm ??= emptySsm(now);
  return env.ssm;
}

// ---------- is the agent connected? ----------

export type SsmService = 'ssm' | 'ssmmessages' | 'ec2messages' | 'logs';
export const AGENT_SERVICES: SsmService[] = ['ssm', 'ssmmessages', 'ec2messages'];
/** a public address per service for the internet path check (outside every VPC range) */
const PUBLIC_IP: Record<SsmService, string> = { ssm: '52.119.161.5', ssmmessages: '52.119.161.6', ec2messages: '52.119.161.7', logs: '52.119.161.8' };
const AGENT_ACTIONS = ['ssm:UpdateInstanceInformation', 'ssmmessages:CreateControlChannel', 'ssmmessages:OpenDataChannel', 'ec2messages:GetMessages'];

const allowed = (env: AwsEnv, roleName: string, i: Instance, action: string, resource = '*') =>
  evaluateIamPermission(env, { principal: { type: 'role', roleName, sessionName: i.instanceId }, action, resource }).decision === 'Allow';

/**
 * Can the instance open HTTPS to the service's regional name (ssm.ap-northeast-1.amazonaws.com)?
 * With an interface endpoint whose private DNS is on, the name resolves to the endpoint's network interfaces
 * (local route; both security groups must allow TCP 443). Otherwise it resolves to a public address:
 * the internet gateway (with a public IP) or a NAT gateway.
 * ponytail: network ACLs are checked on the internet gateway path only.
 */
export function serviceReach(env: AwsEnv, i: Instance, svc: SsmService): Check {
  const serviceName = `com.amazonaws.${env.region}.${svc}`;
  const host = endpointDnsName(serviceName);
  const title = `${host} (HTTPS 443)`;
  const eps = env.vpcEndpoints.filter((e) => e.vpcId === i.vpcId && e.type === 'Interface' && e.serviceName === serviceName);
  const ep = eps.find((e) => e.privateDnsEnabled);
  if (ep) {
    const az = env.subnets.find((s) => s.subnetId === i.subnetId)?.availabilityZone;
    const eni = ep.networkInterfaces?.find((n) => env.subnets.find((s) => s.subnetId === n.subnetId)?.availabilityZone === az) ?? ep.networkInterfaces?.[0];
    if (!eni) return { label: title, ok: false, detail: `${ep.vpcEndpointId} にサブネットがありません (ネットワークインターフェイスが 1 つもありません)` };
    const groups = ep.securityGroupIds ?? [];
    const out = evaluateSecurityGroup(env, i.securityGroupIds, 'egress', { protocol: 'tcp', port: 443, peerIp: eni.privateIp, peerGroupIds: groups });
    if (!out.allowed) return { label: title, ok: false, detail: `インスタンスのセキュリティグループのアウトバウンドルールが、${ep.vpcEndpointId} (${eni.privateIp}) への TCP 443 を許可していません` };
    const inb = evaluateSecurityGroup(env, groups, 'ingress', { protocol: 'tcp', port: 443, peerIp: i.privateIpAddress, peerGroupIds: i.securityGroupIds });
    const names = groups.map((g) => env.securityGroups.find((x) => x.groupId === g)?.groupName ?? g).join(', ');
    if (!inb.allowed) return { label: title, ok: false, detail: `${ep.vpcEndpointId} のセキュリティグループ (${names}) のインバウンドルールが、${i.privateIpAddress} からの TCP 443 を許可していません` };
    return { label: title, ok: true, detail: `${host} → ${ep.vpcEndpointId} (${eni.privateIp}、インターフェイスエンドポイント)。VPC 内の local ルートで届きます` };
  }
  const noDns = eps.length ? ` (${eps.map((e) => e.vpcEndpointId).join(', ')} はプライベート DNS 名が無効なので使われません)` : '';
  const path = flowPath(env, i.subnetId, 'internet');
  if (path.via === 'none') return { label: title, ok: false, detail: `${host} はパブリック IP アドレスに解決されますが、${path.detail}${noDns}。NAT ゲートウェイか、プライベート DNS 名を有効にしたインターフェイスエンドポイントが必要です` };
  if (path.via === 'igw') {
    const failed = canReachInternetFrom(env, i.instanceId, PUBLIC_IP[svc], 443).checks.find((c) => !c.ok);
    return failed ? { label: title, ok: false, detail: `${failed.label}: ${failed.detail}${noDns}` } : { label: title, ok: true, detail: `${host} → インターネットゲートウェイ (パブリック IP ${i.publicIpAddress})` };
  }
  const out = evaluateSecurityGroup(env, i.securityGroupIds, 'egress', { protocol: 'tcp', port: 443, peerIp: PUBLIC_IP[svc], peerGroupIds: [] });
  return out.allowed ? { label: title, ok: true, detail: `${host} → ${path.nat!.natGatewayId} (NAT ゲートウェイ)` } : { label: title, ok: false, detail: 'インスタンスのセキュリティグループのアウトバウンドルールが、インターネットへの TCP 443 を許可していません' };
}

/** Why the instance is (not) a managed node: state, agent, instance profile, permissions, the three endpoints. */
export function diagnoseNode(env: AwsEnv, instanceId: string): { ok: boolean; checks: Check[] } {
  const i = env.instances.find((x) => x.instanceId === instanceId);
  if (!i) return { ok: false, checks: [{ label: 'インスタンス', ok: false, detail: `${instanceId} が見つかりません` }] };
  const ami = AMIS.find((a) => a.imageId === i.imageId);
  const r = instanceRole(env, i.instanceId);
  const missing = r.role ? AGENT_ACTIONS.filter((a) => !allowed(env, r.role!.roleName, i, a)) : AGENT_ACTIONS;
  const checks: Check[] = [
    { label: 'インスタンスの状態', ok: i.state === 'running', detail: i.state === 'running' ? '実行中' : `${i.state}: SSM Agent は実行中のインスタンスでだけ動きます` },
    { label: 'SSM Agent', ok: !!ami, detail: ami ? `${ami.name} にはプリインストールされています (バージョン ${AGENT_VERSION})` : 'SSM Agent がインストールされていません' },
    {
      label: 'IAM インスタンスプロファイル',
      ok: !!r.role && !r.problem,
      detail: r.problem === 'no-profile' ? 'IAM ロールがアタッチされていません。エージェントは認証情報を得られません' : r.problem === 'no-role' ? 'インスタンスプロファイルにロールがありません' : r.problem === 'trust' ? `${r.role!.roleName} の信頼ポリシーが ec2.amazonaws.com を許可していません` : `${r.role!.roleName}`,
    },
    {
      label: 'IAM ロールの許可',
      ok: !!r.role && !missing.length,
      detail: !r.role ? '-' : missing.length ? `${r.role.roleName} に ${missing.join(', ')} の許可がありません (AWS 管理ポリシー AmazonSSMManagedInstanceCore に含まれます)` : `${r.role.roleName} は SSM Agent に必要な操作 (ssm / ssmmessages / ec2messages) を許可しています`,
    },
    ...AGENT_SERVICES.map((s) => serviceReach(env, i, s)),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

const nodeOf = (env: AwsEnv, id: string) => env.ssm?.nodes.find((n) => n.instanceId === id);

export type PingStatus = 'Online' | 'ConnectionLost';

/** undefined = not a managed node (the agent never registered) */
export function pingStatus(env: AwsEnv, instanceId: string): PingStatus | undefined {
  const n = nodeOf(env, instanceId);
  return n?.registeredAt === undefined ? undefined : n.online ? 'Online' : 'ConnectionLost';
}

export interface ManagedNode {
  instance: Instance;
  name: string;
  pingStatus: PingStatus;
  lastPingAt: number;
  registeredAt: number;
  agentVersion: string;
  platformType: 'Linux' | 'Windows';
  platformName: string;
  platformVersion: string;
  computerName: string;
}

const PLATFORM: Record<string, [ManagedNode['platformType'], string, string]> = {
  'Amazon Linux 2023 AMI': ['Linux', 'Amazon Linux', '2023'],
  'Ubuntu Server 24.04 LTS (HVM), SSD Volume Type': ['Linux', 'Ubuntu', '24.04'],
  'Microsoft Windows Server 2022 Base': ['Windows', 'Microsoft Windows Server 2022 Datacenter', '10.0.20348'],
};

/** DescribeInstanceInformation: registered nodes, except stopped / terminated instances (like the API). */
export function managedNodes(env: AwsEnv, now = Date.now()): ManagedNode[] {
  return (env.ssm?.nodes ?? []).flatMap((n) => {
    const i = env.instances.find((x) => x.instanceId === n.instanceId);
    if (!i || n.registeredAt === undefined || ['stopped', 'terminated'].includes(i.state)) return [];
    const [platformType, platformName, platformVersion] = PLATFORM[AMIS.find((a) => a.imageId === i.imageId)?.name ?? ''] ?? ['Linux', 'Amazon Linux', '2023'];
    const lastPingAt = n.online ? Math.max(n.registeredAt, now - (now % PING_MS)) : (n.lastPingAt ?? n.registeredAt);
    return [{ instance: i, name: nameOf(i), pingStatus: n.online ? 'Online' : 'ConnectionLost', lastPingAt, registeredAt: n.registeredAt, agentVersion: AGENT_VERSION, platformType, platformName, platformVersion, computerName: privateDnsName(env, i.privateIpAddress) }];
  });
}

/** Finish transitions whose time has passed (called from advanceTime). true = something changed */
export function advanceSsm(env: AwsEnv, now: number): boolean {
  if (!env.ssm) return false;
  const t = Number.isFinite(now) ? now : Date.now();
  let changed = false;
  for (const i of env.instances) {
    if (i.state === 'terminated') continue;
    const ready = diagnoseNode(env, i.instanceId).ok;
    let n = nodeOf(env, i.instanceId);
    if (ready) {
      if (!n) {
        env.ssm.nodes.push((n = { instanceId: i.instanceId, online: false }));
        changed = true;
      }
      if (n.online) continue;
      // reconnecting is immediate; the first registration takes REGISTER_MS (settled at once when building scenarios)
      if (n.registeredAt !== undefined || !Number.isFinite(now) || (n.readySince !== undefined && t - n.readySince >= REGISTER_MS)) {
        Object.assign(n, { registeredAt: n.registeredAt ?? t, online: true, readySince: undefined });
        changed = true;
      } else if (n.readySince === undefined) {
        n.readySince = t;
        changed = true;
      }
    } else if (n && (n.online || n.readySince !== undefined)) {
      changed = true;
      n.readySince = undefined;
      if (n.online) {
        n.online = false;
        n.lastPingAt = t;
        // the agent is gone: its sessions end
        for (const s of env.ssm.sessions.filter((x) => x.target === i.instanceId && x.status === 'Connected')) closeSession(env, s, t);
      }
    }
  }
  return changed;
}

/** Does this feature need the 1-second clock (something is in progress)? */
export function hasSsmTransitions(env: AwsEnv): boolean {
  if (!env.ssm) return false;
  return env.instances.some((i) => {
    if (i.state === 'terminated') return false;
    const n = nodeOf(env, i.instanceId);
    const ready = diagnoseNode(env, i.instanceId).ok;
    return ready ? !n?.online : !!n && (n.online || n.readySince !== undefined);
  });
}

// ---------- sessions ----------

export const sessionOf = (env: AwsEnv, sessionId: string) => env.ssm?.sessions.find((s) => s.sessionId === sessionId);

/** StartSession (document SSM-SessionManagerRunShell). The node must be Online. */
export function startSession(env: AwsEnv, input: { target: string; reason?: string; userName: string; ownerArn: string }, now = Date.now()): string {
  if (pingStatus(env, input.target) !== 'Online') throw new AwsError('TargetNotConnected', `${input.target} is not connected.`);
  const reason = input.reason?.trim();
  if (reason && reason.length > 256) throw new AwsError('ValidationException', "1 validation error detected: Value at 'reason' failed to satisfy constraint: Member must have length less than or equal to 256");
  const st = state(env, now);
  const sessionId = newId(input.userName);
  const prefs = st.preferences;
  st.sessions.push({
    sessionId,
    target: input.target,
    status: 'Connected',
    startDate: now,
    owner: input.ownerArn,
    ...(reason ? { reason } : {}),
    ...(prefs.cloudWatchLogGroupName ? { logGroupName: prefs.cloudWatchLogGroupName, streaming: prefs.cloudWatchStreamingEnabled, ...(prefs.cloudWatchStreamingEnabled ? {} : { transcript: [] }) } : {}),
  });
  trail(env, {
    source: SSM_SOURCE,
    name: 'StartSession',
    resources: [['AWS::EC2::Instance', input.target]],
    request: { target: input.target, ...(reason ? { reason } : {}) },
    response: { sessionId, tokenValue: 'Value hidden due to security reasons.', streamUrl: `wss://ssmmessages.${env.region}.amazonaws.com/v1/data-channel/${sessionId}?role=publish_subscribe&cell-number=AAEAAQ` },
  });
  return sessionId;
}

function closeSession(env: AwsEnv, s: { status: string; endDate?: number; transcript?: string[]; logGroupName?: string; sessionId: string; target: string }, now: number) {
  s.status = 'Terminated';
  s.endDate = now;
  if (s.transcript && s.logGroupName && canWriteLog(env, s.target, s.logGroupName)) appendLog(env, s.logGroupName, s.sessionId, [s.transcript.join('\n')], now);
  delete s.transcript;
}

/** TerminateSession (the console's 終了 button, aws ssm terminate-session). Ending a terminated session again is a no-op. */
export function terminateSession(env: AwsEnv, sessionId: string, now = Date.now()) {
  const s = sessionOf(env, sessionId);
  if (!s) throw new AwsError('DoesNotExistException', `Session with id ${sessionId} does not exist.`);
  if (s.status === 'Connected') closeSession(env, s, now);
  trail(env, { source: SSM_SOURCE, name: 'TerminateSession', resources: [['AWS::EC2::Instance', s.target]], request: { sessionId }, response: { sessionId } });
}

/** `exit` in the session's shell: the agent ends the session (no API call by the user). */
export function exitSession(env: AwsEnv, sessionId: string, now = Date.now()) {
  const s = sessionOf(env, sessionId);
  if (s?.status === 'Connected') closeSession(env, s, now);
}

/** What the CLI plugin / browser tab prints when the session ended while attached. */
export const terminatedMessage = (sessionId: string) => `SessionId: ${sessionId} : Your session has been terminated for the following reasons: ConnectionLost or TerminateSession`;

/**
 * One command line in the session's shell (as ssm-user), logged to CloudWatch Logs when the session has logging.
 * The command runs on the instance like any other shell (sim/cli.ts).
 */
export function sessionCommand(env: AwsEnv, sessionId: string, line: string, files: Record<string, string>, now = Date.now()): CliResult {
  const s = sessionOf(env, sessionId);
  if (!s || s.status !== 'Connected') return { ok: false, output: terminatedMessage(sessionId) };
  const r = execCli(env, s.target, line, files, 'ssm-user');
  if (s.logGroupName) {
    const lines = [`${SSM_PROMPT} ${line}`, ...(r.output ? r.output.split('\n') : [])];
    if (s.transcript) s.transcript.push(...lines);
    else if (canWriteLog(env, s.target, s.logGroupName))
      appendLog(env, s.logGroupName, s.sessionId, [JSON.stringify({ eventVersion: '1.0', eventTime: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'), awsRegion: env.region, target: { id: s.target }, userIdentity: { arn: s.owner }, runAsUser: 'ssm-user', sessionId: s.sessionId, sessionData: lines })], now);
  }
  return r;
}

/**
 * Can the agent on the instance write session logs to the group? The group must exist, the instance role needs
 * logs:CreateLogStream / logs:PutLogEvents, and the instance needs a path to CloudWatch Logs (logs endpoint).
 */
export function logChecks(env: AwsEnv, instanceId: string, groupName: string): Check[] {
  const i = env.instances.find((x) => x.instanceId === instanceId);
  const group = env.logGroups.find((g) => g.logGroupName === groupName);
  if (!i) return [{ label: 'インスタンス', ok: false, detail: `${instanceId} が見つかりません` }];
  const role = instanceRole(env, instanceId).role;
  const arn = group ? group.arn.replace(/:\*$/, ':log-stream:*') : '*';
  const missing = role ? ['logs:CreateLogStream', 'logs:PutLogEvents'].filter((a) => !allowed(env, role.roleName, i, a, arn)) : ['logs:CreateLogStream', 'logs:PutLogEvents'];
  return [
    { label: 'ロググループ', ok: !!group, detail: group ? groupName : `ロググループ ${groupName} が存在しません` },
    { label: 'IAM ロールの許可 (CloudWatch Logs)', ok: !missing.length, detail: missing.length ? `${role?.roleName ?? 'ロールなし'}: ${missing.join(', ')} が許可されていません` : `${role!.roleName} は logs:CreateLogStream / logs:PutLogEvents を許可しています` },
    serviceReach(env, i, 'logs'),
  ];
}

const canWriteLog = (env: AwsEnv, instanceId: string, groupName: string) => logChecks(env, instanceId, groupName).every((c) => c.ok);

// ---------- preferences (the SSM-SessionManagerRunShell document) ----------

export const preferencesOf = (env: AwsEnv): SessionPreferences => env.ssm?.preferences ?? DEFAULT_PREFERENCES;

/** The document content, as GetDocument returns it. */
export function preferencesDocument(env: AwsEnv): string {
  return JSON.stringify({ schemaVersion: '1.0', description: 'Document to hold regional settings for Session Manager', sessionType: 'Standard_Stream', inputs: preferencesOf(env) }, null, 4);
}

/** Session Manager preferences: the console's 設定 → 編集, or UpdateDocument on SSM-SessionManagerRunShell. Returns the new document version. */
export function updatePreferences(env: AwsEnv, inputs: Partial<SessionPreferences>, now = Date.now()): number {
  const st = state(env, now);
  const timeout = Number(inputs.idleSessionTimeout ?? st.preferences.idleSessionTimeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) throw new AwsError('InvalidDocumentContent', 'idleSessionTimeout must be a number of minutes from 1 to 60');
  st.preferences = { ...st.preferences, ...inputs };
  st.documentVersion++;
  trail(env, {
    source: SSM_SOURCE,
    name: 'UpdateDocument',
    resources: [['AWS::SSM::Document', PREFERENCES_DOCUMENT]],
    request: { name: PREFERENCES_DOCUMENT, documentVersion: '$LATEST', content: preferencesDocument(env) },
    response: { documentDescription: { name: PREFERENCES_DOCUMENT, documentVersion: String(st.documentVersion), latestVersion: String(st.documentVersion), status: 'Updating' } },
  });
  return st.documentVersion;
}
