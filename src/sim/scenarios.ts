import { CLI_USER_AGENT, iamUserActor, quietly, trail, withActor } from './cloudtrail';
import { createLogGroup, MINUTE, putMetricAlarm } from './cloudwatch';
import { changeRecord, createDistribution, createHostedZone, createIpSet, createValidationRecords, createWebAcl, recordWafSample, requestCertificate, storeInCache } from './edge';
import { putConfigRule } from './config';
import { runInstances, terminateInstances } from './ec2';
import { createAutoScalingGroup, createLaunchTemplate } from './autoscaling';
import { createCluster, createRepository, createService, putImage, registerTaskDefinition } from './containers';
import { advanceBatch, createComputeEnvironment, createJobQueue, nextTriggers, putRule, registerJobDefinition, submitJob } from './batch';
import { advanceServerless, createEventSourceMapping, createFunction, createQueue, sendMessage, updateFunctionConfiguration } from './serverless';
import { getDb } from './env';
import { createLoadBalancer, createTargetGroup, registerTargets } from './elb';
import { byName, emptyEnv, nameOf } from './env';
import { withStableIds } from './ids';
import { createDbInstance, createDbSnapshot, createDbSubnetGroup, writeTables } from './rds';
import { createSecurityGroup, setSecurityGroupRules } from './sg';
import { advanceTime } from './time';
import { createPolicy, createRole, createUser, policyArn, roleArn, setInstanceProfile } from './iam';
import { createAccountAssignment, createPermissionSet, FULL_AWS_ACCESS } from './organizations';
import { CLIENT_IP, EC2_INSTANCE_CONNECT_RANGES } from './network';
import { createBucket, putBucketPolicy, putBucketVersioning, putObject, putPublicAccessBlock } from './s3';
import type { AwsEnv, PolicyStatement } from './types';
import { attachInternetGateway, createInternetGateway, createNatGateway, createRouteTable, createSubnet, createVpc, mainRouteTable, modifySubnetAttribute, replaceRoutes, setSubnetAssociations } from './vpc';

const DAY = 86_400_000;

/** webapp-db's tables (row counts) */
export const ORDERS = 1_284_112;
const ORDERS_BEFORE = { orders: ORDERS, customers: 52_011, products: 1_320 };

/** Every real account has a default VPC per region (172.31.0.0/16, one public /20 per AZ). */
export function addDefaultVpc(env: AwsEnv) {
  const vpcId = createVpc(env, { cidrBlock: '172.31.0.0/16' });
  const vpc = env.vpcs.find((v) => v.vpcId === vpcId)!;
  vpc.isDefault = true;
  vpc.enableDnsHostnames = true;
  ['a', 'c', 'd'].forEach((az, n) => {
    const id = createSubnet(env, { vpcId, cidrBlock: `172.31.${n * 16}.0/20`, availabilityZone: `${env.region}${az}` });
    modifySubnetAttribute(env, id, { mapPublicIpOnLaunch: true });
  });
  const igw = createInternetGateway(env, {});
  attachInternetGateway(env, igw, vpcId);
  replaceRoutes(env, mainRouteTable(env, vpcId).routeTableId, [{ destinationCidrBlock: '0.0.0.0/0', gatewayId: igw }]);
}

export interface WebAppOptions {
  /** stop after this layer (default: everything) */
  upTo?: 'vpc' | 'subnets' | 'network' | 'security-groups' | 'instances' | 'target-group' | 'load-balancer' | 'database';
  /** skip creating/attaching the internet gateway + public route */
  noInternetGateway?: boolean;
  /** register web-1/web-2 in web-tg (default true) */
  registerTargets?: boolean;
  /** the app on web-1/web-2 queries webapp-db on "/" (default: only when the database layer is built) */
  appUsesDb?: boolean;
  /** web-tg's target type (ip = for ECS on Fargate; nothing is registered) */
  targetType?: 'instance' | 'ip';
}

const LAYERS = ['vpc', 'subnets', 'network', 'security-groups', 'instances', 'target-group', 'load-balancer', 'database'] as const;

/**
 * The MVP reference architecture, built with the same operations the console uses:
 *   Internet -> web-alb (public-subnet-1a/1c) -> web-1/web-2 :3000 (private-subnet-1a/1c) -> webapp-db MySQL (private)
 * Lessons take a prefix of it (upTo) and then break / remove something in `tweak`.
 */
export function webAppEnv(o: WebAppOptions = {}, tweak?: (env: AwsEnv) => void): AwsEnv {
  const upTo = LAYERS.indexOf(o.upTo ?? 'database');
  const has = (layer: (typeof LAYERS)[number]) => LAYERS.indexOf(layer) <= upTo;
  return withStableIds(`webapp:${JSON.stringify(o)}`, () => {
    const t0 = Date.now() - 3 * DAY;
    const env = emptyEnv('ap-northeast-1');
    env.keyPairs.push('webapp-key');
    addDefaultVpc(env);
    const vpcId = createVpc(env, { cidrBlock: '10.0.0.0/16', name: 'webapp-vpc' });
    env.vpcs.find((v) => v.vpcId === vpcId)!.enableDnsHostnames = true;
    if (has('subnets')) {
      const sub = (name: string, cidr: string, az: string) => createSubnet(env, { vpcId, cidrBlock: cidr, availabilityZone: `ap-northeast-1${az}`, name });
      const pub = [sub('public-subnet-1a', '10.0.1.0/24', 'a'), sub('public-subnet-1c', '10.0.2.0/24', 'c')];
      sub('private-subnet-1a', '10.0.11.0/24', 'a');
      sub('private-subnet-1c', '10.0.12.0/24', 'c');
      if (has('network')) {
        for (const id of pub) modifySubnetAttribute(env, id, { mapPublicIpOnLaunch: true });
        const rt = createRouteTable(env, { vpcId, name: 'public-rt' });
        setSubnetAssociations(env, rt, pub);
        if (!o.noInternetGateway) {
          const igw = createInternetGateway(env, { name: 'webapp-igw' });
          attachInternetGateway(env, igw, vpcId);
          replaceRoutes(env, rt, [{ destinationCidrBlock: '0.0.0.0/0', gatewayId: igw }]);
        }
        mainRouteTable(env, vpcId).tags = [{ key: 'Name', value: 'private-rt' }];
      }
    }
    if (has('security-groups')) {
      const alb = createSecurityGroup(env, { groupName: 'alb-sg', name: 'alb-sg', description: 'Allow HTTP from the internet to the ALB', vpcId, ingress: [{ ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: '0.0.0.0/0', description: 'HTTP from internet' }] });
      const web = createSecurityGroup(env, { groupName: 'web-sg', name: 'web-sg', description: 'Allow app traffic from the ALB', vpcId, ingress: [{ ipProtocol: 'tcp', fromPort: 3000, toPort: 3000, source: alb, description: 'App port from ALB' }] });
      createSecurityGroup(env, { groupName: 'db-sg', name: 'db-sg', description: 'Allow MySQL from web servers', vpcId, ingress: [{ ipProtocol: 'tcp', fromPort: 3306, toPort: 3306, source: web, description: 'MySQL from web' }] });
    }
    const usesDb = o.appUsesDb ?? has('database');
    if (has('instances')) {
      const web = byName(env.securityGroups, 'web-sg')!.groupId;
      for (const [name, subnet] of [['web-1', 'private-subnet-1a'], ['web-2', 'private-subnet-1c']]) {
        runInstances(
          env,
          { name, imageId: 'ami-0d52744d6551d851e', instanceType: 't3.micro', keyName: 'webapp-key', subnetId: byName(env.subnets, subnet)!.subnetId, securityGroupIds: [web], app: { port: 3000, healthCheckPath: '/health', ...(usesDb ? { dbInstanceIdentifier: 'webapp-db' } : {}) } },
          t0,
        );
      }
      createLogGroup(env, '/webapp/app', { kind: 'app' }, t0);
    }
    if (has('target-group')) {
      const tg = createTargetGroup(env, { name: 'web-tg', port: 3000, vpcId, healthCheck: { path: '/health' }, targetType: o.targetType });
      if ((o.registerTargets ?? true) && o.targetType !== 'ip') registerTargets(env, tg, env.instances.filter((i) => i.vpcId === vpcId).map((i) => ({ id: i.instanceId, port: 3000 })));
    }
    if (has('load-balancer')) {
      createLoadBalancer(
        env,
        {
          name: 'web-alb',
          scheme: 'internet-facing',
          vpcId,
          subnetIds: ['public-subnet-1a', 'public-subnet-1c'].map((n) => byName(env.subnets, n)!.subnetId),
          securityGroupIds: [byName(env.securityGroups, 'alb-sg')!.groupId],
          listeners: [{ port: 80, targetGroupArn: env.targetGroups[0].targetGroupArn }],
        },
        t0,
      );
    }
    if (has('database')) {
      createDbSubnetGroup(env, { name: 'webapp-db-subnet-group', description: 'Private subnets for webapp-db', vpcId, subnetIds: ['private-subnet-1a', 'private-subnet-1c'].map((n) => byName(env.subnets, n)!.subnetId) });
      createDbInstance(
        env,
        {
          identifier: 'webapp-db',
          engine: 'mysql',
          dbInstanceClass: 'db.t3.micro',
          masterUsername: 'admin',
          masterPassword: 'simulator-only',
          dbName: 'webapp',
          allocatedStorage: 20,
          dbSubnetGroupName: 'webapp-db-subnet-group',
          vpcSecurityGroupIds: [byName(env.securityGroups, 'db-sg')!.groupId],
          publiclyAccessible: false,
          multiAZ: false,
          availabilityZone: 'ap-northeast-1a',
          backupRetentionPeriod: 7,
        },
        t0,
      );
      writeTables(env.dbInstances.find((d) => d.dbInstanceIdentifier === 'webapp-db')!, ORDERS_BEFORE, t0);
      // slow query log exported to CloudWatch Logs (slow_query_log = 1, long_query_time = 2)
      createLogGroup(env, '/aws/rds/instance/webapp-db/slowquery', { kind: 'rds-slowquery', dbInstanceIdentifier: 'webapp-db' }, t0);
    }
    advanceTime(env, Infinity);
    tweak?.(env);
    advanceTime(env, Infinity);
    return env;
  });
}

/** The MVP architecture, healthy until 40 minutes ago, when a query without an index started scanning `orders`. */
export function slowAppEnv(): AwsEnv {
  return webAppEnv({}, (env) => env.incidents.push({ kind: 'db-slow-query', target: 'webapp-db', startedAt: Date.now() - 40 * MINUTE }));
}

/** A fresh account: only the default VPC (what you get on day one). */
export function accountEnv(): AwsEnv {
  return withStableIds('account', () => {
    const env = emptyEnv('ap-northeast-1');
    env.keyPairs.push('webapp-key');
    addDefaultVpc(env);
    return env;
  });
}

export interface S3IamOptions {
  /** policy statements for batch-role's customer managed policy `batch-s3-read` */
  batchPolicy?: PolicyStatement[];
  /** bucket policy of the reports bucket */
  bucketPolicy?: PolicyStatement[];
  /** trust policy principal service for batch-role (default ec2.amazonaws.com) */
  trustService?: string;
  /** attach the batch-role instance profile to batch-1 (default true) */
  attachProfile?: boolean;
}

export const REPORTS_BUCKET = 'webapp-reports-123456789012';

/**
 * S3 / IAM lessons: batch-1 (public subnet, public IP) runs a nightly job that downloads CSV reports
 * from the reports bucket with the batch-role instance profile. The console user is IAM user "learner".
 */
export function s3IamEnv(o: S3IamOptions = {}, tweak?: (env: AwsEnv) => void): AwsEnv {
  return withStableIds(`s3iam:${JSON.stringify(o)}`, () => {
    const env = webAppEnv({ upTo: 'network' });
    const t0 = Date.now() - 10 * DAY;
    const vpcId = byName(env.vpcs, 'webapp-vpc')!.vpcId;
    createUser(env, { userName: 'learner', policyArns: ['arn:aws:iam::aws:policy/AdministratorAccess'], consoleAccess: true }, t0);
    const policy = createPolicy(env, { policyName: 'batch-s3-read', description: 'Read nightly reports', document: { Version: '2012-10-17', Statement: o.batchPolicy ?? [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: [`arn:aws:s3:::${REPORTS_BUCKET}`, `arn:aws:s3:::${REPORTS_BUCKET}/*`] }] } }, t0);
    createRole(env, { roleName: 'batch-role', description: 'Allows EC2 instances to read reports', trustPolicy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: o.trustService ?? 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] }, policyArns: [policy], withInstanceProfile: true }, t0);
    createBucket(env, { name: REPORTS_BUCKET }, t0);
    for (const day of ['2026-09-27', '2026-09-28'])
      putObject(env, REPORTS_BUCKET, `reports/2026/09/report-${day}.csv`, { size: 2048, contentType: 'text/csv', body: `date,orders,revenue\n${day},1284,3920500\n` }, t0);
    if (o.bucketPolicy) env.buckets[0].policy = { Version: '2012-10-17', Statement: o.bucketPolicy };
    const sg = createSecurityGroup(env, {
      groupName: 'batch-sg',
      name: 'batch-sg',
      description: 'Batch server (SSH via EC2 Instance Connect)',
      vpcId,
      ingress: [
        { ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: EC2_INSTANCE_CONNECT_RANGES['ap-northeast-1'], description: 'EC2 Instance Connect' },
        { ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: `${CLIENT_IP}/32`, description: 'SSH from office' },
      ],
    });
    const [id] = runInstances(env, { name: 'batch-1', imageId: 'ami-0d52744d6551d851e', instanceType: 't3.micro', keyName: 'webapp-key', subnetId: byName(env.subnets, 'public-subnet-1a')!.subnetId, securityGroupIds: [sg] }, t0);
    if (o.attachProfile ?? true) setInstanceProfile(env, id, env.instanceProfiles[0].arn);
    advanceTime(env, Infinity);
    tweak?.(env);
    advanceTime(env, Infinity);
    return env;
  });
}

export const PUBLIC_SITE_BUCKET = 'webapp-public-site-123456789012';

/** s3IamEnv + a bucket meant to host a public static page (still private, as every new bucket is). */
export function publicSiteEnv(): AwsEnv {
  return s3IamEnv({}, (env) =>
    withStableIds('public-site', () => {
      createBucket(env, { name: PUBLIC_SITE_BUCKET }, Date.now() - DAY);
      putObject(env, PUBLIC_SITE_BUCKET, 'index.html', { size: 312, contentType: 'text/html', body: '<!doctype html>\n<html><body><h1>Welcome to webapp!</h1><p>このページは S3 から配信されています。</p></body></html>' });
      putObject(env, PUBLIC_SITE_BUCKET, 'logo.png', { size: 18432, contentType: 'image/png' });
    }),
  );
}

/** a time yesterday in JST (lesson dialogue says "昨日の夕方") */
export function yesterdayJst(hour: number, minute: number, now = Date.now()): number {
  const JST = 9 * 3_600_000;
  const todayStart = Math.floor((now + JST) / DAY) * DAY - JST;
  return todayStart - DAY + (hour * 60 + minute) * MINUTE;
}

const consoleLogin = (env: AwsEnv) => trail(env, { source: 'signin', name: 'ConsoleLogin', request: null, response: { ConsoleLogin: 'Success' } });
const OFFICE_IP = '203.0.113.45';

function addTeam(env: AwsEnv) {
  quietly(() => {
    createUser(env, { userName: 'tanaka', policyArns: ['arn:aws:iam::aws:policy/AdministratorAccess'], consoleAccess: true });
    createUser(env, { userName: 'suzuki', policyArns: ['arn:aws:iam::aws:policy/PowerUserAccess'], consoleAccess: true });
  });
}

/**
 * Lesson 26: batch-1 worked with EC2 Instance Connect until yesterday 18:42, when tanaka's cleanup script
 * (AWS CLI from the office) revoked the "EC2 Instance Connect" SSH rule of batch-sg. Other people's normal work is in the history too.
 */
export function sshRevokedEnv(): AwsEnv {
  return s3IamEnv({}, (env) => {
    addTeam(env);
    const sg = byName(env.securityGroups, 'batch-sg')!;
    const batch = byName(env.instances, 'batch-1')!;
    const suzuki = iamUserActor(env, 'suzuki', '203.0.113.77');
    const tanaka = iamUserActor(env, 'tanaka', OFFICE_IP);
    withActor(suzuki, yesterdayJst(9, 12), () => consoleLogin(env));
    withActor(suzuki, yesterdayJst(9, 20), () =>
      putMetricAlarm(env, { alarmName: 'batch-1-cpu-high', namespace: 'AWS/EC2', metricName: 'CPUUtilization', dimensions: [{ name: 'InstanceId', value: batch.instanceId }], statistic: 'Average', period: 300, evaluationPeriods: 1, datapointsToAlarm: 1, threshold: 80, comparisonOperator: 'GreaterThanThreshold' }, yesterdayJst(9, 20)),
    );
    withActor(tanaka, yesterdayJst(18, 30), () => consoleLogin(env));
    withActor(tanaka, yesterdayJst(18, 36), () => putBucketVersioning(env, REPORTS_BUCKET, 'Enabled'));
    withActor({ ...tanaka, userAgent: `${CLI_USER_AGENT}ec2.revoke-security-group-ingress` }, yesterdayJst(18, 42), () =>
      setSecurityGroupRules(env, sg.groupId, 'ingress', sg.ingress.filter((r) => r.description !== 'EC2 Instance Connect').map((r) => ({ securityGroupRuleId: r.securityGroupRuleId, ipProtocol: r.ipProtocol, fromPort: r.fromPort, toPort: r.toPort, source: r.cidrIpv4!, description: r.description }))),
    );
    withActor(iamUserActor(env, 'learner', CLIENT_IP), Date.now() - 10 * MINUTE, () => consoleLogin(env));
  });
}

export const SHARE_BUCKET = 'webapp-share-123456789012';

/**
 * Lesson 27: the web app with AWS Config rules, two of them NON_COMPLIANT because of yesterday's changes:
 * tanaka opened SSH on web-sg to the world "for debugging", suzuki made a bucket public to share files.
 */
export function auditEnv(): AwsEnv {
  return webAppEnv({}, (env) => {
    addTeam(env);
    const month = Date.now() - 30 * DAY;
    quietly(() => ['INCOMING_SSH_DISABLED', 'S3_BUCKET_PUBLIC_READ_PROHIBITED', 'RDS_INSTANCE_PUBLIC_ACCESS_CHECK'].forEach((identifier, n) => putConfigRule(env, { configRuleName: ['restricted-ssh', 's3-bucket-public-read-prohibited', 'rds-instance-public-access-check'][n], identifier }, month)));
    const suzuki = iamUserActor(env, 'suzuki', '203.0.113.77');
    const tanaka = iamUserActor(env, 'tanaka', OFFICE_IP);
    withActor(suzuki, yesterdayJst(11, 3), () => {
      createBucket(env, { name: SHARE_BUCKET }, yesterdayJst(11, 3));
      putObject(env, SHARE_BUCKET, 'price-list-2026.csv', { size: 2048, contentType: 'text/csv', body: 'item,price\nwidget,1200\n' }, yesterdayJst(11, 4));
    });
    withActor(suzuki, yesterdayJst(11, 8), () => {
      putPublicAccessBlock(env, SHARE_BUCKET, { blockPublicAcls: false, ignorePublicAcls: false, blockPublicPolicy: false, restrictPublicBuckets: false });
      putBucketPolicy(env, SHARE_BUCKET, JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'ShareWithPartner', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${SHARE_BUCKET}/*` }] }), suzuki.arn);
    });
    const web = byName(env.securityGroups, 'web-sg')!;
    withActor(tanaka, yesterdayJst(16, 5), () =>
      setSecurityGroupRules(env, web.groupId, 'ingress', [
        ...web.ingress.map((r) => ({ securityGroupRuleId: r.securityGroupRuleId, ipProtocol: r.ipProtocol, fromPort: r.fromPort, toPort: r.toPort, source: (r.cidrIpv4 ?? r.referencedGroupId)!, description: r.description })),
        { ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: '0.0.0.0/0', description: 'temporary debug' },
      ]),
    );
  });
}

const MIGRATE_SH = `#!/bin/bash
# Remove archived orders (older than 3 years) before the schema migration
set -e
echo "[1/2] Deleting archived orders..."
mysql webapp -e "DELETE FROM orders; -- WHERE created_at < NOW() - INTERVAL 3 YEAR"
echo "[2/2] Done."
`;

/** the web app plus batch-1, an ops server in the public subnet that can reach webapp-db (mysql client configured in ~/.my.cnf) */
function withOpsServer(env: AwsEnv, homeFiles: Record<string, string> = {}) {
  const vpcId = byName(env.vpcs, 'webapp-vpc')!.vpcId;
  const sg = createSecurityGroup(env, { groupName: 'batch-sg', name: 'batch-sg', description: 'Ops server (EC2 Instance Connect)', vpcId, ingress: [{ ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: EC2_INSTANCE_CONNECT_RANGES['ap-northeast-1'], description: 'EC2 Instance Connect' }] });
  const dbSg = byName(env.securityGroups, 'db-sg')!;
  setSecurityGroupRules(env, dbSg.groupId, 'ingress', [...dbSg.ingress.map((r) => ({ securityGroupRuleId: r.securityGroupRuleId, ipProtocol: r.ipProtocol, fromPort: r.fromPort, toPort: r.toPort, source: (r.cidrIpv4 ?? r.referencedGroupId)!, description: r.description })), { ipProtocol: 'tcp', fromPort: 3306, toPort: 3306, source: sg, description: 'MySQL from ops server' }]);
  const [id] = runInstances(env, { name: 'batch-1', imageId: 'ami-0d52744d6551d851e', instanceType: 't3.micro', keyName: 'webapp-key', subnetId: byName(env.subnets, 'public-subnet-1a')!.subnetId, securityGroupIds: [sg] }, Date.now() - 3 * DAY);
  const db = getDb(env, 'webapp-db');
  env.instances.find((i) => i.instanceId === id)!.homeFiles = { '.my.cnf': `[client]\nhost=${db.endpointAddress}\nuser=admin\npassword=simulator-only\ndatabase=webapp\n`, ...homeFiles };
}

/** Lesson 28: tonight's migration script has a bug (the ";" before the WHERE comment) */
export function backupEnv(): AwsEnv {
  return webAppEnv({}, (env) => withOpsServer(env, { 'migrate.sh': MIGRATE_SH }));
}

/** latest daily backup window (17:00 UTC = 02:00 JST) at or before t */
const backupBefore = (t: number) => {
  const b = Math.floor(t / DAY) * DAY + 17 * 3_600_000;
  return b <= t ? b : b - DAY;
};

/**
 * Lesson 29: 20 minutes ago a cleanup job ran DELETE FROM orders without WHERE; the shop kept taking
 * (a few) new orders since. The last automated snapshot is from the backup window before that.
 */
export function accidentEnv(now = Date.now()): { env: AwsEnv; accidentAt: number } {
  const accidentAt = Math.floor((now - 20 * MINUTE) / 1000) * 1000 + 12_000;
  const backup = backupBefore(accidentAt - 10 * MINUTE);
  const env = webAppEnv({}, (e) => {
    const db = getDb(e, 'webapp-db');
    writeTables(db, { ...ORDERS_BEFORE, orders: ORDERS - 21_430 }, backup - 2 * DAY);
    writeTables(db, { ...ORDERS_BEFORE, orders: ORDERS - 4_112 }, backup - 3_600_000);
    writeTables(db, ORDERS_BEFORE, accidentAt - 3 * MINUTE);
    writeTables(db, { ...ORDERS_BEFORE, orders: 0 }, accidentAt);
    writeTables(db, { ...ORDERS_BEFORE, orders: 58 }, now - MINUTE);
    const jst = (t: number) => new Date(t + 9 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19) + ' +0900';
    withOpsServer(e, {
      'cleanup.log': [`${jst(accidentAt - 2_000)} cleanup: start (target: orders older than 3 years)`, `${jst(accidentAt)} cleanup: DELETE FROM orders  -> ${ORDERS} rows affected`, `${jst(accidentAt + 1_000)} cleanup: done`].join('\n') + '\n',
    });
  });
  return { env, accidentAt };
}

export const WEBAPP_USER_DATA = `#!/bin/bash
dnf install -y webapp
systemctl enable --now webapp   # webapp --port 3000 (GET /health)`;

/**
 * Lessons 30-31: the web app behind web-alb, but web-1 / web-2 were retired yesterday: web-tg is empty
 * (the ALB answers 503) and the launch template webapp-lt is ready for an Auto Scaling group.
 */
export function asgEnv(): AwsEnv {
  return webAppEnv({ upTo: 'load-balancer' }, (env) => {
    const yesterday = Date.now() - DAY;
    quietly(() => terminateInstances(env, env.instances.filter((i) => ['web-1', 'web-2'].includes(nameOf(i))).map((i) => i.instanceId), yesterday));
    quietly(() =>
      createLaunchTemplate(env, { name: 'webapp-lt', description: 'webapp v1 (port 3000)', imageId: 'ami-0d52744d6551d851e', instanceType: 't3.micro', keyName: 'webapp-key', securityGroupIds: [byName(env.securityGroups, 'web-sg')!.groupId], userData: WEBAPP_USER_DATA, detailedMonitoring: true }, yesterday),
    );
  });
}

/** Lesson 31: webapp-asg (min 2 / desired 2 / max 6) has been serving for an hour. */
export function scaledEnv(): AwsEnv {
  const env = asgEnv();
  const t0 = Date.now() - 3_600_000;
  withStableIds('scaled', () => {
    createAutoScalingGroup(env, { name: 'webapp-asg', launchTemplateId: env.launchTemplates[0].launchTemplateId, minSize: 2, maxSize: 6, desiredCapacity: 2, subnetIds: ['private-subnet-1a', 'private-subnet-1c'].map((n) => byName(env.subnets, n)!.subnetId), targetGroupArns: [env.targetGroups[0].targetGroupArn], healthCheckType: 'ELB', healthCheckGracePeriod: 300 }, t0);
    for (let t = t0; t <= t0 + 5000; t += 1000) advanceTime(env, t);
  });
  return env;
}

/**
 * Lesson 32: the web app on ECS (Fargate): webapp-svc runs 2 tasks of webapp:1 (image webapp:v1) behind
 * web-alb. The new version was pushed to ECR as "v2.0" (the team calls it "v2").
 */
export function ecsEnv(): AwsEnv {
  return webAppEnv({ upTo: 'load-balancer', targetType: 'ip' }, (env) => {
    const t0 = Date.now() - 3_600_000;
    quietly(() => {
      terminateInstances(env, env.instances.filter((i) => ['web-1', 'web-2'].includes(nameOf(i))).map((i) => i.instanceId), t0 - DAY);
      const uri = createRepository(env, 'webapp', t0 - 7 * DAY);
      putImage(env, 'webapp', 'v1', { port: 3000, healthCheckPath: '/health', version: 'v1' }, t0 - 7 * DAY);
      putImage(env, 'webapp', 'v2.0', { port: 3000, healthCheckPath: '/health', version: 'v2.0' }, Date.now() - 2 * 3_600_000);
      createRole(env, { roleName: 'ecsTaskExecutionRole', description: 'Allows ECS tasks to pull images from ECR and write logs', trustPolicy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }] } }, t0 - 7 * DAY);
      createCluster(env, 'webapp-cluster', t0);
      const td = registerTaskDefinition(env, { family: 'webapp', cpu: '256', memory: '512', executionRoleArn: `arn:aws:iam::${env.accountId}:role/ecsTaskExecutionRole`, containerDefinitions: [{ name: 'web', image: `${uri}:v1`, essential: true, portMappings: [{ containerPort: 3000, protocol: 'tcp' }], environment: [{ name: 'NODE_ENV', value: 'production' }] }] }, t0);
      createService(env, { cluster: 'webapp-cluster', serviceName: 'webapp-svc', taskDefinition: td, desiredCount: 2, subnets: ['private-subnet-1a', 'private-subnet-1c'].map((n) => byName(env.subnets, n)!.subnetId), securityGroups: [byName(env.securityGroups, 'web-sg')!.groupId], assignPublicIp: 'DISABLED', loadBalancers: [{ targetGroupArn: env.targetGroups[0].targetGroupArn, containerName: 'web', containerPort: 3000 }] }, t0);
      for (let t = t0; t <= t0 + 10_000; t += 1000) advanceTime(env, t);
    });
  });
}

export const ORDERS_BUCKET = 'webapp-orders-123456789012';

export const PROCESS_ORDER_CODE = `import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});

export const handler = async (event) => {
  const bucket = process.env.BUCKET;
  if (!bucket) throw new Error('BUCKET is not set');
  for (const record of event.Records) {
    const order = JSON.parse(record.body);
    const key = \`orders/\${order.orderId}.json\`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: record.body }));
    console.log(\`order \${order.orderId} saved to s3://\${bucket}/\${key}\`);
  }
  return { statusCode: 200, processed: event.Records.length };
};`;

/**
 * Lesson 33: orders-queue -> Lambda process-order -> S3. Five hours ago a deploy dropped the BUCKET
 * environment variable: three orders failed three times each and are now in orders-dlq.
 */
export function asyncEnv(): AwsEnv {
  const env = accountEnv();
  const now = Date.now();
  const month = now - 30 * DAY;
  const deploy = now - 5 * 3_600_000;
  withStableIds('async', () =>
    quietly(() => {
      createBucket(env, { name: ORDERS_BUCKET }, month);
      createPolicy(env, { policyName: 'process-order-s3', description: 'process-order: write orders to S3', document: { Version: '2012-10-17', Statement: [{ Sid: 'PutOrders', Effect: 'Allow', Action: 's3:PutObject', Resource: `arn:aws:s3:::${ORDERS_BUCKET}/orders/*` }] } }, month);
      createRole(env, { roleName: 'process-order-role', description: 'Execution role of the process-order function', trustPolicy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] }, policyArns: ['arn:aws:iam::aws:policy/AWSLambdaBasicExecutionRole', policyArn(env, 'process-order-s3')] }, month);
      createQueue(env, { name: 'orders-dlq', messageRetentionPeriod: 1_209_600 }, month);
      createQueue(env, { name: 'orders-queue', visibilityTimeout: 10, deadLetterQueue: { name: 'orders-dlq', maxReceiveCount: 3 } }, month);
      createFunction(env, { functionName: 'process-order', runtime: 'nodejs20.x', handler: 'index.handler', roleArn: roleArn(env, 'process-order-role'), timeout: 10, memorySize: 128, environment: { BUCKET: ORDERS_BUCKET }, code: PROCESS_ORDER_CODE, behavior: 'order-processor' }, month);
      createEventSourceMapping(env, { functionName: 'process-order', eventSourceArn: `arn:aws:sqs:${env.region}:${env.accountId}:orders-queue`, batchSize: 10 }, month);
      // yesterday's orders went through
      const yesterday = now - DAY;
      [998, 999].forEach((id, n) => sendMessage(env, 'orders-queue', JSON.stringify({ orderId: id, customerId: 4000 + n, amount: 1200 + n * 300 }), yesterday + n * 60_000));
      for (let t = yesterday; t <= yesterday + 2 * 60_000; t += 1000) advanceServerless(env, t);
      // the bad deploy
      updateFunctionConfiguration(env, 'process-order', { environment: {} }, deploy);
      [1001, 1002, 1003].forEach((id, n) => sendMessage(env, 'orders-queue', JSON.stringify({ orderId: id, customerId: 4100 + n, amount: 2500 + n * 100 }), deploy + 60_000 + n * 60_000));
      for (let t = deploy; t <= deploy + 6 * 60_000; t += 1000) advanceServerless(env, t);
    }),
  );
  return env;
}

/**
 * Lesson 34: every night at 02:00 JST (cron in UTC) the rule daily-report-schedule submits a daily-report
 * job to AWS Batch. It failed the last two nights: the job role may read orders but not write the report.
 */
export function reportEnv(): AwsEnv {
  const env = accountEnv();
  const now = Date.now();
  const month = now - 30 * DAY;
  withStableIds('report', () => {
    quietly(() => {
      createBucket(env, { name: REPORTS_BUCKET }, month);
      createBucket(env, { name: ORDERS_BUCKET }, month);
      createPolicy(env, { policyName: 'report-job-s3', description: 'daily-report job: read orders', document: { Version: '2012-10-17', Statement: [{ Sid: 'ReadOrders', Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: [`arn:aws:s3:::${ORDERS_BUCKET}`, `arn:aws:s3:::${ORDERS_BUCKET}/*`] }] } }, month);
      createRole(env, { roleName: 'report-job-role', description: 'Job role of the daily-report Batch job', trustPolicy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }] }, policyArns: [policyArn(env, 'report-job-s3')] }, month);
      createRole(env, { roleName: 'ecsTaskExecutionRole', description: 'Allows ECS tasks to pull images from ECR and write logs', trustPolicy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }] } }, month);
      const uri = createRepository(env, 'daily-report', month);
      putImage(env, 'daily-report', 'v3', { port: 0, healthCheckPath: '', version: 'v3' }, month);
      const vpc = env.vpcs.find((v) => v.isDefault)!;
      const ce = createComputeEnvironment(env, { name: 'fargate-ce', maxvCpus: 16, subnets: env.subnets.filter((x) => x.vpcId === vpc.vpcId).map((x) => x.subnetId), securityGroupIds: env.securityGroups.filter((g) => g.vpcId === vpc.vpcId && g.groupName === 'default').map((g) => g.groupId) });
      createJobQueue(env, { name: 'report-queue', priority: 1, computeEnvironment: ce });
      registerJobDefinition(env, { jobDefinitionName: 'daily-report', image: `${uri}:v3`, vcpus: '0.25', memory: '512', command: ['python', 'report.py', `--bucket=${REPORTS_BUCKET}`], jobRoleArn: roleArn(env, 'report-job-role'), executionRoleArn: roleArn(env, 'ecsTaskExecutionRole'), behavior: 'daily-report' });
      putRule(env, { name: 'daily-report-schedule', description: '毎日 02:00 (JST) に日次レポートを作成', scheduleExpression: 'cron(0 17 * * ? *)', target: { jobQueue: 'report-queue', jobDefinition: 'daily-report:1', jobName: 'daily-report' } }, month);
    });
    // the last two nights: EventBridge submitted the job, it failed
    const rule = env.eventRules[0];
    const nights = nextTriggers(rule, now - 3 * DAY, 3).filter((t) => t <= now).slice(-2);
    for (const t of nights) {
      withActor({ userName: 'Amazon_EventBridge_Invoke_Batch', type: 'AssumedRole', arn: `arn:aws:sts::${env.accountId}:assumed-role/Amazon_EventBridge_Invoke_Batch_Job_Queue/events`, sourceIPAddress: 'events.amazonaws.com', userAgent: 'events.amazonaws.com' }, t, () => submitJob(env, { jobName: 'daily-report', jobQueue: 'report-queue', jobDefinition: 'daily-report:1' }, 'EventBridge (daily-report-schedule)', t));
      for (let x = t; x <= t + 12_000; x += 1000) advanceBatch(env, x);
    }
    rule.evaluatedUntil = now;
  });
  return env;
}

export const SHOP_DOMAIN = 'webapp-shop.example';

/** Lesson 35: www.webapp-shop.example points at web-alb; the apex has no record. */
export function dnsEnv(): AwsEnv {
  return webAppEnv({}, (env) =>
    quietly(() => {
      const zone = createHostedZone(env, SHOP_DOMAIN, 'webapp shop', Date.now() - 30 * DAY);
      changeRecord(env, zone, 'CREATE', { name: `www.${SHOP_DOMAIN}`, type: 'CNAME', ttl: 300, values: [env.loadBalancers[0].dnsName] });
    }),
  );
}

/** an issued certificate (validated long ago) */
function issuedCertificate(env: AwsEnv, names: string[], at: number) {
  const arn = requestCertificate(env, { domainName: names[0], subjectAlternativeNames: names, region: 'us-east-1' }, at);
  createValidationRecords(env, arn);
  Object.assign(env.certificates.find((c) => c.certificateArn === arn)!, { status: 'ISSUED', issuedAt: at + 60_000 });
  return arn;
}

const deployed = (env: AwsEnv, id: string) => Object.assign(env.distributions.find((d) => d.id === id)!, { status: 'Deployed' });

/**
 * Lesson 36: the shop is served by CloudFront (origin web-alb) as https://webapp-shop.example.
 * Someone pointed www at the distribution in Route 53, but the certificate and the alternate domain names only have the apex.
 */
export function httpsEnv(): AwsEnv {
  return webAppEnv({}, (env) =>
    quietly(() => {
      const month = Date.now() - 30 * DAY;
      const zone = createHostedZone(env, SHOP_DOMAIN, 'webapp shop', month);
      const cert = issuedCertificate(env, [SHOP_DOMAIN], month);
      const id = createDistribution(env, { comment: 'webapp shop', origin: { kind: 'alb', loadBalancerName: 'web-alb' }, aliases: [SHOP_DOMAIN], certificateArn: cert, viewerProtocolPolicy: 'redirect-to-https', defaultTtl: 0 }, month);
      const d = deployed(env, id);
      changeRecord(env, zone, 'CREATE', { name: SHOP_DOMAIN, type: 'A', values: [], aliasTarget: d.domainName });
      changeRecord(env, zone, 'CREATE', { name: `www.${SHOP_DOMAIN}`, type: 'A', values: [], aliasTarget: d.domainName });
    }),
  );
}

export const STATIC_BUCKET = 'webapp-static-123456789012';
const PAGE = (title: string) => `<!doctype html>\n<html lang="ja"><head><title>webapp shop</title></head>\n<body><h1>${title}</h1></body></html>\n`;

/** Lesson 37: the campaign page was updated in S3 10 minutes ago, but CloudFront (TTL 1 day) still has the old one. */
export function cacheEnv(): AwsEnv {
  const env = accountEnv();
  const now = Date.now();
  withStableIds('cache', () =>
    quietly(() => {
      createBucket(env, { name: STATIC_BUCKET }, now - 30 * DAY);
      putObject(env, STATIC_BUCKET, 'index.html', { size: 120, contentType: 'text/html', body: PAGE('夏のセール開催中！') }, now - 20 * DAY);
      const id = createDistribution(env, { comment: 'webapp static site', origin: { kind: 's3', bucket: STATIC_BUCKET }, aliases: [], viewerProtocolPolicy: 'redirect-to-https', defaultTtl: 86_400 }, now - 30 * DAY);
      const d = deployed(env, id);
      putBucketPolicy(env, STATIC_BUCKET, JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'AllowCloudFrontServicePrincipal', Effect: 'Allow', Principal: { Service: 'cloudfront.amazonaws.com' }, Action: 's3:GetObject', Resource: `arn:aws:s3:::${STATIC_BUCKET}/*`, Condition: { StringEquals: { 'AWS:SourceArn': d.arn } } }] }), 'arn:aws:iam::123456789012:user/learner');
      storeInCache(env, id, { path: '/index.html', status: 200, body: PAGE('夏のセール開催中！'), cachedAt: now - 3_600_000 });
      putObject(env, STATIC_BUCKET, 'index.html', { size: 124, contentType: 'text/html', body: PAGE('秋のキャンペーン開催中！') }, now - 10 * MINUTE);
    }),
  );
  return env;
}

/**
 * Lesson 38: after yesterday's attack from 198.51.100.77 someone blocked "198.51.100.0/24" in WAF,
 * which also contains the office (198.51.100.24).
 */
export function wafEnv(): AwsEnv {
  return webAppEnv({}, (env) =>
    quietly(() => {
      const yesterday = Date.now() - DAY;
      const ipSet = createIpSet(env, { name: 'bad-ips', scope: 'CLOUDFRONT', description: '昨日の攻撃元', addresses: ['198.51.100.0/24'] });
      const acl = createWebAcl(env, {
        name: 'webapp-acl',
        scope: 'CLOUDFRONT',
        defaultAction: 'Allow',
        rules: [
          { name: 'block-bad-ips', priority: 0, action: 'Block', statement: { kind: 'ip-set', ipSetArn: ipSet } },
          { name: 'AWS-AWSManagedRulesCommonRuleSet', priority: 1, action: 'Block', statement: { kind: 'managed', vendor: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } },
        ],
      });
      const id = createDistribution(env, { comment: 'webapp shop', origin: { kind: 'alb', loadBalancerName: 'web-alb' }, aliases: [], viewerProtocolPolicy: 'redirect-to-https', defaultTtl: 0, webAclArn: acl }, Date.now() - 30 * DAY);
      const d = deployed(env, id);
      ['/wp-login.php', '/.env', '/?q=<script>alert(1)</script>', '/admin/../../etc/passwd'].forEach((uri, n) =>
        recordWafSample(env, acl, { at: yesterday + n * 5000, clientIp: '198.51.100.77', method: 'GET', uri, host: d.domainName, rule: n < 2 ? undefined : 'AWS-AWSManagedRulesCommonRuleSet', action: n < 2 ? 'ALLOW' : 'BLOCK' }),
      );
    }),
  );
}

/**
 * Lesson 39: production (webapp, now with a Multi-AZ DB) and a development copy in the same account.
 * Dev was built "like prod, only bigger": a NAT gateway per AZ, a Multi-AZ DB with 35 days of backups, debug logs kept forever.
 */
export function costEnv(): AwsEnv {
  return webAppEnv({}, (env) =>
    quietly(() => {
      const now = Date.now();
      const long = now - 200 * DAY;
      Object.assign(getDb(env, 'webapp-db'), { multiAZ: true });
      const logs = (name: string, gb: number, created: number, retention?: number) => {
        createLogGroup(env, name, { kind: 'stored' }, created);
        Object.assign(env.logGroups.find((g) => g.logGroupName === name)!, { ingestionGbPerMonth: gb, retentionInDays: retention, events: [] });
      };
      Object.assign(env.logGroups.find((g) => g.logGroupName === '/webapp/app')!, { ingestionGbPerMonth: 6, retentionInDays: 30 });
      Object.assign(env.logGroups.find((g) => g.logGroupName === '/aws/rds/instance/webapp-db/slowquery')!, { ingestionGbPerMonth: 0.5, retentionInDays: 30 });
      logs('/aws/cloudtrail/management-events', 3, now - 400 * DAY);
      logs('/webapp/dev/debug', 300, long);
      env.logGroups.find((g) => g.logGroupName === '/webapp/dev/debug')!.events = [0, 1, 2].map((n) => ({ timestamp: now - (3 - n) * MINUTE, logStreamName: 'dev-web-1', message: `DEBUG request_id=${1000 + n} headers={...} body={...} sql="SELECT * FROM orders ..."` }));

      const vpcId = createVpc(env, { cidrBlock: '10.1.0.0/16', name: 'dev-vpc' });
      const azs = ['a', 'c', 'd'];
      const pub = azs.map((az, n) => createSubnet(env, { vpcId, cidrBlock: `10.1.${n + 1}.0/24`, availabilityZone: `ap-northeast-1${az}`, name: `dev-public-1${az}` }));
      const priv = azs.map((az, n) => createSubnet(env, { vpcId, cidrBlock: `10.1.${n + 11}.0/24`, availabilityZone: `ap-northeast-1${az}`, name: `dev-private-1${az}` }));
      const igw = createInternetGateway(env, { name: 'dev-igw' });
      attachInternetGateway(env, igw, vpcId);
      const pubRt = createRouteTable(env, { vpcId, name: 'dev-public-rt' });
      setSubnetAssociations(env, pubRt, pub);
      replaceRoutes(env, pubRt, [{ destinationCidrBlock: '0.0.0.0/0', gatewayId: igw }]);
      azs.forEach((az, n) => {
        const nat = createNatGateway(env, { subnetId: pub[n], name: `dev-nat-1${az}` }, long);
        env.natGateways.find((x) => x.natGatewayId === nat)!.state = 'available';
        const rt = createRouteTable(env, { vpcId, name: `dev-private-rt-1${az}` });
        setSubnetAssociations(env, rt, [priv[n]]);
        replaceRoutes(env, rt, [{ destinationCidrBlock: '0.0.0.0/0', gatewayId: nat }]);
      });
      const sg = createSecurityGroup(env, { groupName: 'dev-sg', name: 'dev-sg', description: 'dev servers', vpcId, ingress: [] });
      runInstances(env, { name: 'dev-web-1', imageId: 'ami-0d52744d6551d851e', instanceType: 'm7i.large', keyName: 'webapp-key', subnetId: priv[0], securityGroupIds: [sg] }, long);
      runInstances(env, { name: 'dev-batch', imageId: 'ami-0d52744d6551d851e', instanceType: 'c7i.large', keyName: 'webapp-key', subnetId: priv[1], securityGroupIds: [sg] }, long);
      createDbSubnetGroup(env, { name: 'dev-db-subnet-group', description: 'dev DB', vpcId, subnetIds: [priv[0], priv[1]] });
      createDbInstance(env, { identifier: 'dev-db', engine: 'mysql', dbInstanceClass: 'db.m7g.large', masterUsername: 'admin', masterPassword: 'simulator-only', dbName: 'webapp', allocatedStorage: 100, dbSubnetGroupName: 'dev-db-subnet-group', vpcSecurityGroupIds: [sg], publiclyAccessible: false, multiAZ: true, availabilityZone: 'ap-northeast-1a', backupRetentionPeriod: 35 }, long);
      advanceTime(env, Infinity);
      for (const [n, id] of ['dev-db-before-migration-01', 'dev-db-before-migration-02', 'dev-db-test-2026-06', 'dev-db-test-2026-07', 'dev-db-test-2026-08'].entries()) {
        createDbSnapshot(env, 'dev-db', id, long + (n + 1) * 30 * DAY);
        advanceTime(env, Infinity);
      }
      env.budgets.push({ budgetName: 'monthly-budget', limitUsd: 850 });
      env.dataFlows.push(
        { name: 'dev-batch → S3 (学習データの取得)', source: 'dev-batch', subnetId: priv[1], destination: 's3', gbPerMonth: 2000 },
        { name: 'dev-web-1 → インターネット (パッケージ更新・外部 API)', source: 'dev-web-1', subnetId: priv[0], destination: 'internet', gbPerMonth: 100 },
      );
    }),
  );
}

export const ORG_ACCOUNTS = { management: '123456789012', audit: '111111111111', logArchive: '222222222222', prod: '333333333333', staging: '444444444444', dev: '555555555555' };
export const ORG_OUS = { security: 'ou-7k2q-sec0a1b2', production: 'ou-7k2q-prd3c4d5', staging: 'ou-7k2q-stg6e7f8', development: 'ou-7k2q-dev9g0h1' };
const ORG_ROOT = 'r-7k2q';

/**
 * The organization the webapp team runs: a management account plus Security / Production / Staging / Development OUs,
 * and IAM Identity Center with the Developers and Operators groups.
 * assignments: [group, account key, permission set] triples.
 */
function orgEnv(o: { prodParent: string; permissionSets: string[]; assignments: [string, keyof typeof ORG_ACCOUNTS, string][] }): AwsEnv {
  const env = accountEnv();
  withStableIds(`org:${JSON.stringify(o)}`, () =>
    quietly(() => {
      const joined = Date.now() - 400 * DAY;
      const orgId = 'o-a1b2c3d4e5';
      const ou = (id: string, name: string) => ({ id, arn: `arn:aws:organizations::${env.accountId}:ou/${orgId}/${id}`, name, parentId: ORG_ROOT });
      const acct = (id: string, name: string, parentId: string) => ({ id, name, email: `aws+${name}@webapp.example`, parentId, joinedAt: joined });
      const ous = [ou(ORG_OUS.security, 'Security'), ou(ORG_OUS.production, 'Production'), ou(ORG_OUS.staging, 'Staging'), ou(ORG_OUS.development, 'Development')];
      const accounts = [
        acct(ORG_ACCOUNTS.management, 'webapp-management', ORG_ROOT),
        acct(ORG_ACCOUNTS.audit, 'security-audit', ORG_OUS.security),
        acct(ORG_ACCOUNTS.logArchive, 'log-archive', ORG_OUS.security),
        acct(ORG_ACCOUNTS.prod, 'webapp-prod', o.prodParent),
        acct(ORG_ACCOUNTS.staging, 'webapp-staging', ORG_OUS.staging),
        acct(ORG_ACCOUNTS.dev, 'webapp-dev', ORG_OUS.development),
      ];
      const policy = (id: string, name: string, description: string, awsManaged: boolean, Statement: PolicyStatement[], targets: string[]) => ({ id, arn: `arn:aws:organizations::${awsManaged ? 'aws' : env.accountId}:policy/${awsManaged ? '' : `${orgId}/`}service_control_policy/${id}`, name, description, awsManaged, document: { Version: '2012-10-17' as const, Statement }, targets });
      env.organization = {
        id: orgId,
        arn: `arn:aws:organizations::${env.accountId}:organization/${orgId}`,
        managementAccountId: env.accountId,
        rootId: ORG_ROOT,
        ous,
        accounts,
        policies: [
          policy(FULL_AWS_ACCESS, 'FullAWSAccess', 'Allows access to every operation', true, [{ Effect: 'Allow', Action: '*', Resource: '*' }], [ORG_ROOT, ...ous.map((x) => x.id), ...accounts.map((a) => a.id)]),
          policy('p-prodguard1', 'prod-guardrails', '本番のデータベースとバックアップの削除を禁止', false, [{ Sid: 'DenyDeleteData', Effect: 'Deny', Action: ['rds:DeleteDBInstance', 'rds:DeleteDBSnapshot', 'rds:DeleteDBCluster', 'backup:DeleteRecoveryPoint', 's3:DeleteBucket'], Resource: '*' }], [ORG_OUS.production]),
        ],
      };
      env.identityCenter = {
        instanceArn: 'arn:aws:sso:::instance/ssoins-7758a1b2c3d4e5f6',
        identityStoreId: 'd-9567abc123',
        region: 'ap-northeast-1',
        users: [
          { userName: 'node', displayName: 'ノード君', email: 'node@webapp.example', groups: ['Developers'] },
          { userName: 'sato', displayName: '佐藤 (運用担当)', email: 'sato@webapp.example', groups: ['Operators'] },
        ],
        groups: [
          { groupName: 'Developers', description: 'アプリ開発チーム' },
          { groupName: 'Operators', description: '本番運用チーム' },
        ],
        permissionSets: [],
        assignments: [],
      };
      const arns = Object.fromEntries(o.permissionSets.map((name) => [name, createPermissionSet(env, { name, managedPolicyArns: [`arn:aws:iam::aws:policy/${name}`], sessionDuration: 'PT4H' }, joined)]));
      for (const [group, account, ps] of o.assignments) createAccountAssignment(env, { accountId: ORG_ACCOUNTS[account], permissionSetArn: arns[ps], principalType: 'GROUP', principalName: group });
    }),
  );
  return env;
}

/** Lesson 40: webapp-prod was invited into the organization but never moved out of Root, so the Production guardrails miss it. */
export const scpEnv = () =>
  orgEnv({
    prodParent: ORG_ROOT,
    permissionSets: ['AdministratorAccess', 'PowerUserAccess', 'ReadOnlyAccess'],
    assignments: [
      ['Developers', 'dev', 'AdministratorAccess'],
      ['Developers', 'staging', 'PowerUserAccess'],
      ['Developers', 'prod', 'ReadOnlyAccess'],
      ['Operators', 'staging', 'AdministratorAccess'],
      ['Operators', 'prod', 'AdministratorAccess'],
    ],
  });

/** Lesson 41: every developer is an administrator of every account, production included. */
export const ssoEnv = () =>
  orgEnv({
    prodParent: ORG_OUS.production,
    permissionSets: ['AdministratorAccess'],
    assignments: [
      ['Developers', 'dev', 'AdministratorAccess'],
      ['Developers', 'staging', 'AdministratorAccess'],
      ['Developers', 'prod', 'AdministratorAccess'],
      ['Operators', 'prod', 'AdministratorAccess'],
    ],
  });
