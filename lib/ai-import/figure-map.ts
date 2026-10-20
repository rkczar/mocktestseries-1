import type { ExtractedQuestion, NBox } from "@/lib/ai-import/types";

/**
 * Deterministic checks of the reader's figure ↔ question mapping on one page (client-safe, no I/O). The
 * reader proposes a box and an owner for every figure; this module never moves a figure to another
 * question — it only decides whether the proposal can be trusted, and says why. A figure whose mapping
 * is not confirmed by the page geometry stays below the "OK" threshold (0.8), so it must be confirmed by
 * an administrator before the question can be approved.
 */

/** Confidence given to a figure whose position is confirmed by its question's own region on the page. */
export const MAPPING_CONFIRMED = 0.9;
/** Confidence of a reader proposal that the geometry could not confirm (needs an administrator). */
export const MAPPING_UNCONFIRMED = 0.75;

const area = (b: NBox) => Math.max(0, b.w) * Math.max(0, b.h);

export function overlap(a: NBox, b: NBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

function iou(a: NBox, b: NBox): number {
  const inter = overlap(a, b);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Share of the figure's area that lies inside the region (0..1). */
function inside(fig: NBox, region: NBox): number {
  const a = area(fig);
  return a > 0 ? overlap(fig, region) / a : 0;
}

/**
 * Scale of the raw boxes the reader returned for one page. The prompt asks for integers 0–1000; some
 * models answer in 0–1 fractions instead. A page whose coordinates are all ≤ 1 is read as fractions;
 * a box with a coordinate above 1000 cannot be placed (pixel coordinates of an unknown image size).
 */
export function boxScale(raw: { x: number; y: number; w: number; h: number }[]): 1 | 1000 {
  const vals = raw.flatMap((b) => [b.x, b.y, b.w, b.h]).filter((v) => Number.isFinite(v));
  return vals.length > 0 && vals.every((v) => v >= 0 && v <= 1) && vals.some((v) => v > 0) ? 1 : 1000;
}

/** Raw box → normalized 0..1 box, or the reason it cannot be used. Never stretched or guessed. */
export function normalizeBox(raw: { x: number; y: number; w: number; h: number }, scale: 1 | 1000): { box: NBox | null; problem: string | null } {
  const { x, y, w, h } = raw;
  if (![x, y, w, h].every((v) => Number.isFinite(v))) return { box: null, problem: "the figure position is not a number" };
  if (scale === 1000 && [x, y, w, h].some((v) => v > 1000 + 1)) return { box: null, problem: "the figure position is outside the page (coordinates above 1000)" };
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return { box: null, problem: "the figure position has a negative or empty size" };
  const n = { x: x / scale, y: y / scale, w: w / scale, h: h / scale };
  // A box running past the page edge is cut at the edge and reported (the crop may miss part of the figure).
  const clipped = n.x + n.w > 1.002 || n.y + n.h > 1.002;
  const box = { x: Math.min(1, n.x), y: Math.min(1, n.y), w: Math.max(0, Math.min(1, n.x + n.w) - Math.min(1, n.x)), h: Math.max(0, Math.min(1, n.y + n.h) - Math.min(1, n.y)) };
  if (box.w < 0.01 || box.h < 0.01) return { box: null, problem: "the figure box is too small to contain a figure" };
  return { box, problem: clipped ? "the figure box ran past the page edge and was cut at the edge" : null };
}

/** True for a box that covers most of the page (a whole-page "figure"). */
export function wholePage(b: NBox): boolean {
  return area(b) >= 0.6;
}

const qLabel = (q: Pick<ExtractedQuestion, "number" | "label">) => `Q${q.number ?? q.label}`;

/**
 * Checks every figure of one page against the page geometry and lowers / raises its confidence with a
 * reason. Rules (in order; the first that applies decides):
 *   1. no usable box                       → unconfirmed (the box problem is the reason)
 *   2. the same box on several questions that are not marked as sharing it → unconfirmed on each
 *   3. a box covering most of the page when the page has more than one question → unconfirmed
 *   4. the box lies inside ANOTHER question's region more than its own → unconfirmed (named)
 *   5. the box lies inside its own question's region → confirmed
 *   6. no region to compare with → unconfirmed ("could not be checked")
 * A SHARED figure is confirmed when it lies inside the region of one of the questions sharing it, or in
 * the gap directly above the first of them (the usual "Questions 2–3 refer to the figure below").
 */
export function checkFigureMapping(qs: ExtractedQuestion[]): void {
  const withBox = qs.flatMap((q) => q.figures.filter((f) => f.box).map((f) => ({ q, f, box: f.box as NBox })));
  for (const q of qs) {
    for (const f of q.figures) {
      if (!f.box) {
        if (!f.mappingReason) f.mappingReason = "No position on the page was given for this figure.";
        f.confidence = Math.min(f.confidence, 0.5);
        continue;
      }
      const box = f.box;
      const preset = f.confidence < MAPPING_UNCONFIRMED ? f.mappingReason : null;
      const set = (confidence: number, reason: string) => {
        f.confidence = preset ? Math.min(f.confidence, confidence) : confidence;
        f.mappingReason = preset ? `${preset} ${reason}` : reason;
      };
      if (f.owner === "UNASSIGNED") {
        set(Math.min(f.confidence, 0.3), "The reader did not say which part of the question this figure belongs to.");
        continue;
      }
      // 2 — one crop handed to several questions without a shared marker (e.g. the whole page on every question).
      const twins = withBox.filter((o) => o.q !== q && iou(o.box, box) >= 0.85);
      const sharedWith = new Set(twins.filter((o) => o.f.owner === "SHARED" && f.owner === "SHARED" && o.f.sharedGroup && o.f.sharedGroup === f.sharedGroup).map((o) => o.q));
      const unshared = twins.filter((o) => !sharedWith.has(o.q));
      if (unshared.length) {
        set(0.4, `The same image area was also given to ${[...new Set(unshared.map((o) => qLabel(o.q)))].join(", ")} without being marked as shared — confirm which question it belongs to.`);
        continue;
      }
      // 3 — a whole page attached to one question of a page with several questions.
      if (wholePage(box) && qs.length > 1) {
        set(0.4, "The crop covers most of the page, which holds several questions — crop only the figure of this question.");
        continue;
      }
      const own = q.region ?? null;
      const others = qs.filter((o) => o !== q && o.region && !(f.owner === "SHARED" && sharedWith.has(o)));
      const ownShare = own ? inside(box, own) : 0;
      const best = others.map((o) => ({ o, s: inside(box, o.region as NBox) })).sort((a, b) => b.s - a.s)[0];
      // 4 — the figure sits in another question's part of the page.
      if (best && best.s >= 0.5 && best.s > ownShare + 0.1) {
        set(0.35, `The figure lies inside ${qLabel(best.o)}'s part of the page, not ${qLabel(q)}'s — confirm or reassign it.`);
        continue;
      }
      // 5 — confirmed by the question's own region (or, for a shared figure, the gap just above its first question).
      if (own && ownShare >= 0.7) {
        set(MAPPING_CONFIRMED, `The figure lies inside ${qLabel(q)}'s part of the page (${Math.round(ownShare * 100)}% of its area).`);
        continue;
      }
      if (own && f.owner === "SHARED" && box.y + box.h <= own.y + 0.02 && own.y - (box.y + box.h) <= 0.12 && !(best && best.s >= 0.5)) {
        set(MAPPING_CONFIRMED, `Shared figure placed directly above ${qLabel(q)} (the questions sharing it follow it).`);
        continue;
      }
      // 6 — nothing to compare with, or only partly inside.
      set(Math.min(MAPPING_UNCONFIRMED, f.confidence || MAPPING_UNCONFIRMED), own ? `Only ${Math.round(ownShare * 100)}% of the figure lies inside ${qLabel(q)}'s part of the page — confirm it.` : "The reader did not locate the question on the page, so the figure's placement could not be checked — confirm it.");
    }
  }
}

/**
 * Page boxes the reader gave for different questions overlap a lot when it merged two questions or split
 * one; returns the pairs ("Q4/Q5") so the page can be flagged. Boxes overlapping less than 30 % are normal.
 */
export function overlappingRegions(qs: ExtractedQuestion[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < qs.length; i++)
    for (let j = i + 1; j < qs.length; j++) {
      const a = qs[i].region;
      const b = qs[j].region;
      if (!a || !b) continue;
      const smaller = Math.min(area(a), area(b));
      if (smaller > 0 && overlap(a, b) / smaller >= 0.3) out.push(`${qLabel(qs[i])}/${qLabel(qs[j])}`);
    }
  return out;
}
