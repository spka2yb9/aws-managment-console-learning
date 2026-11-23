// Lesson 43 scenario: GuardDuty has been on for two months. admin-1 (the internal admin tool, public subnet) has a
// "URL を指定してプレビューする" feature that fetches any URL server-side (SSRF). Someone used it to read the instance
// role's credentials from IMDSv1 and is calling AWS APIs with them from a VPS: a High finding. The base (web app,
// admin-1 + admin-tool-role, a vulnerability scanner) is prepared; the learner only responds.
import { advanceTime } from '../time';
import { byName } from '../env';
import { createPolicy, createRole, createUser, sessionArn, setInstanceProfile } from '../iam';
import { hash, newUuid, stableChars } from '../ids';
import { EC2_INSTANCE_CONNECT_RANGES } from '../network';
import { REPORTS_BUCKET, webAppEnv } from '../scenarios';
import { createBucket, putObject } from '../s3';
import { createSecurityGroup } from '../sg';
import { runInstances } from '../ec2';
import { quietly } from '../cloudtrail';
import type { AwsEnv, Instance, TrailEvent } from '../types';
import { instanceDetails, type Finding, type RemoteIpDetails } from './guardduty';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HEX = '0123456789abcdef';

/** the attacker's rented server (TEST-NET-1 address, documentation ASN) */
export const ATTACKER_IP = '192.0.2.66';
const ATTACKER: RemoteIpDetails = {
  ipAddressV4: ATTACKER_IP,
  city: { cityName: 'Amsterdam' },
  country: { countryName: 'Netherlands' },
  geoLocation: { lat: 52.3759, lon: 4.8975 },
  organization: { asn: '64501', asnOrg: 'EXAMPLE-VPS-HOSTING', isp: 'Example VPS Hosting B.V.', org: 'Example VPS Hosting B.V.' },
};
const ATTACKER_UA = 'Boto3/1.35.36 md/Botocore#1.35.36 ua/2.0 os/linux#6.8.0-45-generic md/arch#x86_64 lang/python#3.12.3 md/pyimpl#CPython cfg/retry-mode#legacy Botocore/1.35.36';
const ADMIN_TOOL_UA = 'aws-sdk-js/3.654.0 ua/2.1 os/linux#6.1.109-118.189.amzn2023.x86_64 lang/js md/nodejs#20.17.0 api/ec2#3.654.0';

/** the instance credentials admin-1 got from IMDS (and the attacker copied) */
export const STOLEN_KEY = `ASIA${stableChars('admin-1:credentials', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16)}`;
export const ADMIN_ROLE = 'admin-tool-role';

export const findingId = (seed: string) => stableChars(`finding:${seed}`, HEX, 32);
export const FINDING_IDS = { exfiltration: findingId('exfiltration'), portProbe: findingId('port-probe'), portscan: findingId('portscan') };

const iso = (t: number) => new Date(t).toISOString();
const isoSec = (t: number) => iso(t).replace(/\.\d+Z$/, 'Z');

function finding(env: AwsEnv, f: { id: string; type: string; severity: number; title: string; description: string; resource: Finding['resource']; action: Finding['service']['action']; resourceRole: 'TARGET' | 'ACTOR'; count: number; firstSeen: number; lastSeen: number }): Finding {
  const d = env.guardDuty!;
  return {
    accountId: env.accountId,
    arn: `arn:aws:guardduty:${env.region}:${env.accountId}:detector/${d.detectorId}/finding/${f.id}`,
    // GuardDuty reports a few minutes after the activity
    createdAt: iso(f.firstSeen + 5 * MIN + (hash(f.id) % 60_000)),
    description: f.description,
    id: f.id,
    partition: 'aws',
    region: env.region,
    resource: f.resource,
    schemaVersion: '2.0',
    service: {
      action: f.action,
      additionalInfo: { value: '{}', type: 'default' },
      archived: false,
      count: f.count,
      detectorId: d.detectorId,
      eventFirstSeen: isoSec(f.firstSeen),
      eventLastSeen: isoSec(f.lastSeen),
      resourceRole: f.resourceRole,
      serviceName: 'guardduty',
    },
    severity: f.severity,
    title: f.title,
    type: f.type,
    updatedAt: iso(f.lastSeen + 5 * MIN + (hash(f.id) % 60_000)),
  };
}

/** A management event made with admin-1's role session credentials (a read-only API call) */
function roleCall(env: AwsEnv, admin: Instance, roleId: string, e: { issued: number; at: number; ip: string; ua: string; source: string; name: string; request: unknown; resources?: [string, string][] }) {
  const userIdentity = {
    type: 'AssumedRole' as const,
    principalId: `${roleId}:${admin.instanceId}`,
    arn: sessionArn(env, ADMIN_ROLE, admin.instanceId),
    accountId: env.accountId,
    accessKeyId: STOLEN_KEY,
    userName: admin.instanceId,
    // ec2RoleDelivery 1.0 = the credentials were taken from IMDSv1 (no session token)
    sessionContext: { sessionIssuer: { type: 'Role', principalId: roleId, arn: `arn:aws:iam::${env.accountId}:role/${ADMIN_ROLE}`, accountId: env.accountId, userName: ADMIN_ROLE }, attributes: { creationDate: isoSec(e.issued), mfaAuthenticated: 'false' }, ec2RoleDelivery: '1.0' },
  };
  const ev: TrailEvent = {
    eventId: newUuid(),
    eventTime: e.at,
    eventName: e.name,
    eventSource: `${e.source}.amazonaws.com`,
    awsRegion: env.region,
    sourceIPAddress: e.ip,
    userAgent: e.ua,
    userIdentity: userIdentity as TrailEvent['userIdentity'],
    readOnly: true,
    resources: e.resources ?? [],
    requestParameters: e.request,
    responseElements: null,
    requestId: newUuid(),
  };
  env.trailEvents.push(ev);
}

export function guardDutyEnv(now = Date.now()): AwsEnv {
  return webAppEnv({}, (env) =>
    quietly(() => {
      const vpcId = byName(env.vpcs, 'webapp-vpc')!.vpcId;
      const subnet = (name: string) => byName(env.subnets, name)!.subnetId;
      createUser(env, { userName: 'learner', policyArns: ['arn:aws:iam::aws:policy/AdministratorAccess'], consoleAccess: true }, now - 60 * DAY);
      createBucket(env, { name: REPORTS_BUCKET }, now - 40 * DAY);
      putObject(env, REPORTS_BUCKET, 'reports/2026/11/sales-2026-11.csv', { size: 4096, contentType: 'text/csv', body: 'date,orders,revenue\n2026-11-01,1284,3920500\n' }, now - 2 * DAY);
      const policy = createPolicy(env, {
        policyName: 'admin-tool-policy',
        description: 'Internal admin tool: list servers and read reports',
        document: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['ec2:DescribeInstances', 's3:ListAllMyBuckets'], Resource: '*' }, { Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: [`arn:aws:s3:::${REPORTS_BUCKET}`, `arn:aws:s3:::${REPORTS_BUCKET}/*`] }] },
      }, now - 20 * DAY);
      createRole(env, { roleName: ADMIN_ROLE, description: 'Allows the internal admin tool on admin-1 to list servers and read reports', trustPolicy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] }, policyArns: [policy], withInstanceProfile: true }, now - 20 * DAY);
      const adminSg = createSecurityGroup(env, {
        groupName: 'admin-sg',
        name: 'admin-sg',
        description: 'Internal admin tool',
        vpcId,
        ingress: [
          { ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: '0.0.0.0/0', description: 'Admin tool (for remote work)' },
          { ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: EC2_INSTANCE_CONNECT_RANGES['ap-northeast-1'], description: 'EC2 Instance Connect' },
        ],
      });
      const scannerSg = createSecurityGroup(env, { groupName: 'scanner-sg', name: 'scanner-sg', description: 'Vulnerability scanner (outbound only)', vpcId });
      const [adminId] = runInstances(env, { name: 'admin-1', imageId: 'ami-0d52744d6551d851e', instanceType: 't3.small', keyName: 'webapp-key', subnetId: subnet('public-subnet-1a'), securityGroupIds: [adminSg] }, now - 20 * DAY);
      const [scannerId] = runInstances(env, { name: 'scanner-1', imageId: 'ami-0d52744d6551d851e', instanceType: 't3.small', keyName: 'webapp-key', subnetId: subnet('private-subnet-1a'), securityGroupIds: [scannerSg] }, now - 60 * DAY);
      setInstanceProfile(env, adminId, env.instanceProfiles.find((p) => p.instanceProfileName === ADMIN_ROLE)!.arn);
      advanceTime(env, Infinity);
      const admin = env.instances.find((i) => i.instanceId === adminId)!;
      const scanner = env.instances.find((i) => i.instanceId === scannerId)!;
      admin.tags.push({ key: 'Team', value: 'ops' });
      scanner.tags.push({ key: 'Role', value: 'vuln-scanner' });
      const web1 = byName(env.instances, 'web-1')!;
      const roleId = env.iamRoles.find((r) => r.roleName === ADMIN_ROLE)!.roleId;

      // CloudTrail: the admin tool lists servers from admin-1; the attacker uses the same credentials from the VPS
      const attack = now - 6 * HOUR - 10 * MIN;
      // one session (credentials valid for 6 hours) used by both
      const issued = now - 7 * HOUR;
      const fromAdmin = { issued, ip: admin.publicIpAddress!, ua: ADMIN_TOOL_UA };
      const fromAttacker = { issued, ip: ATTACKER_IP, ua: ATTACKER_UA };
      const describe = { instancesSet: {}, filterSet: {} };
      roleCall(env, admin, roleId, { ...fromAdmin, at: now - 6 * HOUR - 40 * MIN, source: 'ec2', name: 'DescribeInstances', request: describe });
      roleCall(env, admin, roleId, { ...fromAttacker, at: attack, source: 'sts', name: 'GetCallerIdentity', request: null });
      roleCall(env, admin, roleId, { ...fromAttacker, at: attack + 2 * MIN, source: 's3', name: 'ListBuckets', request: { Host: `s3.${env.region}.amazonaws.com` } });
      roleCall(env, admin, roleId, { ...fromAttacker, at: attack + 4 * MIN, source: 's3', name: 'GetBucketLocation', request: { bucketName: REPORTS_BUCKET, Host: `${REPORTS_BUCKET}.s3.${env.region}.amazonaws.com`, location: '' }, resources: [['AWS::S3::Bucket', REPORTS_BUCKET]] });
      roleCall(env, admin, roleId, { ...fromAttacker, at: attack + 7 * MIN, source: 'ec2', name: 'DescribeInstances', request: describe });
      roleCall(env, admin, roleId, { ...fromAdmin, at: now - 4 * HOUR, source: 'ec2', name: 'DescribeInstances', request: describe });
      roleCall(env, admin, roleId, { ...fromAdmin, at: now - 80 * MIN, source: 'ec2', name: 'DescribeInstances', request: describe });

      env.guardDuty = { detectorId: stableChars('guardduty:detector', HEX, 32), createdAt: now - 60 * DAY, status: 'ENABLED', findingPublishingFrequency: 'SIX_HOURS', findings: [], filters: [] };
      const details = (i: Instance) => instanceDetails(env, i);
      env.guardDuty.findings = [
        finding(env, {
          id: FINDING_IDS.portscan,
          type: 'Recon:EC2/Portscan',
          severity: 5,
          title: `EC2 instance ${scanner.instanceId} is performing outbound port scans against remote host ${web1.privateIpAddress}.`,
          description: `EC2 instance ${scanner.instanceId} is performing outbound port scans against remote host ${web1.privateIpAddress}.`,
          resource: { resourceType: 'Instance', instanceDetails: details(scanner) },
          action: { actionType: 'NETWORK_CONNECTION', networkConnectionAction: { blocked: false, connectionDirection: 'OUTBOUND', localIpDetails: { ipAddressV4: scanner.privateIpAddress }, localPortDetails: { port: 41522, portName: 'Unknown' }, protocol: 'TCP', remoteIpDetails: { ipAddressV4: web1.privateIpAddress }, remotePortDetails: { port: 22, portName: 'SSH' } } },
          resourceRole: 'ACTOR',
          count: 8,
          firstSeen: now - 51 * DAY - 3 * HOUR,
          lastSeen: now - 2 * DAY - 3 * HOUR,
        }),
        finding(env, {
          id: FINDING_IDS.portProbe,
          type: 'Recon:EC2/PortProbeUnprotectedPort',
          severity: 2,
          title: `Unprotected port on EC2 instance ${admin.instanceId} is being probed.`,
          description: `EC2 instance has an unprotected port which is being probed by a known malicious host.`,
          resource: { resourceType: 'Instance', instanceDetails: details(admin) },
          action: { actionType: 'PORT_PROBE', portProbeAction: { blocked: false, portProbeDetails: [{ localIpDetails: { ipAddressV4: admin.privateIpAddress }, localPortDetails: { port: 80, portName: 'HTTP' }, remoteIpDetails: ATTACKER }] } },
          resourceRole: 'TARGET',
          count: 3,
          firstSeen: now - 27 * HOUR,
          lastSeen: now - 26 * HOUR,
        }),
        finding(env, {
          id: FINDING_IDS.exfiltration,
          type: 'UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS',
          severity: 8,
          title: `Credentials for instance role ${ADMIN_ROLE} used from external IP address.`,
          description: `Credentials created exclusively for an EC2 instance using instance role ${ADMIN_ROLE} have been used from external IP address ${ATTACKER_IP}.`,
          resource: { resourceType: 'AccessKey', accessKeyDetails: { accessKeyId: STOLEN_KEY, principalId: `${roleId}:${admin.instanceId}`, userName: ADMIN_ROLE, userType: 'AssumedRole' }, instanceDetails: details(admin) },
          action: { actionType: 'AWS_API_CALL', awsApiCallAction: { api: 'DescribeInstances', callerType: 'Remote IP', serviceName: 'ec2.amazonaws.com', userAgent: ATTACKER_UA, remoteIpDetails: ATTACKER, affectedResources: {} } },
          resourceRole: 'TARGET',
          count: 4,
          firstSeen: attack,
          lastSeen: attack + 7 * MIN,
        }),
      ];
    }),
  );
}
