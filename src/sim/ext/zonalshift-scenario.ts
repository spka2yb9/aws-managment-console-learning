// Lesson 47: the web app behind web-alb in three AZs, with one AZ in a gray failure.
import { lbDimension, MINUTE, putMetricAlarm } from '../cloudwatch';
import { runInstances } from '../ec2';
import { createLoadBalancer, registerTargets } from '../elb';
import { byName } from '../env';
import { webAppEnv } from '../scenarios';
import type { AwsEnv } from '../types';
import { createSubnet, modifySubnetAttribute, setSubnetAssociations } from '../vpc';

/** the AZ whose network is degraded (AZ ID apne1-az2) */
export const IMPAIRED_AZ = 'ap-northeast-1c';
export const AZS = ['ap-northeast-1a', 'ap-northeast-1c', 'ap-northeast-1d'];
/** web-alb's HTTPCode_Target_5XX_Count over all AZs (the practice runs' outcome alarm) */
export const ALB_5XX_ALARM = 'web-alb-5xx';
/** the same metric per AZ: web-alb-5xx-1a / -1c / -1d */
export const azAlarm = (az: string) => `${ALB_5XX_ALARM}-${az.slice(-2)}`;

/**
 * Internet -> web-alb (public-subnet-1a/1c/1d) -> web-1/web-2/web-3 :3000 (private-subnet-1a/1c/1d), no database.
 * The ops team set up 5XX alarms for the ALB and for each AZ an hour ago. 25 minutes ago the network inside
 * ap-northeast-1c started to drop packets: requests to web-2 time out, but /health (tiny, every 30 s) still passes.
 */
export function zonalShiftEnv(): AwsEnv {
  return webAppEnv({ upTo: 'target-group' }, (env) => {
    const now = Date.now();
    const t0 = now - 3 * 86_400_000;
    const vpcId = byName(env.vpcs, 'webapp-vpc')!.vpcId;
    const pub = createSubnet(env, { vpcId, cidrBlock: '10.0.3.0/24', availabilityZone: 'ap-northeast-1d', name: 'public-subnet-1d' });
    modifySubnetAttribute(env, pub, { mapPublicIpOnLaunch: true });
    const publics = ['public-subnet-1a', 'public-subnet-1c', 'public-subnet-1d'].map((n) => byName(env.subnets, n)!.subnetId);
    setSubnetAssociations(env, byName(env.routeTables, 'public-rt')!.routeTableId, publics);
    const priv = createSubnet(env, { vpcId, cidrBlock: '10.0.13.0/24', availabilityZone: 'ap-northeast-1d', name: 'private-subnet-1d' });
    const [web3] = runInstances(env, { name: 'web-3', imageId: 'ami-0d52744d6551d851e', instanceType: 't3.micro', keyName: 'webapp-key', subnetId: priv, securityGroupIds: [byName(env.securityGroups, 'web-sg')!.groupId], app: { port: 3000, healthCheckPath: '/health' } }, t0);
    const tg = env.targetGroups[0].targetGroupArn;
    registerTargets(env, tg, [{ id: web3, port: 3000 }]);
    const lbArn = createLoadBalancer(env, { name: 'web-alb', scheme: 'internet-facing', vpcId, subnetIds: publics, securityGroupIds: [byName(env.securityGroups, 'alb-sg')!.groupId], listeners: [{ port: 80, targetGroupArn: tg }] }, t0);
    const lb = env.loadBalancers.find((l) => l.loadBalancerArn === lbArn)!;
    const alarm = (name: string, description: string, threshold: number, az?: string) =>
      putMetricAlarm(
        env,
        {
          alarmName: name,
          alarmDescription: description,
          namespace: 'AWS/ApplicationELB',
          metricName: 'HTTPCode_Target_5XX_Count',
          dimensions: [{ name: 'LoadBalancer', value: lbDimension(lb) }, ...(az ? [{ name: 'AvailabilityZone', value: az }] : [])],
          statistic: 'Sum',
          period: 60,
          evaluationPeriods: 1,
          datapointsToAlarm: 1,
          threshold,
          comparisonOperator: 'GreaterThanThreshold',
        },
        now - 60 * MINUTE,
      );
    alarm(ALB_5XX_ALARM, 'web-alb: 5XX errors from the targets (all AZs)', 50);
    for (const az of AZS) alarm(azAlarm(az), `web-alb: 5XX errors from the targets in ${az}`, 10, az);
    env.zonalShift = { impairments: [{ availabilityZone: IMPAIRED_AZ, startedAt: now - 25 * MINUTE }], shifts: [], configs: [] };
  });
}
