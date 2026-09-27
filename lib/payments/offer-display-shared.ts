/**
 * Admin-controlled PRESENTATION of the Free vs Complete offer for one Test
 * Series (Admin → Test Series → Pricing & Access). Client-safe and pure.
 *
 * This is display copy only. Price, MRP, sale and access duration always come
 * from the canonical Product via lib/payments/pricing.ts; the "price" row can
 * be hidden or moved but its text is never editable, so this config can
 * never become a second pricing source. Rows the admin leaves on AUTO keep
 * the live value derived from the access engine (lib/mock-series.ts).
 */

export type OfferCellMode = "AUTO" | "TEXT" | "CHECK" | "CROSS";

export interface OfferCellConfig {
  mode: OfferCellMode;
  text?: string;
}

export interface OfferRowConfig {
  key: string;
  /** Feature label override; empty = the derived label. */
  feature?: string;
  free: OfferCellConfig;
  paid: OfferCellConfig;
  visible: boolean;
  highlight: boolean;
}

export interface OfferDisplayConfig {
  promoVisible: boolean;
  heading: string;
  description: string;
  ctaLabel: string;
  /** Ordered. Derived rows missing here are appended in their default order. */
  rows: OfferRowConfig[];
}

export const DEFAULT_OFFER_DISPLAY: OfferDisplayConfig = {
  promoVisible: true,
  heading: "Upgrade to Complete Access",
  description: "",
  ctaLabel: "Unlock Complete Access",
  rows: [],
};

/** A derived (live) comparison row — see getPlanComparison in lib/mock-series.ts. */
export interface PlanRow {
  key: string;
  feature: string;
  free: string;
  paid: string;
  note?: string;
}

export type OfferCellState = "check" | "cross" | "text";

export interface OfferDisplayCell {
  state: OfferCellState;
  text: string;
}

export interface OfferDisplayRow {
  key: string;
  feature: string;
  free: OfferDisplayCell;
  paid: OfferDisplayCell;
  note?: string;
  highlight: boolean;
}

/** Rows whose text is canonical data and can't be overridden (only moved/hidden). */
export const LOCKED_ROW_KEYS = new Set(["price"]);
export const CUSTOM_ROW_PREFIX = "custom-";
export const MAX_OFFER_ROWS = 40;

function autoCell(text: string): OfferDisplayCell {
  if (text === "Yes") return { state: "check", text: "Included" };
  if (text === "—" || text === "") return { state: "cross", text: "Not included" };
  return { state: "text", text };
}

function resolveCell(cfg: OfferCellConfig | undefined, derived: string | undefined): OfferDisplayCell {
  switch (cfg?.mode) {
    case "CHECK":
      return { state: "check", text: cfg.text?.trim() || "Included" };
    case "CROSS":
      return { state: "cross", text: cfg.text?.trim() || "Not included" };
    case "TEXT":
      if (cfg.text?.trim()) return { state: "text", text: cfg.text.trim() };
      break;
  }
  return derived === undefined ? { state: "cross", text: "Not included" } : autoCell(derived);
}

/**
 * Merge live rows with the admin config: admin order first, then any derived
 * row the config doesn't mention (new features appear automatically, visible).
 * Hidden rows are dropped.
 */
export function applyOfferDisplay(derived: PlanRow[], config: OfferDisplayConfig): OfferDisplayRow[] {
  const byKey = new Map(derived.map((r) => [r.key, r]));
  const seen = new Set<string>();
  const out: OfferDisplayRow[] = [];
  const push = (key: string, rc: OfferRowConfig | undefined) => {
    const d = byKey.get(key);
    const custom = key.startsWith(CUSTOM_ROW_PREFIX);
    if (!d && !custom) return; // a derived row that no longer exists
    if (rc && !rc.visible) return;
    const locked = LOCKED_ROW_KEYS.has(key);
    const feature = (!locked && rc?.feature?.trim()) || d?.feature || "";
    if (!feature) return;
    const free = locked ? autoCell(d!.free) : resolveCell(rc?.free, d?.free);
    const paid = locked ? autoCell(d!.paid) : resolveCell(rc?.paid, d?.paid);
    // Neither plan has it (e.g. no PYQs published yet): never advertise it.
    if (free.state === "cross" && paid.state === "cross") return;
    out.push({
      key,
      feature,
      free,
      paid,
      note: d?.note,
      highlight: rc?.highlight ?? false,
    });
  };
  for (const rc of config.rows) {
    if (seen.has(rc.key)) continue;
    seen.add(rc.key);
    push(rc.key, rc);
  }
  for (const d of derived) if (!seen.has(d.key)) push(d.key, undefined);
  return out;
}

/** Rows where Complete Access adds something over Free — the "major paid benefits". */
export function paidBenefits(rows: OfferDisplayRow[]): OfferDisplayRow[] {
  return rows.filter((r) => r.key !== "price" && r.paid.state !== "cross" && (r.free.state !== r.paid.state || r.free.text !== r.paid.text));
}
