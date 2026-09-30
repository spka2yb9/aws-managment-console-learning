import type { SelectProps } from '@cloudscape-design/components/select';
import { nameOf } from '../sim/env';
import type { InternetGateway, RouteTable, SecurityGroup, Subnet, Vpc } from '../sim/types';

// Select options formatted like the AWS console: "vpc-0abc... (webapp-vpc)".
const withName = (id: string, name: string) => (name ? `${id} (${name})` : id);

export const vpcOption = (v: Vpc): SelectProps.Option => ({ value: v.vpcId, label: withName(v.vpcId, nameOf(v)), description: v.cidrBlock + (v.isDefault ? ' (デフォルト)' : '') });
export const subnetOption = (s: Subnet): SelectProps.Option => ({ value: s.subnetId, label: withName(s.subnetId, nameOf(s)), description: `${s.availabilityZone} · ${s.cidrBlock}` });
export const sgOption = (g: SecurityGroup): SelectProps.Option => ({ value: g.groupId, label: g.groupName, description: `${g.groupId} · VPC: ${g.vpcId}` });
export const rtOption = (r: RouteTable): SelectProps.Option => ({ value: r.routeTableId, label: withName(r.routeTableId, nameOf(r)) });
export const igwOption = (g: InternetGateway): SelectProps.Option => ({ value: g.internetGatewayId, label: withName(g.internetGatewayId, nameOf(g)), description: g.attachments[0] ? `アタッチ済み: ${g.attachments[0].vpcId}` : 'デタッチ済み' });

export function pick<T extends SelectProps.Option>(options: T[], value: string | undefined): T | null {
  return options.find((o) => o.value === value) ?? null;
}
