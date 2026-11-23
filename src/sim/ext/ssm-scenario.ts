// Lesson 46 scenario: the base stack is ready, Session Manager is not set up yet.
import { createLogGroup } from '../cloudwatch';
import { runInstances } from '../ec2';
import { byName } from '../env';
import { createRole, createUser, setInstanceProfile } from '../iam';
import { withStableIds } from '../ids';
import { CLIENT_IP } from '../network';
import { webAppEnv } from '../scenarios';
import { createSecurityGroup } from '../sg';
import { advanceTime } from '../time';
import type { AwsEnv } from '../types';
import { emptySsm } from './ssm';

export const SESSION_LOG_GROUP = '/ssm/session-logs';
export const EC2_ROLE = 'webapp-ec2-role';
const DAY = 86_400_000;

/**
 * webapp-vpc with web-1 (public-subnet-1a, public IP) and batch-1 (private-subnet-1a: only the local route, no NAT).
 * Operators reach web-1 over SSH from the office and batch-1 through web-1 (a bastion). Both run Amazon Linux 2023
 * (SSM Agent preinstalled) with webapp-ec2-role, which only has CloudWatchAgentServerPolicy (no Systems Manager permissions).
 * The security team prepared the log group /ssm/session-logs for session logs.
 */
export function sessionManagerEnv(): AwsEnv {
  return withStableIds('session-manager', () => {
    const env = webAppEnv({ upTo: 'network' });
    const t0 = Date.now() - 30 * DAY;
    const vpcId = byName(env.vpcs, 'webapp-vpc')!.vpcId;
    createUser(env, { userName: 'learner', policyArns: ['arn:aws:iam::aws:policy/AdministratorAccess'], consoleAccess: true }, t0);
    createRole(env, { roleName: EC2_ROLE, description: 'Allows web / batch servers to send metrics and logs to CloudWatch', trustPolicy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] }, policyArns: ['arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy'], withInstanceProfile: true }, t0);
    const web = createSecurityGroup(env, {
      groupName: 'web-sg',
      name: 'web-sg',
      description: 'Web server (HTTP, SSH from office)',
      vpcId,
      ingress: [
        { ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: '0.0.0.0/0', description: 'HTTP from internet' },
        { ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: `${CLIENT_IP}/32`, description: 'SSH from office' },
      ],
    });
    const batch = createSecurityGroup(env, { groupName: 'batch-sg', name: 'batch-sg', description: 'Batch server (SSH via web-1)', vpcId, ingress: [{ ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: web, description: 'SSH from bastion (web-1)' }] });
    const ami = 'ami-0d52744d6551d851e';
    const [webId] = runInstances(env, { name: 'web-1', imageId: ami, instanceType: 't3.micro', keyName: 'webapp-key', subnetId: byName(env.subnets, 'public-subnet-1a')!.subnetId, securityGroupIds: [web] }, t0);
    const [batchId] = runInstances(env, { name: 'batch-1', imageId: ami, instanceType: 't3.micro', keyName: 'webapp-key', subnetId: byName(env.subnets, 'private-subnet-1a')!.subnetId, securityGroupIds: [batch] }, t0);
    for (const id of [webId, batchId]) setInstanceProfile(env, id, env.instanceProfiles.find((p) => p.roleNames.includes(EC2_ROLE))!.arn);
    createLogGroup(env, SESSION_LOG_GROUP, { kind: 'stored' }, t0);
    Object.assign(env.logGroups.find((g) => g.logGroupName === SESSION_LOG_GROUP)!, { events: [], retentionInDays: 365 });
    env.ssm = emptySsm(t0);
    advanceTime(env, Infinity);
    return env;
  });
}
