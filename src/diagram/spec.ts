import type { AwsIconKey } from './icons';

/** Input of the diagram layout pipeline. Groups nest (Region > VPC > Subnet); nodes sit in a group or at top level. */
export interface DiagramGroup {
  id: string;
  label: string;
  kind: 'cloud' | 'region' | 'vpc' | 'az' | 'public-subnet' | 'private-subnet' | 'security-group';
  parent?: string;
}

export interface DiagramNode {
  id: string;
  label: string;
  sublabel?: string;
  icon: AwsIconKey;
  parent?: string;
}

export type EdgeStatus = 'connected' | 'blocked' | 'neutral';

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  status?: EdgeStatus;
}

export interface DiagramSpec {
  groups: DiagramGroup[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}
