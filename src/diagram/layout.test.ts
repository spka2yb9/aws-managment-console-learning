import { liveSpec } from './build';
import { findCollisions, layoutDiagram, overlaps, wrapText } from './layout';
import type { DiagramSpec } from './spec';
import { webAppEnv } from '../sim/scenarios';
import { setSecurityGroupRules } from '../sim/sg';

describe('diagram layout pipeline (Phase 8)', () => {
  it('Internet -> ALB -> EC2 -> RDS inside VPC / Public / Private groups, with statuses', async () => {
    const spec = liveSpec(webAppEnv());
    expect(spec.groups.map((g) => g.kind)).toEqual(expect.arrayContaining(['region', 'vpc', 'public-subnet', 'private-subnet']));
    expect(spec.nodes.find((n) => n.icon === 'alb')?.parent).toBe('pub');
    expect(spec.nodes.filter((n) => n.icon === 'ec2Instance').every((n) => n.parent === 'priv')).toBe(true);
    expect(spec.nodes.find((n) => n.icon === 'rdsInstance')?.parent).toBe('priv');
    expect(spec.edges.every((e) => e.status === 'connected')).toBe(true);
    expect((await layoutDiagram(spec)).collisions).toEqual([]);
    expect((await layoutDiagram(spec, { direction: 'DOWN' })).collisions).toEqual([]);
  });

  it('marks blocked links', () => {
    const env = webAppEnv({}, (e) => setSecurityGroupRules(e, e.securityGroups.find((g) => g.groupName === 'db-sg')!.groupId, 'ingress', []));
    const spec = liveSpec(env);
    expect(spec.edges.filter((e) => e.status === 'blocked').map((e) => e.id)).toEqual(expect.arrayContaining([expect.stringMatching(/^db-/)]));
  });

  it('long resource names and many nodes never overlap (nodes, labels, edge labels, group labels)', async () => {
    const long = 'my-extremely-long-resource-name-for-the-production-environment-0123456789abcdef';
    const spec: DiagramSpec = {
      groups: [
        { id: 'r', label: 'Region Asia Pacific (Tokyo) with a very long descriptive label that is wider than its content', kind: 'region' },
        { id: 'v', label: `VPC ${long} (10.0.0.0/16)`, kind: 'vpc', parent: 'r' },
        { id: 'p', label: 'Public subnet (public-subnet-1a, public-subnet-1c, public-subnet-1d)', kind: 'public-subnet', parent: 'v' },
        { id: 'q', label: 'Private subnet (private-subnet-1a, private-subnet-1c, private-subnet-1d)', kind: 'private-subnet', parent: 'v' },
      ],
      nodes: [
        { id: 'u', label: 'Internet', icon: 'users' },
        { id: 'alb', label: `alb-${long}`, sublabel: 'ALB · internet-facing', icon: 'alb', parent: 'p' },
        ...Array.from({ length: 8 }, (_, i) => ({ id: `ec2-${i}`, label: `web-${i}-${long}`, sublabel: `i-0${i}23456789abcdef0 · running`, icon: 'ec2Instance' as const, parent: 'q' })),
        { id: 'db', label: `db-${long}`, sublabel: 'RDS MySQL · available', icon: 'rdsInstance', parent: 'q' },
        { id: 'db2', label: `replica-${long}`, sublabel: 'RDS MySQL · available', icon: 'rdsInstance', parent: 'q' },
      ],
      edges: [
        { id: 'e0', source: 'u', target: 'alb', label: 'HTTP:80 Connected', status: 'connected' },
        ...Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, source: 'alb', target: `ec2-${i}`, label: `TCP:3000 ${i % 2 ? 'Blocked' : 'Connected'}`, status: (i % 2 ? 'blocked' : 'connected') as 'blocked' | 'connected' })),
        ...Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, source: `ec2-${i}`, target: i < 4 ? 'db' : 'db2', label: 'TCP:3306 Connected', status: 'connected' as const })),
      ],
    };
    for (const direction of ['RIGHT', 'DOWN'] as const) expect((await layoutDiagram(spec, { direction })).collisions).toEqual([]);
    const layout = await layoutDiagram(spec);
    expect(layout.nodes).toHaveLength(spec.nodes.length);
    expect(layout.edges.every((e) => e.points.length >= 2 && e.labelBox)).toBe(true);
    // wrapped: long names never exceed the text width budget
    expect(layout.nodes.find((n) => n.id === 'alb')!.lines.length).toBeGreaterThan(1);
  });

  it('collision checker detects overlaps', () => {
    const spec: DiagramSpec = { groups: [], nodes: [{ id: 'a', label: 'a', icon: 'ec2' }, { id: 'b', label: 'b', icon: 'ec2' }], edges: [] };
    const box = { x: 0, y: 0, width: 110, height: 100, icon: 'ec2' as const, lines: ['a'], sublines: [] as string[] };
    expect(findCollisions(spec, { width: 0, height: 0, groups: [], edges: [], nodes: [{ ...box, id: 'a' }, { ...box, id: 'b', x: 50 }] }).map((c) => c.kind)).toContain('node-overlap');
    expect(overlaps({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
  });

  it('wraps long ids', () => {
    expect(wrapText('i-0123456789abcdef0123456789abcdef', 80, { size: 12, weight: 400 }).length).toBeGreaterThan(1);
  });
});
