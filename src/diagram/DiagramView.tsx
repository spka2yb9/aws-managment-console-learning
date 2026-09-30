import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import { Background, BaseEdge, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useConsole } from '../console/store';
import { liveSpec } from './build';
import { AWS_GROUP_ICONS, AWS_ICONS } from './icons';
import { EDGE_LABEL, FONT_FAMILY, GROUP_LABEL, LABEL, layoutDiagram, SUBLABEL, type DiagramLayout, type Direction, type LaidOutEdge, type LaidOutGroup, type LaidOutNode } from './layout';
import type { DiagramSpec } from './spec';

const GROUP_STYLE: Record<LaidOutGroup['kind'], { border: string; bg: string; dashed?: boolean; color: string }> = {
  cloud: { border: '#232f3e', bg: 'transparent', color: '#232f3e' },
  region: { border: '#00a4a6', bg: 'transparent', dashed: true, color: '#00a4a6' },
  vpc: { border: '#8c4fff', bg: 'transparent', color: '#8c4fff' },
  az: { border: '#00a4a6', bg: 'transparent', dashed: true, color: '#00a4a6' },
  'public-subnet': { border: '#7aa116', bg: 'rgba(122, 161, 22, 0.08)', color: '#248814' },
  'private-subnet': { border: '#00a4a6', bg: 'rgba(0, 164, 166, 0.08)', color: '#147eba' },
  'security-group': { border: '#dd344c', bg: 'transparent', dashed: true, color: '#dd344c' },
};
const EDGE_COLOR = { connected: '#037f0c', blocked: '#d91515', neutral: '#687078' };
const font = (f: { size: number; weight: number; lineHeight: number }) => ({ fontFamily: FONT_FAMILY, fontSize: f.size, fontWeight: f.weight, lineHeight: `${f.lineHeight}px` });

function AwsNode({ data }: NodeProps<Node<{ n: LaidOutNode }>>) {
  const { n } = data;
  return (
    <div className="diagram-node" style={{ width: n.width, height: n.height }} data-testid={`diagram-node-${n.id}`}>
      <Handle type="target" position={Position.Left} className="diagram-handle" />
      <img src={AWS_ICONS[n.icon]} width={48} height={48} alt="" draggable={false} />
      {n.lines.map((l, i) => <div key={i} className="diagram-line" style={font(LABEL)}>{l}</div>)}
      {n.sublines.map((l, i) => <div key={`s${i}`} className="diagram-line diagram-sub" style={font(SUBLABEL)}>{l}</div>)}
      <Handle type="source" position={Position.Right} className="diagram-handle" />
    </div>
  );
}

function GroupNode({ data }: NodeProps<Node<{ g: LaidOutGroup }>>) {
  const { g } = data;
  const s = GROUP_STYLE[g.kind];
  const icon = (AWS_GROUP_ICONS as Record<string, string | undefined>)[g.kind];
  return (
    <div className="diagram-group" style={{ width: g.width, height: g.height, borderColor: s.border, borderStyle: s.dashed ? 'dashed' : 'solid', background: s.bg }} data-testid={`diagram-group-${g.id}`}>
      <div className="diagram-group-label" style={{ ...font(GROUP_LABEL), color: s.color, left: g.labelBox.x - g.x, top: g.labelBox.y - g.y }}>
        {icon && <img src={icon} width={24} height={24} alt="" draggable={false} />}
        <span>{g.labelLines.map((l, i) => <div key={i}>{l}</div>)}</span>
      </div>
    </div>
  );
}

function ElkEdge({ data }: EdgeProps<Edge<{ e: LaidOutEdge }>>) {
  const e = data!.e;
  const path = e.points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
  const color = EDGE_COLOR[e.status];
  return (
    <>
      <BaseEdge path={path} style={{ stroke: color, strokeWidth: 2, strokeDasharray: e.status === 'blocked' ? '6 4' : undefined }} markerEnd={`url(#arrow-${e.status})`} />
      {e.labelBox && e.label && (
        <foreignObject x={e.labelBox.x} y={e.labelBox.y} width={e.labelBox.width} height={e.labelBox.height} className="diagram-edge-label-host">
          <div className="diagram-edge-label" data-status={e.status} data-testid={`diagram-edge-${e.id}`} style={{ ...font(EDGE_LABEL), color, borderColor: color }}>
            {e.label}
          </div>
        </foreignObject>
      )}
    </>
  );
}

const nodeTypes = { aws: AwsNode, awsGroup: GroupNode };
const edgeTypes = { elk: ElkEdge };

function Markers() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }}>
      <defs>
        {Object.entries(EDGE_COLOR).map(([k, c]) => (
          <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={c} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

export function useDiagramLayout(spec: DiagramSpec, direction: Direction): DiagramLayout | null {
  const key = JSON.stringify([spec, direction]);
  const [state, setState] = useState<{ key: string; layout: DiagramLayout } | null>(null);
  useEffect(() => {
    let alive = true;
    const [s, d] = JSON.parse(key) as [DiagramSpec, Direction];
    void layoutDiagram(s, { direction: d }).then((layout) => alive && setState({ key, layout }));
    return () => {
      alive = false;
    };
  }, [key]);
  return state?.key === key ? state.layout : null;
}

/** Re-fit whenever the canvas changes size (drawer resize, modal opening animation). */
function FitOnResize({ target }: { target: RefObject<HTMLDivElement | null> }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const ro = new ResizeObserver(() => void fitView({ padding: 0.06 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitView, target]);
  return null;
}

/** Canvas height follows the diagram's aspect ratio (capped), so tall top-down layouts stay readable in the panel. */
function useAspectHeight(ref: RefObject<HTMLDivElement | null>, layout: DiagramLayout, max: number) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return Math.round(Math.min(max, Math.max(240, ((width || 400) * layout.height) / Math.max(1, layout.width) + 16)));
}

function Flow({ layout, height }: { layout: DiagramLayout; height: number | string }) {
  const nodes: Node[] = useMemo(
    () => [
      ...[...layout.groups].sort((a, b) => a.depth - b.depth).map((g) => ({ id: `group:${g.id}`, type: 'awsGroup', position: { x: g.x, y: g.y }, data: { g }, zIndex: g.depth, selectable: false, draggable: false, width: g.width, height: g.height })),
      ...layout.nodes.map((n) => ({ id: n.id, type: 'aws', position: { x: n.x, y: n.y }, data: { n }, zIndex: 100, draggable: false, width: n.width, height: n.height })),
    ],
    [layout],
  );
  const edges: Edge[] = useMemo(() => layout.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: 'elk', data: { e }, zIndex: 200 })), [layout]);
  const ref = useRef<HTMLDivElement>(null);
  const auto = useAspectHeight(ref, layout, typeof height === 'number' ? height : 0);
  return (
    <div style={{ height: typeof height === 'number' ? auto : height }} className="diagram-canvas" ref={ref}>
      <Markers />
      <ReactFlowProvider>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView fitViewOptions={{ padding: 0.06 }} minZoom={0.1} maxZoom={2} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}>
          <Background gap={24} size={1} />
          <FitOnResize target={ref} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

function StatusBadges({ layout }: { layout: DiagramLayout }) {
  const judged = layout.edges.filter((e) => e.status !== 'neutral');
  const blocked = judged.filter((e) => e.status === 'blocked').length;
  return (
    <SpaceBetween direction="horizontal" size="xs">
      {judged.length > 0 && (
        <span data-testid="diagram-status">
          <Badge color={blocked ? 'red' : 'green'}>{blocked ? `BLOCKED ${blocked}` : 'ALL CONNECTED'}</Badge>
        </span>
      )}
      {/* collision count is for tests / debugging; the layout engine keeps it at 0 */}
      <span data-testid="diagram-collisions" data-count={layout.collisions.length} data-detail={JSON.stringify(layout.collisions)} hidden />
    </SpaceBetween>
  );
}

/** React Flow + ELK AWS diagram. `spec="live"` draws the current simulated environment. */
export function DiagramView({ title, spec }: { title: string; spec: DiagramSpec | 'live' }) {
  const env = useConsole((s) => s.env);
  const resolved = useMemo(() => (spec === 'live' ? liveSpec(env) : spec), [spec, env]);
  const layout = useDiagramLayout(resolved, 'DOWN');
  const [zoom, setZoom] = useState(false);
  const wide = useDiagramLayout(resolved, 'RIGHT');
  return (
    <div data-testid="diagram">
      <Container
        header={
          <Header variant="h3" actions={<Button variant="icon" iconName="expand" ariaLabel="拡大表示" onClick={() => setZoom(true)} />} description={layout && <StatusBadges layout={layout} />}>
            {title}
          </Header>
        }
      >
        {!resolved.nodes.length ? <Box color="text-body-secondary">表示できるリソースがありません</Box> : layout ? <Flow layout={layout} height={1100} /> : <Box textAlign="center"><Spinner /></Box>}
      </Container>
      {zoom && wide && (
        <Modal visible size="max" header={title} onDismiss={() => setZoom(false)}>
          <Flow layout={wide} height="70vh" />
        </Modal>
      )}
    </div>
  );
}
