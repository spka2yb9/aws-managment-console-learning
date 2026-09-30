// Diagram layout pipeline:
//   Node生成 -> Nodeサイズ計測 -> Group計算 -> ELK -> Collision Check -> Edge Routing -> Label Placement -> Final Validation
// ELK (layered, orthogonal) places nodes, groups, edge bend points and edge labels; we measure every text box
// up front so ELK reserves real space, then verify there is no overlap and re-run with more spacing if needed.
import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { AwsIconKey } from './icons';
import type { DiagramGroup, DiagramSpec, EdgeStatus } from './spec';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutNode extends Rect {
  id: string;
  icon: AwsIconKey;
  lines: string[];
  sublines: string[];
}

export interface LaidOutGroup extends Rect {
  id: string;
  kind: DiagramGroup['kind'];
  label: string;
  labelLines: string[];
  labelBox: Rect;
  depth: number;
}

export interface LaidOutEdge {
  id: string;
  source: string;
  target: string;
  points: { x: number; y: number }[];
  label?: string;
  labelBox?: Rect;
  status: EdgeStatus;
}

export interface Collision {
  kind: 'node-overlap' | 'label-overflow' | 'edge-label-overlap' | 'group-label-overlap' | 'group-overlap' | 'edge-crosses-label' | 'edge-crosses-node';
  a: string;
  b: string;
}

export interface DiagramLayout {
  width: number;
  height: number;
  nodes: LaidOutNode[];
  groups: LaidOutGroup[];
  edges: LaidOutEdge[];
  collisions: Collision[];
  attempts: number;
}

// ---------- text measurement ----------

export const FONT_FAMILY = '"Open Sans", "Helvetica Neue", Roboto, Arial, sans-serif';
export const LABEL = { size: 12, weight: 700, lineHeight: 16 };
export const SUBLABEL = { size: 11, weight: 400, lineHeight: 14 };
export const EDGE_LABEL = { size: 11, weight: 600, lineHeight: 14 };
export const GROUP_LABEL = { size: 12, weight: 700, lineHeight: 16 };
const ICON = 48;
const NODE_PAD = 10;
const MAX_TEXT = 150;
/** Canvas metrics vs. actual rendering (font loading, hinting): reserve a little extra so text never overflows. */
const SAFETY = 1.12;

let ctx2d: CanvasRenderingContext2D | null | undefined;
function canvas(): CanvasRenderingContext2D | null {
  if (ctx2d !== undefined) return ctx2d;
  const inBrowser = typeof document !== 'undefined' && !/jsdom/i.test(navigator.userAgent);
  ctx2d = inBrowser ? document.createElement('canvas').getContext('2d') : null;
  return ctx2d;
}

/** Width in px. Uses canvas in the browser; a per-character estimate elsewhere (tests / SSR-less tooling). */
export function measureText(text: string, font: { size: number; weight: number }): number {
  const c = canvas();
  if (c) {
    c.font = `${font.weight} ${font.size}px ${FONT_FAMILY}`;
    return c.measureText(text).width * SAFETY;
  }
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 0x2e80 ? 1 : ch === ' ' ? 0.3 : /[A-Z0-9]/.test(ch) ? 0.66 : 0.58;
  return w * font.size * (font.weight >= 600 ? 1.06 : 1) * SAFETY;
}

/** Wrap on spaces / hyphens; hard-break tokens (long resource ids) that are still too wide. */
export function wrapText(text: string, maxWidth: number, font: { size: number; weight: number }): string[] {
  const tokens = text.split(/(?<=\s)/);
  const lines: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) lines.push(cur.trim());
    cur = '';
  };
  for (const t of tokens) {
    if (measureText(cur + t, font) <= maxWidth) {
      cur += t;
      continue;
    }
    push();
    let rest = t;
    while (measureText(rest, font) > maxWidth) {
      let n = rest.length;
      while (n > 1 && measureText(rest.slice(0, n), font) > maxWidth) n--;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    cur = rest;
  }
  push();
  return lines.length ? lines : [''];
}

// ---------- geometry ----------

export function overlaps(a: Rect, b: Rect, eps = 0.5): boolean {
  return a.x < b.x + b.width - eps && b.x < a.x + a.width - eps && a.y < b.y + b.height - eps && b.y < a.y + a.height - eps;
}

export function contains(outer: Rect, inner: Rect, eps = 0.5): boolean {
  return inner.x >= outer.x - eps && inner.y >= outer.y - eps && inner.x + inner.width <= outer.x + outer.width + eps && inner.y + inner.height <= outer.y + outer.height + eps;
}

type Pt = { x: number; y: number };

/** Axis-aligned segment (orthogonal routing) vs rect, with the rect shrunk by `inset` so touching borders don't count. */
export function segmentHitsRect(a: Pt, b: Pt, r: Rect, inset = 1): boolean {
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  return x2 > r.x + inset && x1 < r.x + r.width - inset && y2 > r.y + inset && y1 < r.y + r.height - inset;
}

function segments(points: Pt[]): [Pt, Pt][] {
  return points.slice(1).map((p, i) => [points[i], p]);
}

function ancestors(groups: Map<string, DiagramGroup>, id: string | undefined): string[] {
  const out: string[] = [];
  for (let g = id; g; g = groups.get(g)?.parent) out.push(g);
  return out;
}

/** Final validation: every pair of boxes that must not overlap. */
export function findCollisions(spec: DiagramSpec, layout: Omit<DiagramLayout, 'collisions' | 'attempts'>): Collision[] {
  const out: Collision[] = [];
  const gSpec = new Map(spec.groups.map((g) => [g.id, g]));
  const nodeParent = new Map(spec.nodes.map((n) => [n.id, n.parent]));
  const { nodes, groups, edges } = layout;
  const labels = edges.filter((e) => e.labelBox);
  // nodes vs nodes
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (overlaps(nodes[i], nodes[j])) out.push({ kind: 'node-overlap', a: nodes[i].id, b: nodes[j].id });
  // text must fit its node
  for (const n of nodes) {
    const widest = Math.max(...n.lines.map((l) => measureText(l, LABEL)), ...n.sublines.map((l) => measureText(l, SUBLABEL)));
    if (widest > n.width - NODE_PAD) out.push({ kind: 'label-overflow', a: n.id, b: n.id });
  }
  // nodes vs groups: inside every ancestor, outside every other group
  for (const n of nodes) {
    const anc = ancestors(gSpec, nodeParent.get(n.id));
    for (const g of groups) {
      if (anc.includes(g.id) ? !contains(g, n) : overlaps(g, n)) out.push({ kind: 'node-overlap', a: n.id, b: g.id });
      if (overlaps(g.labelBox, n)) out.push({ kind: 'group-label-overlap', a: g.id, b: n.id });
    }
  }
  // groups vs groups
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      const nested = ancestors(gSpec, a.id).includes(b.id) || ancestors(gSpec, b.id).includes(a.id);
      if (!nested && overlaps(a, b)) out.push({ kind: 'group-overlap', a: a.id, b: b.id });
      if (overlaps(a.labelBox, b.labelBox)) out.push({ kind: 'group-label-overlap', a: a.id, b: b.id });
      const [outer, inner] = ancestors(gSpec, b.id).includes(a.id) ? [a, b] : [b, a];
      if (nested && overlaps(outer.labelBox, inner)) out.push({ kind: 'group-label-overlap', a: outer.id, b: inner.id });
    }
  // group labels must sit inside their group
  for (const g of groups) if (!contains(g, g.labelBox)) out.push({ kind: 'group-label-overlap', a: g.id, b: g.id });
  // edge lines must not run through group labels, other edges' labels, or nodes other than their endpoints
  for (const e of edges)
    for (const [a, b] of segments(e.points)) {
      for (const g of groups) if (segmentHitsRect(a, b, g.labelBox)) out.push({ kind: 'edge-crosses-label', a: e.id, b: g.id });
      for (const o of labels) if (o !== e && segmentHitsRect(a, b, o.labelBox!)) out.push({ kind: 'edge-crosses-label', a: e.id, b: o.id });
      for (const n of nodes) if (n.id !== e.source && n.id !== e.target && segmentHitsRect(a, b, n)) out.push({ kind: 'edge-crosses-node', a: e.id, b: n.id });
    }
  // edge labels vs everything
  for (let i = 0; i < labels.length; i++) {
    const a = labels[i];
    for (const n of nodes) if (overlaps(a.labelBox!, n)) out.push({ kind: 'edge-label-overlap', a: a.id, b: n.id });
    for (const g of groups) if (overlaps(a.labelBox!, g.labelBox)) out.push({ kind: 'edge-label-overlap', a: a.id, b: g.id });
    for (let j = i + 1; j < labels.length; j++) if (overlaps(a.labelBox!, labels[j].labelBox!)) out.push({ kind: 'edge-label-overlap', a: a.id, b: labels[j].id });
  }
  return out;
}

// ---------- pipeline ----------

const elk = new ELK();

function nodeSize(label: string, sublabel?: string) {
  const lines = wrapText(label, MAX_TEXT, LABEL);
  const sublines = sublabel ? wrapText(sublabel, MAX_TEXT, SUBLABEL) : [];
  const textW = Math.max(...lines.map((l) => measureText(l, LABEL)), ...sublines.map((l) => measureText(l, SUBLABEL)), 0);
  return {
    lines,
    sublines,
    width: Math.ceil(Math.max(ICON + 2 * NODE_PAD, textW + 2 * NODE_PAD, 110)),
    height: Math.ceil(NODE_PAD + ICON + 6 + lines.length * LABEL.lineHeight + sublines.length * SUBLABEL.lineHeight + NODE_PAD),
  };
}

const GROUP_ICON = 24;

async function runElk(spec: DiagramSpec, spacing: number, direction: Direction) {
  const sizes = new Map(spec.nodes.map((n) => [n.id, nodeSize(n.label, n.sublabel)]));
  // Narrow (top-down) layouts wrap group labels so there is room to slide them clear of entering edges.
  const labelMax = direction === 'DOWN' ? 180 : 420;
  const groupLines = new Map(spec.groups.map((g) => [g.id, wrapText(g.label, labelMax, GROUP_LABEL)]));
  const groupLabelW = new Map(spec.groups.map((g) => [g.id, Math.ceil(GROUP_ICON + 8 + Math.max(...groupLines.get(g.id)!.map((l) => measureText(l, GROUP_LABEL))) + 4)]));
  const groupLabelH = new Map(spec.groups.map((g) => [g.id, Math.max(GROUP_ICON, groupLines.get(g.id)!.length * GROUP_LABEL.lineHeight) + 4]));
  const pad = Math.round(spacing * 0.6);
  const build = (parent: string | undefined): ElkNode[] => [
    ...spec.groups
      .filter((g) => g.parent === parent)
      .map((g) => ({
        id: g.id,
        layoutOptions: {
          'elk.padding': `[top=${groupLabelH.get(g.id)! + 8 + pad},left=${pad},bottom=${pad},right=${pad}]`,
          'elk.nodeSize.constraints': 'MINIMUM_SIZE',
          // ELK applies a compound node's minimum size in its internal (rotated) coordinates: swap for DOWN.
          // DOWN: edges enter through the top band, so leave room beside a child column for the label to slide into.
          'elk.nodeSize.minimum': direction === 'DOWN' ? `(${groupLabelH.get(g.id)! + 2 * pad}, ${groupLabelW.get(g.id)! + 2 * pad + 140})` : `(${groupLabelW.get(g.id)! + 2 * pad}, ${groupLabelH.get(g.id)! + 2 * pad})`,
        },
        children: build(g.id),
      })),
    ...spec.nodes.filter((n) => n.parent === parent).map((n) => ({ id: n.id, width: sizes.get(n.id)!.width, height: sizes.get(n.id)!.height })),
  ];
  const edges: ElkExtendedEdge[] = spec.edges.map((e) => ({
    id: e.id,
    sources: [e.source],
    targets: [e.target],
    labels: e.label ? [{ id: `${e.id}-label`, text: e.label, width: Math.ceil(measureText(e.label, EDGE_LABEL) + 12), height: EDGE_LABEL.lineHeight + 6 }] : [],
  }));
  const root: ElkNode = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.json.edgeCoords': 'ROOT',
      'elk.json.shapeCoords': 'ROOT',
      'elk.spacing.nodeNode': String(spacing),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.round(spacing * 1.4)),
      'elk.spacing.edgeNode': String(Math.round(spacing * 0.5)),
      'elk.spacing.edgeEdge': String(Math.round(spacing * 0.4)),
      'elk.spacing.edgeLabel': '6',
      'elk.spacing.labelLabel': '6',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.layered.edgeLabels.centerLabelPlacementStrategy': 'SPACE_EFFICIENT_LAYER',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.padding': `[top=${pad},left=${pad},bottom=${pad},right=${pad}]`,
    },
    children: build(undefined),
    edges,
  });

  const nodes: LaidOutNode[] = [];
  const groups: LaidOutGroup[] = [];
  const specGroups = new Map(spec.groups.map((g) => [g.id, g]));
  const specNodes = new Map(spec.nodes.map((n) => [n.id, n]));
  const walk = (list: ElkNode[] | undefined, depth: number) => {
    for (const c of list ?? []) {
      const r = { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0 };
      const g = specGroups.get(c.id);
      if (g) {
        groups.push({ ...r, id: g.id, kind: g.kind, label: g.label, labelLines: groupLines.get(g.id)!, depth, labelBox: { x: r.x + 6, y: r.y + 4, width: groupLabelW.get(g.id)!, height: groupLabelH.get(g.id)! } });
        walk(c.children, depth + 1);
      } else {
        const n = specNodes.get(c.id)!;
        const s = sizes.get(c.id)!;
        nodes.push({ ...r, id: n.id, icon: n.icon, lines: s.lines, sublines: s.sublines });
      }
    }
  };
  walk(root.children, 0);
  const specEdges = new Map(spec.edges.map((e) => [e.id, e]));
  const laidEdges: LaidOutEdge[] = (root.edges ?? []).map((e) => {
    const s = specEdges.get(e.id)!;
    const sec = e.sections?.[0];
    const points = sec ? [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint] : [];
    const l = e.labels?.[0];
    return { id: e.id, source: s.source, target: s.target, points, label: s.label, labelBox: l ? { x: l.x ?? 0, y: l.y ?? 0, width: l.width ?? 0, height: l.height ?? 0 } : undefined, status: s.status ?? 'neutral' };
  });
  return { width: root.width ?? 0, height: root.height ?? 0, nodes, groups, edges: laidEdges };
}

/**
 * Label Placement: slide each group label along its top band to the first spot no edge segment passes through.
 */
export function placeGroupLabels(layout: Pick<DiagramLayout, 'groups' | 'edges'>) {
  const segs = layout.edges.flatMap((e) => segments(e.points));
  for (const g of layout.groups) {
    const box = g.labelBox;
    const free = (x: number) => !segs.some(([a, b]) => segmentHitsRect(a, b, { ...box, x: x - 4, width: box.width + 8 }));
    for (let x = g.x + 6; x + box.width <= g.x + g.width - 6; x += 2) {
      if (free(x)) {
        box.x = x;
        break;
      }
    }
  }
}

/** Lay out the spec; if anything collides, retry with more spacing (up to `maxAttempts`). */
export type Direction = 'RIGHT' | 'DOWN';

export async function layoutDiagram(spec: DiagramSpec, { direction = 'RIGHT', maxAttempts = 5 }: { direction?: Direction; maxAttempts?: number } = {}): Promise<DiagramLayout> {
  let spacing = 36;
  let best: DiagramLayout | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const laid = await runElk(spec, spacing, direction);
    placeGroupLabels(laid);
    const collisions = findCollisions(spec, laid);
    const result = { ...laid, collisions, attempts: attempt };
    if (!collisions.length) return result;
    if (!best || collisions.length < best.collisions.length) best = result;
    spacing = Math.round(spacing * 1.4);
  }
  return best!;
}
