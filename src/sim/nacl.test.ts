import { runInstances } from './ec2';
import { byName } from './env';
import { simulateHttp } from './http';
import { associateSubnetNacl, createNetworkAcl, evaluateNacl, replaceNetworkAclEntries, setNaclSubnetAssociations, subnetNacl } from './nacl';
import { canConnect, canConnectFromInternet } from './network';
import { webAppEnv } from './scenarios';
import { createSecurityGroup } from './sg';
import type { AwsEnv, NetworkAcl } from './types';

const subnet = (env: AwsEnv, n: string) => byName(env.subnets, n)!.subnetId;
const vpc = (env: AwsEnv) => byName(env.vpcs, 'webapp-vpc')!.vpcId;
const tcp = (ruleNumber: number, from: number, to: number, cidrBlock = '0.0.0.0/0', ruleAction: 'allow' | 'deny' = 'allow') => ({ ruleNumber, protocol: 'tcp' as const, fromPort: from, toPort: to, cidrBlock, ruleAction });

/** web-server (port 80 app, public IP) in public-subnet-1a with an SG open for HTTP. */
function publicServer() {
  const env = webAppEnv({ upTo: 'network' }, (e) => {
    const sg = createSecurityGroup(e, { groupName: 'web', description: 'web', vpcId: vpc(e), ingress: [{ ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: '0.0.0.0/0' }] });
    runInstances(e, { name: 'web-server', imageId: 'ami-0d52744d6551d851e', instanceType: 't3.micro', subnetId: subnet(e, 'public-subnet-1a'), securityGroupIds: [sg], associatePublicIpAddress: true, app: { port: 80, healthCheckPath: '/' } });
  });
  const i = byName(env.instances, 'web-server')!;
  const acl = createNetworkAcl(env, { vpcId: vpc(env), name: 'public-nacl' });
  associateSubnetNacl(env, subnet(env, 'public-subnet-1a'), acl);
  return { env, acl, i, get: () => simulateHttp(env, `http://${i.publicIpAddress}`) };
}

describe('Network ACL', () => {
  it('first match over a port range, rest hits "*"', () => {
    const acl: NetworkAcl = { networkAclId: 'acl-1', vpcId: 'v', isDefault: false, associations: [], tags: [], entries: [
      { ruleNumber: 110, egress: false, protocol: 'tcp', fromPort: 1500, toPort: 3000, cidrBlock: '0.0.0.0/0', ruleAction: 'deny' },
      { ruleNumber: 100, egress: false, protocol: 'tcp', fromPort: 1024, toPort: 2000, cidrBlock: '0.0.0.0/0', ruleAction: 'allow' },
    ] };
    const ev = evaluateNacl(acl, false, 'tcp', [1000, 3000], '1.2.3.4');
    expect(ev.allowed).toBe(false);
    expect(ev.decidedBy).toEqual([100, 110, '*']);
    expect(ev.denied).toEqual([[2001, 3000], [1000, 1023]]);
    expect(evaluateNacl(acl, false, 'tcp', [1100, 1400], '1.2.3.4').allowed).toBe(true);
    expect(evaluateNacl(acl, false, 'udp', [1100, 1100], '1.2.3.4').allowed).toBe(false);
  });

  it('default ACL allows everything', () => {
    const env = webAppEnv();
    expect(subnetNacl(env, subnet(env, 'private-subnet-1a')).isDefault).toBe(true);
    expect(simulateHttp(env, `http://${env.loadBalancers[0].dnsName}`).status).toBe(200);
  });

  it('is stateless: inbound 80 alone is not enough, the response needs outbound ephemeral ports', () => {
    const { env, acl, i, get } = publicServer();
    replaceNetworkAclEntries(env, acl, false, [tcp(100, 80, 80)]);
    expect(get().error).toBe('ERR_CONNECTION_TIMED_OUT');
    const failing = canConnectFromInternet(env, i.instanceId, 'tcp', 80).checks.find((c) => !c.ok)!;
    expect(failing.detail).toMatch(/戻り通信/);
    replaceNetworkAclEntries(env, acl, true, [tcp(100, 1024, 40000)]); // client uses 49152-65535
    expect(get().error).toBe('ERR_CONNECTION_TIMED_OUT');
    replaceNetworkAclEntries(env, acl, true, [tcp(100, 1024, 65535)]);
    expect(get().status).toBe(200);
  });

  it('lower rule number wins', () => {
    const { env, acl, get } = publicServer();
    replaceNetworkAclEntries(env, acl, true, [tcp(100, 1024, 65535)]);
    replaceNetworkAclEntries(env, acl, false, [{ ruleNumber: 100, protocol: '-1', cidrBlock: '0.0.0.0/0', ruleAction: 'deny' }, tcp(200, 80, 80)]);
    expect(get().error).toBe('ERR_CONNECTION_TIMED_OUT');
    replaceNetworkAclEntries(env, acl, false, [{ ruleNumber: 300, protocol: '-1', cidrBlock: '0.0.0.0/0', ruleAction: 'deny' }, tcp(200, 80, 80)]);
    expect(get().status).toBe(200);
  });

  it('does not apply inside a subnet; applies across subnets (ALB -> EC2, EC2 -> RDS)', () => {
    const env = webAppEnv();
    const acl = createNetworkAcl(env, { vpcId: vpc(env), name: 'private-nacl' }); // deny all
    setNaclSubnetAssociations(env, acl, [subnet(env, 'private-subnet-1a'), subnet(env, 'private-subnet-1c')]);
    const web1 = byName(env.instances, 'web-1')!.instanceId; // private-1a, same subnet as the DB
    const web2 = byName(env.instances, 'web-2')!.instanceId; // private-1c
    expect(canConnect(env, web1, 'webapp-db', 'tcp', 3306).ok).toBe(true);
    expect(canConnect(env, web2, 'webapp-db', 'tcp', 3306).ok).toBe(false);
    expect(canConnect(env, env.loadBalancers[0].loadBalancerArn, web1, 'tcp', 3000).ok).toBe(false);
    expect(simulateHttp(env, `http://${env.loadBalancers[0].dnsName}`).status).toBe(504);
    replaceNetworkAclEntries(env, acl, false, [tcp(100, 3000, 3000, '10.0.0.0/16'), tcp(110, 3306, 3306, '10.0.0.0/16'), tcp(120, 1024, 65535, '10.0.0.0/16')]);
    replaceNetworkAclEntries(env, acl, true, [tcp(100, 3306, 3306, '10.0.0.0/16'), tcp(120, 1024, 65535, '10.0.0.0/16')]);
    expect(canConnect(env, web2, 'webapp-db', 'tcp', 3306).ok).toBe(true);
    expect(simulateHttp(env, `http://${env.loadBalancers[0].dnsName}`).status).toBe(200);
  });

  it('associations: a subnet always has exactly one ACL; the default ACL cannot drop subnets', () => {
    const env = webAppEnv({ upTo: 'network' });
    const acl = createNetworkAcl(env, { vpcId: vpc(env) });
    const s = subnet(env, 'private-subnet-1a');
    setNaclSubnetAssociations(env, acl, [s]);
    expect(subnetNacl(env, s).networkAclId).toBe(acl);
    setNaclSubnetAssociations(env, acl, []);
    expect(subnetNacl(env, s).isDefault).toBe(true);
    expect(env.networkAcls.filter((a) => a.associations.some((x) => x.subnetId === s))).toHaveLength(1);
    const def = subnetNacl(env, s).networkAclId;
    expect(() => setNaclSubnetAssociations(env, def, [])).toThrow(/must always be associated/);
  });

  it('validates entries like AWS', () => {
    const env = webAppEnv({ upTo: 'network' });
    const acl = createNetworkAcl(env, { vpcId: vpc(env) });
    expect(() => replaceNetworkAclEntries(env, acl, false, [tcp(100, 80, 80), tcp(100, 443, 443)])).toThrow(/already exists/);
    expect(() => replaceNetworkAclEntries(env, acl, false, [tcp(40000, 80, 80)])).toThrow(/between 1 and 32766/);
    expect(() => replaceNetworkAclEntries(env, acl, false, [tcp(100, 80, 80, '10.0.0.1/16')])).toThrow(/not a valid CIDR/);
    expect(() => replaceNetworkAclEntries(env, acl, false, [tcp(100, 90, 80)])).toThrow(/port range/);
  });
});
