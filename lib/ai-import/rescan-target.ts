/**
 * Where a question-level re-scan reads (pure; no I/O). Uses only positions the importer already stored: the reader's
 * box of the whole question (`region`, page fractions 0..1) and the boxes of its neighbours. Never guesses: when the
 * position is not established, the whole page is read (the question key still filters what is saved) and the reason
 * is shown to the administrator.
 *
 *   REGION — one page, a full-width band around the question (both language columns of a bilingual page).
 *   STACK  — a question continued on the next page: the band from its start to the end of page p, stacked above
 *            page p+1 down to the next question (or the whole page) — read as ONE image so it is never cut in two.
 *   PAGES  — the whole page(s), with `why`.
 */
import type { NBox } from "@/lib/ai-import/types";

export type RescanTarget =
  | { kind: "REGION"; page: number; box: NBox; why: string }
  | { kind: "STACK"; pages: [number, number]; boxes: [NBox, NBox]; why: string }
  | { kind: "PAGES"; pages: number[]; why: string };

export interface PlacedQuestion {
  section: string;
  number: number | null;
  pages: number[];
  region?: NBox | null;
}

/** Margin around a band (page fraction): a question's box from the reader is approximate. */
export const BAND_PAD = 0.025;
/** A gap between two neighbours thinner than this cannot hold a question: the page is read instead. */
const MIN_GAP = 0.04;

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const valid = (b: NBox | null | undefined): b is NBox => !!b && [b.x, b.y, b.w, b.h].every((v) => Number.isFinite(v)) && b.w > 0.05 && b.h > 0.01 && b.y >= 0 && b.y + b.h <= 1.001;
function band(top: number, bottom: number): NBox {
  const y = clamp(top);
  return { x: 0, y, w: 1, h: clamp(bottom) - y };
}

/** The read target of a question that has a stored position (an extracted question). */
function targetOfPlaced(q: PlacedQuestion, next: PlacedQuestion | null): RescanTarget {
  if (q.pages.length === 1 && valid(q.region)) {
    return { kind: "REGION", page: q.pages[0], box: band(q.region.y - BAND_PAD, q.region.y + q.region.h + BAND_PAD), why: `the question's own position on page ${q.pages[0]}` };
  }
  if (q.pages.length === 2 && q.pages[1] === q.pages[0] + 1 && valid(q.region)) {
    const [p1, p2] = q.pages as [number, number];
    // The stored region is the part on the first page; the continuation runs down page p2 to the next question.
    const end = next && next.pages[0] === p2 && valid(next.region) ? next.region.y + BAND_PAD : 1;
    return { kind: "STACK", pages: [p1, p2], boxes: [band(q.region.y - BAND_PAD, 1), band(0, end)], why: `continued from page ${p1} to page ${p2}` };
  }
  return { kind: "PAGES", pages: q.pages, why: q.pages.length > 2 ? "the question spans more than two pages" : "no position of this question was stored, so its whole page is read" };
}

/**
 * The read target of a MISSING question (a placeholder without a position): the band between the nearest lower and
 * higher numbered questions of the same section, on the predicted page(s). Positions of both neighbours are required
 * on the page(s) concerned; otherwise the whole predicted page is read.
 */
function targetOfMissing(q: PlacedQuestion, prev: PlacedQuestion | null, next: PlacedQuestion | null): RescanTarget {
  const pages = q.pages;
  if (!pages.length) return { kind: "PAGES", pages: [], why: "no page could be established" };
  const last = (x: PlacedQuestion) => x.pages[x.pages.length - 1];
  const pp = prev && valid(prev.region) && prev.pages.length === 1 ? prev : null;
  const np = next && valid(next.region) && next.pages.length === 1 ? next : null;
  if (pages.length === 1) {
    const p = pages[0];
    // The free space between the neighbours (before the margin is added) decides whether the number can be there.
    const top = pp && last(pp) === p ? pp.region!.y + pp.region!.h : pp && last(pp) === p - 1 ? 0 : null;
    const bottom = np && np.pages[0] === p ? np.region!.y : np && np.pages[0] > p ? 1 : null;
    if (top === null || bottom === null) return { kind: "PAGES", pages: [p], why: `the neighbouring questions have no stored position on page ${p}, so the whole page is read` };
    if (bottom - top < MIN_GAP) return { kind: "PAGES", pages: [p], why: `there is no room between Q${prev?.number} and Q${next?.number} on page ${p} (the number may be printed elsewhere), so the whole page is read` };
    return { kind: "REGION", page: p, box: band(top - BAND_PAD, bottom + BAND_PAD), why: `between Q${prev?.number ?? "start"} and Q${next?.number ?? "end"} on page ${p}` };
  }
  if (pages.length === 2 && pages[1] === pages[0] + 1 && pp && np && last(pp) === pages[0] && np.pages[0] === pages[1]) {
    return { kind: "STACK", pages: [pages[0], pages[1]], boxes: [band(pp.region!.y + pp.region!.h - BAND_PAD, 1), band(0, np.region!.y + BAND_PAD)], why: `between Q${pp.number} (end of page ${pages[0]}) and Q${np.number} (top of page ${pages[1]})` };
  }
  return { kind: "PAGES", pages, why: "the missing number's position between its neighbours is not known, so the predicted page(s) are read whole" };
}

/** Neighbours in the same section: nearest lower and higher printed number among the paper's other questions. */
export function rescanTarget(q: PlacedQuestion, others: PlacedQuestion[], missing: boolean): RescanTarget {
  const same = others.filter((o) => o.section === q.section && typeof o.number === "number" && o.number !== q.number && o.pages.length);
  const prev = q.number === null ? null : same.filter((o) => o.number! < q.number!).sort((a, b) => b.number! - a.number!)[0] ?? null;
  const next = q.number === null ? null : same.filter((o) => o.number! > q.number!).sort((a, b) => a.number! - b.number!)[0] ?? null;
  return missing ? targetOfMissing(q, prev, next) : targetOfPlaced(q, next);
}

/** Pixel rectangle of a page box on an image of width × height (at least 1 px, inside the image). */
export function pixelRect(box: NBox, width: number, height: number): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.min(width - 1, Math.floor(box.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.floor(box.y * height)));
  return { left, top, width: Math.max(1, Math.min(width - left, Math.ceil(box.w * width))), height: Math.max(1, Math.min(height - top, Math.ceil(box.h * height))) };
}

/** One part of the image sent to the reader: page `page`, cut to `box`, placed at `top`..`top+height` (fractions of the image). */
export interface ViewPart {
  page: number;
  box: NBox;
  top: number;
  height: number;
  /** Width of the part as a fraction of the image width (parts are left-aligned). */
  width: number;
}

/** A box the reader returned on the sent image → the page it lies on and its box on that page. */
export function toPageBox(b: NBox, parts: ViewPart[]): { page: number; box: NBox } {
  const cy = b.y + b.h / 2;
  const part = parts.find((p) => cy >= p.top && cy <= p.top + p.height) ?? (cy < parts[0].top ? parts[0] : parts[parts.length - 1]);
  const ly = (b.y - part.top) / part.height;
  const lh = b.h / part.height;
  const lx = b.x / part.width;
  const lw = b.w / part.width;
  const y = clamp(part.box.y + ly * part.box.h);
  const x = clamp(part.box.x + lx * part.box.w);
  return { page: part.page, box: { x, y, w: Math.min(1 - x, lw * part.box.w), h: Math.min(1 - y, lh * part.box.h) } };
}

// ---- Missing-question placeholder rows ---------------------------------------------------------------

export interface SlotQuestion {
  fileId: string;
  section: string;
  number: number | null;
  pages: number[];
  status: string;
}
export interface MissingSlot {
  fileId: string;
  section: string;
  number: number;
  /** Where the number must be printed (between its neighbours' pages); empty = not established. */
  pages: number[];
  label: string;
}

/** More gaps than this in one numbering run is not a reliable "missing question" signal (failed pages, misread numbering). */
export const MAX_SLOTS_PER_RUN = 40;

/**
 * Missing numbers of each paper file and numbering run (a run that restarts at 1 is its own section, S2, S3 …), with the
 * page(s) where each must be printed. Never a placeholder when the numbering of a run repeats (the numbers are not
 * reliable), before the first number of a run that starts late (Q101… = an intentionally continued numbering), or for
 * a number that has a row in any status (rejected and withdrawn questions are found, not missing). The expected count
 * extends a single run only.
 */
export function missingSlots(qs: SlotQuestion[], expected: number | null, pageCount: Map<string, number>, gapPagesOf: (found: { number: number; pages: number[] }[], expected: number | null, pageCount: number) => Map<number, number[]>): { slots: MissingSlot[]; notes: string[] } {
  const groups = new Map<string, SlotQuestion[]>();
  for (const q of qs) {
    if (q.number === null) continue;
    const k = `${q.fileId}|${q.section}`;
    groups.set(k, [...(groups.get(k) ?? []), q]);
  }
  const slots: MissingSlot[] = [];
  const notes: string[] = [];
  const single = groups.size === 1;
  for (const g of groups.values()) {
    const { fileId, section } = g[0];
    const name = section ? `section ${section}` : "the paper";
    const live = g.filter((q) => q.status !== "REJECTED");
    const nums = live.map((q) => q.number!);
    if (new Set(nums).size !== nums.length) {
      notes.push(`Numbering repeats in ${name}: missing numbers are not shown as rows until the repeated numbers are resolved.`);
      continue;
    }
    const all = new Set(g.map((q) => q.number!));
    const min = Math.min(...all);
    const max = Math.max(...all);
    const start = min <= 5 ? 1 : min;
    if (start > 1) notes.push(`${name[0].toUpperCase()}${name.slice(1)} starts at Q${min}: numbers before it are not treated as missing.`);
    const upTo = single && expected && expected > max && expected <= 1000 ? expected : max;
    const gaps: number[] = [];
    for (let n = start; n <= upTo; n++) if (!all.has(n)) gaps.push(n);
    if (!gaps.length) continue;
    if (gaps.length > MAX_SLOTS_PER_RUN) {
      notes.push(`${gaps.length} numbers are missing in ${name} — too many to be single missed questions; check the failed / unread pages first.`);
      continue;
    }
    const found = g.filter((q) => q.pages.length).map((q) => ({ number: q.number!, pages: q.pages }));
    const where = gapPagesOf(found, upTo, pageCount.get(fileId) ?? 0);
    const pagesOf = new Map<number, number[]>();
    for (const [p, ns] of where) for (const n of ns) pagesOf.set(n, [...(pagesOf.get(n) ?? []), p].sort((a, b) => a - b));
    for (const n of gaps) slots.push({ fileId, section, number: n, pages: pagesOf.get(n) ?? [], label: `${section ? `${section} ` : ""}Q${n}` });
  }
  return { slots, notes };
}
