// @vitest-environment node
import { webAppEnv } from '../../sim/scenarios';
import { byName } from '../../sim/env';
import { bootShell } from '../test/harness';

describe('aws CLI', () => {
  it('describe / create / query / output formats', async () => {
    const { sh, state } = await bootShell(webAppEnv({ upTo: 'vpc' }));
    const vpcs = JSON.parse((await sh('aws ec2 describe-vpcs')).stdout);
    expect(vpcs.Vpcs.length).toBeGreaterThan(0);
    const id = (await sh(`aws ec2 describe-vpcs --filters Name=tag:Name,Values=webapp-vpc --query 'Vpcs[0].VpcId' --output text`)).stdout.trim();
    expect(id).toBe(byName(state().env.vpcs, 'webapp-vpc')!.vpcId);
    const r = await sh(`VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=webapp-vpc --query 'Vpcs[0].VpcId' --output text); aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.0.1.0/24 --availability-zone ap-northeast-1a --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=public-subnet-1a}]'`);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).Subnet.CidrBlock).toBe('10.0.1.0/24');
    expect(byName(state().env.subnets, 'public-subnet-1a')?.availabilityZone).toBe('ap-northeast-1a');
    const bad = await sh(`aws ec2 create-subnet --vpc-id ${id} --cidr-block 10.1.0.0/24`);
    expect(bad.exitCode).toBe(254);
    expect(bad.stderr).toContain("An error occurred (InvalidSubnet.Range) when calling the CreateSubnet operation: The CIDR '10.1.0.0/24' is invalid.");
    const rec = state().commands.at(-1)!;
    expect(rec).toMatchObject({ command: 'ec2 create-subnet', operation: 'CreateSubnet', ok: false, errorCode: 'InvalidSubnet.Range' });
    const text = (await sh('aws ec2 describe-subnets --query "Subnets[].[SubnetId,CidrBlock]" --output text')).stdout;
    expect(text).toMatch(/subnet-\w+\t10\.0\.1\.0\/24/);
    const table = (await sh('aws ec2 describe-subnets --query "Subnets[].{CIDR:CidrBlock,AZ:AvailabilityZone}" --output table')).stdout;
    expect(table).toContain('DescribeSubnets');
    expect(table).toContain('|  ap-northeast-1a');
  });

  it('usage errors, help, configure, sts', async () => {
    const { sh } = await bootShell(webAppEnv({ upTo: 'vpc' }));
    expect((await sh('aws')).exitCode).toBe(252);
    const miss = await sh('aws ec2 create-subnet --cidr-block 10.0.1.0/24');
    expect(miss.stderr).toContain('the following arguments are required: --vpc-id');
    expect((await sh('aws ec2 describe-vpcs --foo bar')).stderr).toContain('Unknown options: --foo, bar');
    expect((await sh('aws ec2 nope')).stderr).toContain('Invalid choice');
    expect((await sh('aws ec2 create-vpc help')).stdout).toContain('--cidr-block <value>');
    expect((await sh('aws configure get region')).stdout.trim()).toBe('ap-northeast-1');
    await sh('aws configure set region us-east-1');
    expect((await sh('aws configure get region')).stdout.trim()).toBe('us-east-1');
    expect(JSON.parse((await sh('aws ec2 describe-vpcs')).stdout).Vpcs).toEqual([]);
    expect(JSON.parse((await sh('aws sts get-caller-identity')).stdout).Arn).toContain(':user/learner');
    const loop = await sh('for r in ap-northeast-1 us-east-1; do aws ec2 describe-vpcs --region $r --query "length(Vpcs)"; done');
    expect(loop.stdout.trim().split('\n').length).toBe(2);
  });
});

describe('aws CLI: network / ELB / RDS operations', () => {
  it('builds IGW + route, opens an SG port, registers targets and curls the ALB', async () => {
    const { sh, state } = await bootShell(webAppEnv());
    const env = () => state().env;
    const vpc = byName(env().vpcs, 'webapp-vpc')!.vpcId;
    const sg = (await sh(`aws ec2 create-security-group --group-name test-sg --description test --vpc-id ${vpc} --query GroupId --output text`)).stdout.trim();
    expect(sg).toMatch(/^sg-/);
    expect((await sh(`aws ec2 authorize-security-group-ingress --group-id ${sg} --protocol tcp --port 22 --cidr 198.51.100.24/32`)).exitCode).toBe(0);
    const dup = await sh(`aws ec2 authorize-security-group-ingress --group-id ${sg} --protocol tcp --port 22 --cidr 198.51.100.24/32`);
    expect(dup.stderr).toContain('InvalidPermission.Duplicate');
    expect((await sh(`aws ec2 authorize-security-group-ingress --group-id ${sg} --ip-permissions 'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description="web"}]'`)).exitCode).toBe(0);
    const perms = JSON.parse((await sh(`aws ec2 describe-security-groups --group-ids ${sg} --query 'SecurityGroups[0].IpPermissions'`)).stdout);
    expect(perms.map((p: { FromPort: number }) => p.FromPort).sort()).toEqual([22, 80]);
    expect((await sh(`aws ec2 revoke-security-group-ingress --group-id ${sg} --protocol tcp --port 22 --cidr 198.51.100.24/32`)).exitCode).toBe(0);
    expect(env().securityGroups.find((g) => g.groupId === sg)!.ingress).toHaveLength(1);
    const rt = (await sh(`aws ec2 create-route-table --vpc-id ${vpc} --query RouteTable.RouteTableId --output text`)).stdout.trim();
    const noIgw = await sh(`aws ec2 create-route --route-table-id ${rt} --destination-cidr-block 0.0.0.0/0 --gateway-id igw-nope`);
    expect(noIgw.exitCode).toBe(254);
    const lb = await sh('aws elbv2 describe-load-balancers --names web-alb --query "LoadBalancers[0].DNSName" --output text');
    const r = await sh(`curl -s http://${lb.stdout.trim()}/`);
    expect(r.exitCode).toBe(0);
    expect(state().browser[0].status).toBeDefined();
    const health = JSON.parse((await sh(`aws elbv2 describe-target-health --target-group-arn ${env().targetGroups[0].targetGroupArn}`)).stdout);
    expect(Array.isArray(health.TargetHealthDescriptions)).toBe(true);
    const db = JSON.parse((await sh('aws rds describe-db-instances --query "DBInstances[].DBInstanceIdentifier"')).stdout);
    expect(Array.isArray(db)).toBe(true);
  });
});
