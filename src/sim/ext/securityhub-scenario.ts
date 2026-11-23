// Lesson 44's account: the web app with a few insecure settings, a dev sandbox, and a GuardDuty finding waiting to be
// sent to Security Hub. Security Hub CSPM itself is off: the learner enables it.
import { byName, getDb } from '../env';
import { runInstances } from '../ec2';
import { stableChars, withStableIds } from '../ids';
import { createBucket, putBucketPolicy, putObject } from '../s3';
import { webAppEnv } from '../scenarios';
import { createSecurityGroup, setSecurityGroupRules } from '../sg';
import { advanceTime } from '../time';
import type { AwsEnv } from '../types';
import { emptySecurityHub, type Finding } from './securityhub';

const DAY = 86_400_000;
export const NEWSLETTER_BUCKET = 'webapp-newsletter-123456789012';
export const LOGS_BUCKET = 'webapp-logs-123456789012';
export const OFFICE_CIDR = '203.0.113.45/32';
const OFF = { blockPublicAcls: false, ignorePublicAcls: false, blockPublicPolicy: false, restrictPublicBuckets: false };

export function securityHubEnv(): AwsEnv {
  return webAppEnv({}, (env) =>
    withStableIds('security-hub', () => {
      const t0 = Date.now() - 20 * DAY;
      // web-sg: someone's "temporary" SSH from anywhere
      const web = byName(env.securityGroups, 'web-sg')!;
      setSecurityGroupRules(env, web.groupId, 'ingress', [
        ...web.ingress.map((r) => ({ securityGroupRuleId: r.securityGroupRuleId, ipProtocol: r.ipProtocol, fromPort: r.fromPort, toPort: r.toPort, source: (r.cidrIpv4 ?? r.referencedGroupId)!, description: r.description })),
        { ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: '0.0.0.0/0', description: 'temporary debug' },
      ]);
      // production DB: Multi-AZ (lesson 39), but made "publicly accessible" to connect from a laptop once
      const db = getDb(env, 'webapp-db');
      db.multiAZ = true;
      db.publiclyAccessible = true;
      // Lesson 43's fix: the web servers require IMDSv2
      for (const i of env.instances) i.metadataOptions = { httpTokens: 'required', httpPutResponseHopLimit: 1, httpEndpoint: 'enabled' };
      // the dev team's sandbox in the default VPC (public IP, IMDSv1 allowed)
      const def = env.vpcs.find((v) => v.isDefault)!;
      const devSg = createSecurityGroup(env, {
        groupName: 'dev-sg',
        name: 'dev-sg',
        description: 'Dev sandbox',
        vpcId: def.vpcId,
        ingress: [
          { ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: '0.0.0.0/0', description: 'dev preview' },
          { ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: OFFICE_CIDR, description: 'office' },
        ],
      });
      env.securityGroups.find((g) => g.groupId === devSg)!.tags.push({ key: 'Environment', value: 'dev' });
      const subnet = env.subnets.find((s) => s.vpcId === def.vpcId && s.availabilityZone === 'ap-northeast-1a')!;
      const [devId] = runInstances(env, { name: 'dev-sandbox', imageId: 'ami-0d52744d6551d851e', instanceType: 't3.micro', keyName: 'webapp-key', subnetId: subnet.subnetId, securityGroupIds: [devSg] }, t0);
      env.instances.find((i) => i.instanceId === devId)!.tags.push({ key: 'Environment', value: 'dev' });
      // newsletter images: public on purpose
      createBucket(env, { name: NEWSLETTER_BUCKET, blockPublicAccess: OFF }, t0);
      putBucketPolicy(env, NEWSLETTER_BUCKET, JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'PublicReadForNewsletterImages', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${NEWSLETTER_BUCKET}/*` }] }), `arn:aws:iam::${env.accountId}:root`);
      putObject(env, NEWSLETTER_BUCKET, 'public/newsletter/2026-11/header.png', { size: 48_213, contentType: 'image/png' }, t0);
      env.buckets.find((b) => b.name === NEWSLETTER_BUCKET)!.tags = [{ key: 'Purpose', value: 'newsletter-images' }];
      createBucket(env, { name: LOGS_BUCKET }, t0);
      advanceTime(env, Infinity);
      env.securityHub = { ...emptySecurityHub(), queued: [portProbe(env, devId)] };
    }),
  );
}

/** what GuardDuty (lesson 43) found yesterday: someone probing dev-sandbox's open port 80 */
function portProbe(env: AwsEnv, instanceId: string): Finding {
  const at = Date.now() - DAY;
  const detector = stableChars('detector', '0123456789abcdef', 32);
  const findingId = stableChars('port-probe', '0123456789abcdef', 32);
  const i = env.instances.find((x) => x.instanceId === instanceId)!;
  return {
    id: `arn:aws:guardduty:${env.region}:${env.accountId}:detector/${detector}/finding/${findingId}`,
    productArn: `arn:aws:securityhub:${env.region}::product/aws/guardduty`,
    productName: 'GuardDuty',
    companyName: 'Amazon',
    generatorId: `arn:aws:guardduty:${env.region}:${env.accountId}:detector/${detector}`,
    types: ['TTPs/Discovery/Recon:EC2-PortProbeUnprotectedPort'],
    title: `Unprotected port on EC2 instance ${instanceId} is being probed.`,
    description: `EC2 instance has an unprotected port which is being probed by a known malicious host.`,
    severity: 'LOW',
    providerSeverity: { label: 'LOW', original: '2' },
    resource: { type: 'AwsEc2Instance', id: `arn:aws:ec2:${env.region}:${env.accountId}:instance/${instanceId}`, region: env.region, tags: Object.fromEntries(i.tags.map((t) => [t.key, t.value])) },
    workflow: 'NEW',
    recordState: 'ACTIVE',
    firstObservedAt: at,
    lastObservedAt: at + 3_600_000,
    createdAt: at,
    updatedAt: at + 3_600_000,
  };
}
