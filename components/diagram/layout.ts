import type { DiagramNode } from "@/lib/diagram/types";

export interface LayoutNode extends DiagramNode {
  x: number;
  y: number;
}

export interface LaneInfo {
  key: string;
  label: string;
  x: number;
}

export const NODE_WIDTH = 210;
export const NODE_HEIGHT = 60;
export const LANE_WIDTH = 270;
const NODE_GAP = 18;
const LANE_PADDING_TOP = 56;

const SITEMAP_LANES = [
  "Public Website",
  "Authentication",
  "Student Area",
  "Test Player",
  "Admin Area",
  "AI",
  "API / Backend",
];

// User Flow groups the same nodes by where they sit in the journey a person actually takes,
// rather than by code section — several sections collapse into the same stage.
const FLOW_STAGE: Record<string, string> = {
  "Public Website": "1 · Discover",
  Authentication: "2 · Sign in",
  "Test Player": "3 · Attempt",
  "Student Area": "4 · Review",
  AI: "4 · Review",
  "Admin Area": "5 · Manage",
  "API / Backend": "5 · Manage",
};
const FLOW_LANES = ["1 · Discover", "2 · Sign in", "3 · Attempt", "4 · Review", "5 · Manage"];

export type DiagramView = "sitemap" | "flow";

export function computeLayout(nodes: DiagramNode[], view: DiagramView): { positioned: LayoutNode[]; lanes: LaneInfo[] } {
  const laneKeyOf = (n: DiagramNode) => (view === "sitemap" ? n.section : (FLOW_STAGE[n.section] ?? n.section));
  const laneOrder = view === "sitemap" ? SITEMAP_LANES : FLOW_LANES;

  const grouped = new Map<string, DiagramNode[]>();
  for (const node of nodes) {
    const key = laneKeyOf(node);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(node);
  }

  const allKeys = [...laneOrder.filter((k) => grouped.has(k)), ...[...grouped.keys()].filter((k) => !laneOrder.includes(k))];

  const lanes: LaneInfo[] = [];
  const positioned: LayoutNode[] = [];

  allKeys.forEach((key, laneIndex) => {
    const x = laneIndex * LANE_WIDTH + 30;
    lanes.push({ key, label: key, x });
    const items = [...(grouped.get(key) ?? [])].sort((a, b) => {
      const rank = (n: DiagramNode) => (n.kind === "planned" ? 2 : n.kind === "missing" ? 1 : 0);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return a.label.localeCompare(b.label);
    });
    items.forEach((node, i) => {
      positioned.push({ ...node, x, y: LANE_PADDING_TOP + i * (NODE_HEIGHT + NODE_GAP) });
    });
  });

  return { positioned, lanes };
}
