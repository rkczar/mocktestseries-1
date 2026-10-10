import { GEOMETRY, estimateLines, plainText } from "@/lib/instagram/layout";
import { DIAGRAM_LIMITS, type DiagramSpec } from "@/lib/instagram/types";

/**
 * Medical concept diagrams: validation + deterministic layout of a structured
 * DiagramSpec. The AI only proposes the spec (labels, steps, rows); every box,
 * arrow and label is placed here and drawn by lib/instagram/render.tsx — so the
 * text on the slide is exactly the reviewed text, never an AI-drawn picture.
 * The renderer and the quality gate share this layout, so "fits" means fits.
 */

const LINE = 1.25;

export const DIAGRAM_AREA = {
  titleH: 64,
  footH: 44,
  get width() {
    return GEOMETRY.contentWidth;
  },
  get height() {
    return GEOMETRY.bodyHeight - this.titleH - this.footH;
  },
};

/** Every problem with a diagram, as admin-readable messages (empty = valid). */
export function checkDiagram(d: DiagramSpec): string[] {
  const L = DIAGRAM_LIMITS;
  const errs: string[] = [];
  const cap = (what: string, v: string, max: number) => {
    if (v.length > max) errs.push(`${what} is too long (${v.length}/${max}).`);
  };
  if (!d.title) errs.push("The diagram needs a title.");
  cap("Title", d.title, L.title);
  cap("Footnote", d.footnote, L.footnote);
  switch (d.kind) {
    case "mechanism":
    case "flowchart":
    case "hub": {
      const min = d.kind === "hub" ? 3 : 2;
      if (d.nodes.length < min) errs.push(`A ${d.kind === "hub" ? "concept map" : d.kind} needs at least ${min} boxes.`);
      if (d.nodes.length > L.nodes) errs.push(`At most ${L.nodes} boxes.`);
      const ids = new Set<string>();
      for (const n of d.nodes) {
        if (ids.has(n.id)) errs.push(`Box id "${n.id}" is used twice.`);
        ids.add(n.id);
        cap(`Box "${n.label.slice(0, 20)}"`, n.label, L.label);
        if (n.note) cap(`Note on "${n.label.slice(0, 20)}"`, n.note, L.note);
      }
      if (d.kind === "flowchart") {
        if (d.edges.length > L.edges) errs.push(`At most ${L.edges} arrows.`);
        for (const e of d.edges) {
          if (!ids.has(e.from) || !ids.has(e.to)) errs.push(`Arrow ${e.from} → ${e.to} points to a box that doesn't exist.`);
          if (e.label) cap("Arrow label", e.label, 24);
        }
        if (d.edges.length && flowLayers(d) === null) errs.push("The flowchart must flow top to bottom without loops, with at most 3 boxes per level and 5 levels.");
      }
      break;
    }
    case "comparison":
    case "ddx": {
      if (d.columns.length < 3 || d.columns.length > L.columns + 1) errs.push(`A table needs a first (row label) column plus 2–${L.columns} compared columns.`);
      if (d.rows.length < 2 || d.rows.length > L.rows) errs.push(`A table needs 2–${L.rows} rows.`);
      for (const c of d.columns) cap("Column header", c, 30);
      for (const r of d.rows) {
        cap(`Row "${r.label.slice(0, 20)}"`, r.label, 30);
        if (r.cells.length !== d.columns.length - 1) errs.push(`Row "${r.label.slice(0, 20)}" must have ${d.columns.length - 1} cells.`);
        for (const c of r.cells) cap(`Cell in "${r.label.slice(0, 20)}"`, c, L.cell);
      }
      break;
    }
    case "venn": {
      if (d.sets.length < 2 || d.sets.length > 3) errs.push("A Venn diagram has 2 or 3 sets.");
      for (const s of d.sets) {
        cap("Set name", s.label, 28);
        if (s.items.length > L.setItems) errs.push(`Set "${s.label.slice(0, 20)}" has more than ${L.setItems} items.`);
        for (const i of s.items) cap("Venn item", i, L.item);
      }
      if (d.overlap.length > L.setItems) errs.push(`At most ${L.setItems} shared items.`);
      for (const i of d.overlap) cap("Shared item", i, L.item);
      if (!d.overlap.length) errs.push("A Venn diagram needs at least one shared item in the overlap.");
      break;
    }
  }
  return errs;
}

/** All visible text of a diagram (for safety and glyph checks). */
export function diagramTexts(d: DiagramSpec): string[] {
  return [
    d.title,
    d.footnote,
    ...d.nodes.flatMap((n) => [n.label, n.note ?? ""]),
    ...d.edges.map((e) => e.label ?? ""),
    ...d.columns,
    ...d.rows.flatMap((r) => [r.label, ...r.cells]),
    ...d.sets.flatMap((s) => [s.label, ...s.items]),
    ...d.overlap,
  ].filter(Boolean);
}

// ---- Layout --------------------------------------------------------------------------

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  note?: string;
  size: number;
  noteSize: number;
  /** 0 = first/centre box. */
  index: number;
}

export interface Arrow {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
}

export type DiagramLayout =
  | { kind: "boxes"; boxes: Box[]; arrows: Arrow[]; overflow: boolean }
  | { kind: "table"; colW: number[]; rowH: number[]; headerH: number; size: number; overflow: boolean }
  | { kind: "venn"; circles: { cx: number; cy: number; r: number; label: string; labelX: number; labelY: number; items: string[]; itemsX: number; itemsY: number; itemsW: number }[]; overlap: { x: number; y: number; w: number; items: string[] }; size: number; overflow: boolean };

/** Height the text needs at `size` inside a box of inner width `w`. */
function boxTextHeight(label: string, note: string | undefined, size: number, w: number) {
  const noteSize = Math.max(20, Math.round(size * 0.72));
  const l = estimateLines(label, size, w, "bold") * size * LINE;
  const n = note ? estimateLines(note, noteSize, w) * noteSize * LINE + 6 : 0;
  return { h: l + n, noteSize };
}

function fitBox(label: string, note: string | undefined, w: number, h: number, max = 38, min = 22) {
  const inner = w - 36;
  for (let s = max; s >= min; s -= 2) {
    const t = boxTextHeight(label, note, s, inner);
    if (t.h <= h - 24) return { size: s, noteSize: t.noteSize, overflow: false };
  }
  const t = boxTextHeight(label, note, min, inner);
  return { size: min, noteSize: t.noteSize, overflow: true };
}

/** Longest-path layering for a flowchart; null when it has a loop or a level is too wide/deep. */
export function flowLayers(d: DiagramSpec): string[][] | null {
  const ids = d.nodes.map((n) => n.id);
  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const e of d.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  const depth = new Map<string, number>();
  const queue = ids.filter((id) => (incoming.get(id) ?? 0) === 0);
  for (const id of queue) depth.set(id, 0);
  const remaining = new Map(incoming);
  let processed = 0;
  while (queue.length) {
    const id = queue.shift()!;
    processed++;
    for (const e of d.edges.filter((x) => x.from === id)) {
      depth.set(e.to, Math.max(depth.get(e.to) ?? 0, (depth.get(id) ?? 0) + 1));
      remaining.set(e.to, (remaining.get(e.to) ?? 0) - 1);
      if (remaining.get(e.to) === 0) queue.push(e.to);
    }
  }
  if (processed !== ids.length) return null;
  const layers: string[][] = [];
  for (const id of ids) {
    const k = depth.get(id) ?? 0;
    (layers[k] ??= []).push(id);
  }
  if (layers.length > 5 || layers.some((l) => !l || l.length > 3)) return null;
  return layers;
}

function boxesLayout(d: DiagramSpec): DiagramLayout {
  const W = DIAGRAM_AREA.width;
  const H = DIAGRAM_AREA.height;
  const byId = new Map(d.nodes.map((n, i) => [n.id, { n, i }]));
  const boxes: Box[] = [];
  const arrows: Arrow[] = [];
  let overflow = false;

  if (d.kind === "hub") {
    const [centre, ...branches] = d.nodes;
    const cw = 360;
    const ch = 170;
    const cx = (W - cw) / 2;
    const cy = (H - ch) / 2;
    const f = fitBox(centre.label, centre.note, cw, ch, 40);
    overflow ||= f.overflow;
    boxes.push({ id: centre.id, x: cx, y: cy, w: cw, h: ch, label: centre.label, note: centre.note, size: f.size, noteSize: f.noteSize, index: 0 });
    const left = branches.filter((_, i) => i % 2 === 0);
    const right = branches.filter((_, i) => i % 2 === 1);
    const bw = 270;
    const place = (list: typeof branches, side: "l" | "r") => {
      const n = list.length;
      if (!n) return;
      const gap = 28;
      const bh = Math.min(230, (H - (n - 1) * gap) / n);
      const total = n * bh + (n - 1) * gap;
      list.forEach((node, k) => {
        const x = side === "l" ? 0 : W - bw;
        const y = (H - total) / 2 + k * (bh + gap);
        const fb = fitBox(node.label, node.note, bw, bh, 32);
        overflow ||= fb.overflow;
        boxes.push({ id: node.id, x, y, w: bw, h: bh, label: node.label, note: node.note, size: fb.size, noteSize: fb.noteSize, index: byId.get(node.id)!.i });
        arrows.push(side === "l" ? { x1: cx, y1: cy + ch / 2, x2: x + bw, y2: y + bh / 2 } : { x1: cx + cw, y1: cy + ch / 2, x2: x, y2: y + bh / 2 });
      });
    };
    place(left, "l");
    place(right, "r");
    return { kind: "boxes", boxes, arrows, overflow };
  }

  const layers = d.kind === "flowchart" && d.edges.length ? flowLayers(d) : d.nodes.map((n) => [n.id]);
  if (!layers) return { kind: "boxes", boxes: [], arrows: [], overflow: true };
  const gapY = 50;
  const gapX = 28;
  const bh = Math.min(200, (H - (layers.length - 1) * gapY) / layers.length);
  const pos = new Map<string, Box>();
  layers.forEach((layer, li) => {
    const k = layer.length;
    const bw = k === 1 ? Math.min(W, 760) : (W - (k - 1) * gapX) / k;
    const rowW = k * bw + (k - 1) * gapX;
    layer.forEach((id, j) => {
      const { n, i } = byId.get(id)!;
      const x = (W - rowW) / 2 + j * (bw + gapX);
      const y = li * (bh + gapY);
      const f = fitBox(n.label, n.note, bw, bh, k === 1 ? 38 : 32);
      overflow ||= f.overflow;
      const b: Box = { id, x, y, w: bw, h: bh, label: n.label, note: n.note, size: f.size, noteSize: f.noteSize, index: i };
      pos.set(id, b);
      boxes.push(b);
    });
  });
  const edges = d.kind === "flowchart" && d.edges.length ? d.edges : d.nodes.slice(1).map((n, i) => ({ from: d.nodes[i].id, to: n.id, label: undefined as string | undefined }));
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    arrows.push({ x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y, label: e.label });
  }
  return { kind: "boxes", boxes, arrows, overflow };
}

function tableLayout(d: DiagramSpec): DiagramLayout {
  const W = DIAGRAM_AREA.width;
  const H = DIAGRAM_AREA.height;
  const n = d.columns.length;
  const first = n === 3 ? 0.3 : 0.26;
  const colW = [W * first, ...Array.from({ length: n - 1 }, () => (W * (1 - first)) / (n - 1))];
  for (let size = 30; size >= 20; size -= 2) {
    const cellH = (text: string, w: number, bold = false) => estimateLines(text || " ", size, w - 28, bold ? "bold" : "medium") * size * LINE + 26;
    const headerH = Math.max(...d.columns.map((c, i) => cellH(c, colW[i], true)));
    const rowH = d.rows.map((r) => Math.max(cellH(r.label, colW[0], true), ...r.cells.map((c, i) => cellH(c, colW[i + 1] ?? colW[1]))));
    const total = headerH + rowH.reduce((a, b) => a + b, 0);
    if (total <= H) {
      const extra = Math.min(40, (H - total) / Math.max(1, d.rows.length + 1));
      return { kind: "table", colW, rowH: rowH.map((h) => h + extra), headerH: headerH + extra, size, overflow: false };
    }
    if (size === 20) return { kind: "table", colW, rowH, headerH, size, overflow: true };
  }
  return { kind: "table", colW, rowH: [], headerH: 0, size: 20, overflow: true };
}

function vennLayout(d: DiagramSpec): DiagramLayout {
  const W = DIAGRAM_AREA.width;
  const H = DIAGRAM_AREA.height;
  const size = 26;
  const listH = (items: string[], w: number) => items.reduce((h, t) => h + estimateLines(t, size, w) * size * LINE + 6, 0);
  let overflow = false;
  if (d.sets.length === 2) {
    const r = 300;
    const cy = H / 2 + 20;
    const c1 = W / 2 - 180;
    const c2 = W / 2 + 180;
    const itemsW = 240;
    const circles = d.sets.map((s, i) => {
      const cx = i === 0 ? c1 : c2;
      const itemsX = i === 0 ? cx - r + 40 : cx + r - 40 - itemsW;
      const h = listH(s.items, itemsW);
      overflow ||= h > 2 * r - 160;
      return { cx, cy, r, label: s.label, labelX: cx - 200, labelY: cy - r - 56, items: s.items, itemsX, itemsY: cy - h / 2, itemsW };
    });
    const ow = 200;
    const oh = listH(d.overlap, ow);
    overflow ||= oh > 2 * r - 200;
    return { kind: "venn", circles, overlap: { x: W / 2 - ow / 2, y: cy - oh / 2, w: ow, items: d.overlap }, size, overflow };
  }
  const r = 250;
  const centres = [
    { cx: W / 2 - 150, cy: 320 },
    { cx: W / 2 + 150, cy: 320 },
    { cx: W / 2, cy: 560 },
  ];
  const itemsW = 200;
  const circles = d.sets.map((s, i) => {
    const { cx, cy } = centres[i];
    const h = listH(s.items, itemsW);
    overflow ||= h > 200;
    const itemsX = i === 0 ? cx - r + 30 : i === 1 ? cx + r - 30 - itemsW : cx - itemsW / 2;
    const itemsY = i === 2 ? cy + r - 40 - h : cy - 150;
    return { cx, cy, r, label: s.label, labelX: i === 0 ? cx - r : i === 1 ? cx + r - 400 : cx - 200, labelY: i === 2 ? cy + r + 10 : cy - r - 56, items: s.items, itemsX, itemsY, itemsW };
  });
  const ow = 160;
  const oh = listH(d.overlap, ow);
  overflow ||= oh > 150;
  return { kind: "venn", circles, overlap: { x: W / 2 - ow / 2, y: 420 - oh / 2, w: ow, items: d.overlap }, size, overflow };
}

export function diagramLayout(d: DiagramSpec): DiagramLayout {
  if (d.kind === "comparison" || d.kind === "ddx") return tableLayout(d);
  if (d.kind === "venn") return vennLayout(d);
  return boxesLayout(d);
}

/** Title line fits in one or two lines at 34px. */
export function diagramTitleOverflows(title: string): boolean {
  return estimateLines(plainText(title), 34, DIAGRAM_AREA.width, "bold") > 1;
}
