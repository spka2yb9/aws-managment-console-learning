import { ipInCidr, isValidCidr } from './cidr';
import { quietly, trail } from './cloudtrail';
import { getSg, getVpc } from './env';
import { newId } from './ids';
import { AwsError, type AwsEnv, type IpProtocol, type SecurityGroup, type SecurityGroupRule } from './types';

export type Direction = 'ingress' | 'egress';

export interface Packet {
  protocol: Exclude<IpProtocol, '-1'>;
  port: number;
  /** the other side of the connection: source for ingress, destination for egress */
  peerIp: string;
  /** security groups attached to the peer's network interface */
  peerGroupIds: string[];
}

export interface SgEvaluation {
  allowed: boolean;
  groupId?: string;
  rule?: SecurityGroupRule;
}

export function ruleMatchesTraffic(rule: SecurityGroupRule, protocol: Packet['protocol'], port: number): boolean {
  if (rule.ipProtocol === '-1') return true;
  if (rule.ipProtocol !== protocol) return false;
  if (rule.fromPort === -1) return true;
  return port >= rule.fromPort && port <= rule.toPort;
}

export function ruleMatchesPeer(rule: SecurityGroupRule, peerIp: string, peerGroupIds: string[]): boolean {
  if (rule.referencedGroupId) return peerGroupIds.includes(rule.referencedGroupId);
  return !!rule.cidrIpv4 && ipInCidr(peerIp, rule.cidrIpv4);
}

/**
 * Security groups are allow-only and the rules of all groups on an interface are aggregated:
 * traffic is allowed if ANY rule of ANY attached group matches. No match = implicit deny.
 * (Stateful: the response of an allowed connection is always allowed, so callers only check the initiating direction.)
 */
export function evaluateSecurityGroup(env: AwsEnv, groupIds: string[], direction: Direction, packet: Packet): SgEvaluation {
  for (const groupId of groupIds) {
    const sg = env.securityGroups.find((g) => g.groupId === groupId);
    const rule = sg?.[direction].find((r) => ruleMatchesTraffic(r, packet.protocol, packet.port) && ruleMatchesPeer(r, packet.peerIp, packet.peerGroupIds));
    if (rule) return { allowed: true, groupId, rule };
  }
  return { allowed: false };
}

// ---------- console "Type" presets ----------

export interface RuleType {
  label: string;
  protocol: IpProtocol;
  /** fixed port range; undefined = user enters it (Custom TCP/UDP) */
  ports?: [number, number];
}

export const RULE_TYPES: RuleType[] = [
  // Labels as shown by the Japanese console.
  { label: 'カスタム TCP', protocol: 'tcp' },
  { label: 'カスタム UDP', protocol: 'udp' },
  { label: 'すべての TCP', protocol: 'tcp', ports: [0, 65535] },
  { label: 'すべての UDP', protocol: 'udp', ports: [0, 65535] },
  { label: 'すべての ICMP - IPv4', protocol: 'icmp', ports: [-1, -1] },
  { label: 'すべてのトラフィック', protocol: '-1', ports: [-1, -1] },
  { label: 'SSH', protocol: 'tcp', ports: [22, 22] },
  { label: 'SMTP', protocol: 'tcp', ports: [25, 25] },
  { label: 'DNS (UDP)', protocol: 'udp', ports: [53, 53] },
  { label: 'DNS (TCP)', protocol: 'tcp', ports: [53, 53] },
  { label: 'HTTP', protocol: 'tcp', ports: [80, 80] },
  { label: 'HTTPS', protocol: 'tcp', ports: [443, 443] },
  { label: 'MYSQL/Aurora', protocol: 'tcp', ports: [3306, 3306] },
  { label: 'PostgreSQL', protocol: 'tcp', ports: [5432, 5432] },
  { label: 'RDP', protocol: 'tcp', ports: [3389, 3389] },
  { label: 'Redis', protocol: 'tcp', ports: [6379, 6379] },
];

export function ruleTypeOf(rule: Pick<SecurityGroupRule, 'ipProtocol' | 'fromPort' | 'toPort'>): RuleType {
  return (
    RULE_TYPES.find((t) => t.ports && t.protocol === rule.ipProtocol && t.ports[0] === rule.fromPort && t.ports[1] === rule.toPort) ??
    RULE_TYPES.find((t) => !t.ports && t.protocol === rule.ipProtocol) ??
    RULE_TYPES[0]
  );
}

export function protocolLabel(p: IpProtocol): string {
  return p === '-1' ? 'すべて' : p.toUpperCase();
}

export function portRangeLabel(rule: Pick<SecurityGroupRule, 'ipProtocol' | 'fromPort' | 'toPort'>): string {
  if (rule.ipProtocol === '-1' || rule.fromPort === -1) return 'すべて';
  return rule.fromPort === rule.toPort ? String(rule.fromPort) : `${rule.fromPort} - ${rule.toPort}`;
}

export function sourceOf(rule: SecurityGroupRule): string {
  return rule.referencedGroupId ?? rule.cidrIpv4 ?? '';
}

// ---------- operations ----------

export interface RuleInput {
  securityGroupRuleId?: string;
  ipProtocol: IpProtocol;
  fromPort: number;
  toPort: number;
  /** CIDR (10.0.0.0/16) or security group id (sg-...) */
  source: string;
  description?: string;
}

function toRule(env: AwsEnv, sg: SecurityGroup, input: RuleInput): SecurityGroupRule {
  const source = input.source.trim();
  const ports = input.ipProtocol === '-1' ? [-1, -1] : [input.fromPort, input.toPort];
  if (input.ipProtocol === 'tcp' || input.ipProtocol === 'udp') {
    const [from, to] = ports;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 65535 || from > to)
      throw new AwsError('InvalidParameterValue', `Invalid port range: ${from}-${to}. Ports must be between 0 and 65535 and the start port must not be greater than the end port.`);
  }
  const base = { securityGroupRuleId: input.securityGroupRuleId ?? newId('sgr'), ipProtocol: input.ipProtocol, fromPort: ports[0], toPort: ports[1], description: input.description?.trim() || undefined };
  if (source.startsWith('sg-')) {
    const ref = env.securityGroups.find((g) => g.groupId === source);
    if (!ref) throw new AwsError('InvalidGroup.NotFound', `The security group '${source}' does not exist`);
    if (ref.vpcId !== sg.vpcId) throw new AwsError('InvalidGroup.NotFound', `You have specified two resources that belong to different networks.`);
    return { ...base, referencedGroupId: source };
  }
  if (!isValidCidr(source)) throw new AwsError('InvalidParameterValue', `CIDR block ${source || '(empty)'} is malformed`);
  return { ...base, cidrIpv4: source };
}

/** rules in the ipPermissions shape of the EC2 API (what CloudTrail shows in requestParameters) */
function ipPermissions(rules: SecurityGroupRule[]) {
  return {
    items: rules.map((r) => ({
      ipProtocol: r.ipProtocol,
      fromPort: r.fromPort,
      toPort: r.toPort,
      groups: r.referencedGroupId ? { items: [{ groupId: r.referencedGroupId, ...(r.description ? { description: r.description } : {}) }] } : {},
      ipRanges: r.cidrIpv4 ? { items: [{ cidrIp: r.cidrIpv4, ...(r.description ? { description: r.description } : {}) }] } : {},
      ipv6Ranges: {},
      prefixListIds: {},
    })),
  };
}

function ruleKey(r: SecurityGroupRule) {
  return [r.ipProtocol, r.fromPort, r.toPort, r.cidrIpv4 ?? r.referencedGroupId].join('|');
}

/**
 * "Edit inbound/outbound rules" submits the full rule list; AWS applies it as Revoke + Authorize.
 * Unchanged rules keep their security group rule id. Returns what was revoked / authorized (CloudTrail-style).
 */
export function setSecurityGroupRules(env: AwsEnv, groupId: string, direction: Direction, inputs: RuleInput[]) {
  const sg = getSg(env, groupId);
  const rules = inputs.map((i) => toRule(env, sg, i));
  const keys = new Set<string>();
  for (const r of rules) {
    const k = ruleKey(r);
    if (keys.has(k))
      throw new AwsError('InvalidPermission.Duplicate', `the specified rule "peer: ${r.cidrIpv4 ?? r.referencedGroupId}, ${protocolLabel(r.ipProtocol)}, from port: ${r.fromPort}, to port: ${r.toPort}, ALLOW" already exists`);
    keys.add(k);
  }
  const before = new Set(sg[direction].map(ruleKey));
  const revoked = sg[direction].filter((r) => !keys.has(ruleKey(r)));
  const authorized = rules.filter((r) => !before.has(ruleKey(r)));
  sg[direction] = rules;
  const kind = direction === 'ingress' ? 'Ingress' : 'Egress';
  const res: [string, string][] = [['AWS::EC2::SecurityGroup', groupId]];
  if (revoked.length) trail(env, { source: 'ec2', name: `RevokeSecurityGroup${kind}`, resources: res, request: { groupId, ipPermissions: ipPermissions(revoked) } });
  if (authorized.length)
    trail(env, {
      source: 'ec2',
      name: `AuthorizeSecurityGroup${kind}`,
      resources: res,
      request: { groupId, ipPermissions: ipPermissions(authorized) },
      response: { _return: true, securityGroupRuleSet: { items: authorized.map((r) => ({ groupOwnerId: env.accountId, groupId, securityGroupRuleId: r.securityGroupRuleId, isEgress: direction === 'egress', ipProtocol: r.ipProtocol, fromPort: r.fromPort, toPort: r.toPort, ...(r.cidrIpv4 ? { cidrIpv4: r.cidrIpv4 } : { referencedGroupInfo: { groupId: r.referencedGroupId, userId: env.accountId } }), ...(r.description ? { description: r.description } : {}) })) } },
    });
  return { revoked, authorized };
}

export function createSecurityGroup(env: AwsEnv, input: { groupName: string; description: string; vpcId: string; name?: string; ingress?: RuleInput[]; egress?: RuleInput[] }): string {
  getVpc(env, input.vpcId);
  const groupName = input.groupName.trim();
  if (!groupName) throw new AwsError('MissingParameter', 'The request must contain the parameter groupName');
  if (groupName.toLowerCase().startsWith('sg-')) throw new AwsError('InvalidParameterValue', "Group names may not be in the format sg-*.");
  if (groupName === 'default') throw new AwsError('InvalidParameterValue', "Cannot use reserved security group name: default");
  if (!input.description.trim()) throw new AwsError('MissingParameter', 'The request must contain the parameter groupDescription');
  if (env.securityGroups.some((g) => g.vpcId === input.vpcId && g.groupName === groupName))
    throw new AwsError('InvalidGroup.Duplicate', `The security group '${groupName}' already exists for VPC '${input.vpcId}'`);
  const groupId = newId('sg');
  const sg: SecurityGroup = { groupId, groupName, description: input.description.trim(), vpcId: input.vpcId, ingress: [], egress: [], tags: input.name ? [{ key: 'Name', value: input.name }] : [] };
  env.securityGroups.push(sg);
  trail(env, { source: 'ec2', name: 'CreateSecurityGroup', resources: [['AWS::EC2::SecurityGroup', groupId], ['AWS::EC2::VPC', input.vpcId]], request: { groupName, groupDescription: sg.description, vpcId: input.vpcId }, response: { _return: true, groupId } });
  setSecurityGroupRules(env, groupId, 'ingress', input.ingress ?? []);
  // New groups allow all outbound traffic unless told otherwise (that default rule is not a separate API call).
  if (input.egress) setSecurityGroupRules(env, groupId, 'egress', input.egress);
  else quietly(() => setSecurityGroupRules(env, groupId, 'egress', [{ ipProtocol: '-1', fromPort: -1, toPort: -1, source: '0.0.0.0/0' }]));
  return groupId;
}

/** Everything that has this group attached (instances, load balancers, DB instances). */
export function sgUsers(env: AwsEnv, groupId: string): string[] {
  return [
    ...env.instances.filter((i) => i.state !== 'terminated' && i.securityGroupIds.includes(groupId)).map((i) => i.instanceId),
    ...env.loadBalancers.filter((l) => l.securityGroupIds.includes(groupId)).map((l) => l.loadBalancerName),
    ...env.dbInstances.filter((d) => d.vpcSecurityGroupIds.includes(groupId)).map((d) => d.dbInstanceIdentifier),
  ];
}
