import "server-only";
import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/secret-cipher";
import { SEO_SITE_URL, SeoIntelError, googleEndpoints, googleErrorText, googleFetch, type GoogleResponse } from "@/lib/seo-intel/google";
import { getIntelSettings, recordPageSpeedHistory } from "@/lib/seo-intel/history";

/**
 * PageSpeed Insights (lab, mobile + desktop) and Chrome UX Report (field Core
 * Web Vitals, origin level) for SEO Intelligence. This is the only module that
 * reads the PageSpeed API key.
 *
 * - The key (a Google Cloud API key restricted to the PageSpeed Insights + CrUX
 *   APIs and the server's IP) is installed with ops/seo/set-pagespeed-key.sh and
 *   stored AES-256-GCM encrypted in Setting "seo.pagespeed.key". It is sent ONLY in
 *   the X-goog-api-key header (googleFetch refuses a `key=` URL), never shown —
 *   admins see a short one-way fingerprint — and redacted from every error.
 * - Only this site's own pages are ever tested (googleFetch allow-list).
 * - All calls of one run go out in parallel with a 45 s cap each, so a manual run
 *   finishes inside nginx's 60 s proxy timeout.
 */

export const KEY_SETTING_KEY = "seo.pagespeed.key";
export const RESULTS_SETTING_KEY = "seo.intel.pagespeed";
const LOCK_SETTING_KEY = "seo.intel.psi-lock";
const LOCK_STALE_MS = 3 * 60_000;
export const MIN_RUN_INTERVAL_MS = 2 * 60_000;
const PSI_TIMEOUT_MS = 45_000;
const CRUX_TIMEOUT_MS = 15_000;
const API_KEY_RE = /^AIza[0-9A-Za-z_-]{35}$/;

export type Strategy = "mobile" | "desktop";

export interface FieldMetrics {
  lcpMs: number | null;
  inpMs: number | null;
  cls: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
}

export interface PsiResult {
  ok: boolean;
  at: string;
  error: string | null;
  /** Lighthouse performance score 0–100. */
  score: number | null;
  lab: { lcpMs: number | null; cls: number | null; tbtMs: number | null; fcpMs: number | null; speedIndexMs: number | null } | null;
  /** Chrome user data PageSpeed returned for this URL (or the whole origin when the URL has too little data). */
  field: (FieldMetrics & { scope: "url" | "origin"; overall: string | null }) | null;
  /** When Lighthouse actually loaded the page. */
  fetchedAt: string | null;
}

export interface CruxMetric {
  p75: number | null;
  good: number | null;
  needsImprovement: number | null;
  poor: number | null;
}

export interface CruxResult {
  ok: boolean;
  at: string;
  error: string | null;
  /** Google has too little Chrome user data for this origin/form factor. */
  noData: boolean;
  collectionPeriod: { first: string; last: string } | null;
  metrics: { lcp: CruxMetric | null; inp: CruxMetric | null; cls: CruxMetric | null; fcp: CruxMetric | null; ttfb: CruxMetric | null };
}

export interface PageSpeedState {
  lastRun: { at: string; ok: boolean; byId: string | null; source: "manual" | "scheduled"; errors: number } | null;
  pages: { path: string; mobile: PsiResult; desktop: PsiResult }[];
  crux: { phone: CruxResult; desktop: CruxResult } | null;
}

// ---- Key (ops script only writes; nothing ever returns it) ------------------------------------

interface StoredKey {
  apiKeyCipher?: string;
  setAt?: string;
}

async function readKey(): Promise<StoredKey> {
  const row = await prisma.setting.findUnique({ where: { key: KEY_SETTING_KEY } });
  return ((row?.value as StoredKey | null) ?? {}) as StoredKey;
}

const fingerprint = (key: string) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);

export async function getKeyView(): Promise<{ installed: boolean; fingerprint: string | null; setAt: string | null }> {
  const stored = await readKey();
  const key = decryptSecret(stored.apiKeyCipher);
  return { installed: Boolean(key), fingerprint: key ? fingerprint(key) : null, setAt: key ? stored.setAt ?? null : null };
}

export async function setApiKey(raw: string): Promise<{ fingerprint: string }> {
  const key = raw.trim();
  if (!API_KEY_RE.test(key)) throw new SeoIntelError("That is not a Google Cloud API key (AIza…, 39 characters).");
  const value = { apiKeyCipher: encryptSecret(key), setAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: KEY_SETTING_KEY }, create: { key: KEY_SETTING_KEY, value }, update: { value } });
  return { fingerprint: fingerprint(key) };
}

export async function clearApiKey() {
  await prisma.setting.deleteMany({ where: { key: KEY_SETTING_KEY } });
}

// ---- Parsing ---------------------------------------------------------------------------------

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

function fieldFrom(exp: unknown): (FieldMetrics & { overall: string | null }) | null {
  const m = (exp as { metrics?: Record<string, { percentile?: unknown }> } | null)?.metrics;
  if (!m || typeof m !== "object") return null;
  const pct = (k: string) => num(m[k]?.percentile);
  const clsRaw = pct("CUMULATIVE_LAYOUT_SHIFT_SCORE");
  const overall = (exp as { overall_category?: unknown }).overall_category;
  return {
    lcpMs: pct("LARGEST_CONTENTFUL_PAINT_MS"),
    inpMs: pct("INTERACTION_TO_NEXT_PAINT"),
    // PageSpeed reports CLS ×100.
    cls: clsRaw === null ? null : clsRaw / 100,
    fcpMs: pct("FIRST_CONTENTFUL_PAINT_MS"),
    ttfbMs: pct("EXPERIMENTAL_TIME_TO_FIRST_BYTE"),
    overall: typeof overall === "string" ? overall.slice(0, 20) : null,
  };
}

export function parsePsi(json: Record<string, unknown> | null, at: string): PsiResult {
  const lh = (json?.lighthouseResult ?? null) as { categories?: { performance?: { score?: unknown } }; audits?: Record<string, { numericValue?: unknown }>; fetchTime?: unknown } | null;
  const score = num(lh?.categories?.performance?.score);
  const audit = (id: string) => num(lh?.audits?.[id]?.numericValue);
  const urlField = fieldFrom(json?.loadingExperience);
  const originFallback = (json?.loadingExperience as { origin_fallback?: unknown } | undefined)?.origin_fallback === true;
  const originField = fieldFrom(json?.originLoadingExperience);
  const field = urlField && !originFallback ? { ...urlField, scope: "url" as const } : originField ? { ...originField, scope: "origin" as const } : null;
  if (score === null) return { ok: false, at, error: "PageSpeed returned no performance score.", score: null, lab: null, field, fetchedAt: null };
  return {
    ok: true,
    at,
    error: null,
    score: Math.round(score * 100),
    lab: {
      lcpMs: audit("largest-contentful-paint"),
      cls: audit("cumulative-layout-shift"),
      tbtMs: audit("total-blocking-time"),
      fcpMs: audit("first-contentful-paint"),
      speedIndexMs: audit("speed-index"),
    },
    field,
    fetchedAt: typeof lh?.fetchTime === "string" ? lh.fetchTime.slice(0, 40) : null,
  };
}

function cruxDate(d: unknown): string | null {
  const x = d as { year?: unknown; month?: unknown; day?: unknown } | null;
  const y = num(x?.year);
  const m = num(x?.month);
  const dd = num(x?.day);
  return y && m && dd ? `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}` : null;
}

export function parseCrux(json: Record<string, unknown> | null, at: string): CruxResult {
  const rec = (json?.record ?? null) as { metrics?: Record<string, { percentiles?: { p75?: unknown }; histogram?: { density?: unknown }[] }>; collectionPeriod?: { firstDate?: unknown; lastDate?: unknown } } | null;
  const metric = (k: string): CruxMetric | null => {
    const m = rec?.metrics?.[k];
    if (!m) return null;
    const h = Array.isArray(m.histogram) ? m.histogram : [];
    return { p75: num(m.percentiles?.p75), good: num(h[0]?.density), needsImprovement: num(h[1]?.density), poor: num(h[2]?.density) };
  };
  const first = cruxDate(rec?.collectionPeriod?.firstDate);
  const last = cruxDate(rec?.collectionPeriod?.lastDate);
  return {
    ok: true,
    at,
    error: null,
    noData: false,
    collectionPeriod: first && last ? { first, last } : null,
    metrics: {
      lcp: metric("largest_contentful_paint"),
      inp: metric("interaction_to_next_paint"),
      cls: metric("cumulative_layout_shift"),
      fcp: metric("first_contentful_paint"),
      ttfb: metric("experimental_time_to_first_byte"),
    },
  };
}

// ---- Run ------------------------------------------------------------------------------------

const EMPTY: PageSpeedState = { lastRun: null, pages: [], crux: null };

export async function getPageSpeedState(): Promise<PageSpeedState> {
  const row = await prisma.setting.findUnique({ where: { key: RESULTS_SETTING_KEY } });
  return { ...EMPTY, ...((row?.value as Partial<PageSpeedState> | null) ?? {}) };
}

async function saveState(value: PageSpeedState) {
  const json = value as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: RESULTS_SETTING_KEY }, create: { key: RESULTS_SETTING_KEY, value: json }, update: { value: json } });
}

async function acquireLock(): Promise<boolean> {
  const create = () => prisma.setting.create({ data: { key: LOCK_SETTING_KEY, value: { at: new Date().toISOString() } } });
  try {
    await create();
    return true;
  } catch {
    const stale = await prisma.setting.deleteMany({ where: { key: LOCK_SETTING_KEY, updatedAt: { lt: new Date(Date.now() - LOCK_STALE_MS) } } });
    if (!stale.count) return false;
    try {
      await create();
      return true;
    } catch {
      return false;
    }
  }
}

/** Test mode only: a shorter PageSpeed timeout so the timeout path can be exercised quickly. */
function psiTimeout(): number {
  const t = Number(process.env.SEO_PSI_TIMEOUT_MS);
  return googleEndpoints().testMode && t >= 500 && t <= PSI_TIMEOUT_MS ? t : PSI_TIMEOUT_MS;
}

async function callPsi(path: string, strategy: Strategy, apiKey: string): Promise<PsiResult> {
  const at = new Date().toISOString();
  const url = new URL(googleEndpoints().pagespeed);
  url.searchParams.set("url", `${SEO_SITE_URL}${path}`);
  url.searchParams.set("strategy", strategy);
  url.searchParams.set("category", "performance");
  let r: GoogleResponse;
  try {
    r = await googleFetch(url.toString(), { method: "GET", apiKey, timeoutMs: psiTimeout() });
  } catch (err) {
    return { ok: false, at, error: err instanceof SeoIntelError ? err.message : "PageSpeed request failed.", score: null, lab: null, field: null, fetchedAt: null };
  }
  if (r.status !== 200) return { ok: false, at, error: googleErrorText(r, [apiKey]), score: null, lab: null, field: null, fetchedAt: null };
  return parsePsi(r.json, at);
}

async function callCrux(formFactor: "PHONE" | "DESKTOP", apiKey: string): Promise<CruxResult> {
  const at = new Date().toISOString();
  const empty = { lcp: null, inp: null, cls: null, fcp: null, ttfb: null };
  let r: GoogleResponse;
  try {
    r = await googleFetch(googleEndpoints().crux, {
      method: "POST",
      apiKey,
      timeoutMs: CRUX_TIMEOUT_MS,
      json: {
        origin: SEO_SITE_URL,
        formFactor,
        metrics: ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift", "first_contentful_paint", "experimental_time_to_first_byte"],
      },
    });
  } catch (err) {
    return { ok: false, at, error: err instanceof SeoIntelError ? err.message : "Chrome UX Report request failed.", noData: false, collectionPeriod: null, metrics: empty };
  }
  // 404 = Google has too little Chrome user data for this origin: not an error.
  if (r.status === 404) return { ok: true, at, error: null, noData: true, collectionPeriod: null, metrics: empty };
  if (r.status !== 200) return { ok: false, at, error: googleErrorText(r, [apiKey]), noData: false, collectionPeriod: null, metrics: empty };
  return parseCrux(r.json, at);
}

export type PageSpeedRunResult = { ok: boolean; skipped?: boolean; message: string; errors: number };

/** One PageSpeed + CrUX run (MASTER_ADMIN check / auto-sync switch are the caller's job). */
export async function runPageSpeed(adminId: string | null, source: "manual" | "scheduled" = "manual"): Promise<PageSpeedRunResult> {
  const previous = await getPageSpeedState();
  if (previous.lastRun && Date.now() - new Date(previous.lastRun.at).getTime() < MIN_RUN_INTERVAL_MS) {
    return { ok: false, skipped: true, message: "A PageSpeed check ran less than 2 minutes ago. Please wait a moment.", errors: 0 };
  }
  const apiKey = decryptSecret((await readKey()).apiKeyCipher);
  if (!apiKey) return { ok: false, skipped: true, message: "The PageSpeed API key is not installed (ops/seo/set-pagespeed-key.sh).", errors: 0 };
  if (!(await acquireLock())) return { ok: false, skipped: true, message: "A PageSpeed check is already running.", errors: 0 };
  try {
    const paths = (await getIntelSettings()).pagespeedPaths;
    const [pageResults, phone, desktop] = await Promise.all([
      // Every page × strategy in parallel: the whole run stays inside one 45 s window.
      Promise.all(
        paths.map(async (path) => {
          const [mobile, desktop] = await Promise.all([callPsi(path, "mobile", apiKey), callPsi(path, "desktop", apiKey)]);
          return { path, mobile, desktop };
        })
      ),
      callCrux("PHONE", apiKey),
      callCrux("DESKTOP", apiKey),
    ]);
    const errors = pageResults.reduce((n, p) => n + (p.mobile.ok ? 0 : 1) + (p.desktop.ok ? 0 : 1), 0) + (phone.ok ? 0 : 1) + (desktop.ok ? 0 : 1);
    const at = new Date();
    await saveState({ lastRun: { at: at.toISOString(), ok: errors === 0, byId: adminId, source, errors }, pages: pageResults, crux: { phone, desktop } });
    try {
      const home = pageResults.find((p) => p.path === "/") ?? pageResults[0];
      await recordPageSpeedHistory(
        {
          path: home?.path ?? "/",
          mobile: home?.mobile.score ?? null,
          desktop: home?.desktop.score ?? null,
          cruxLcpP75Phone: phone.metrics.lcp?.p75 ?? null,
          cruxInpP75Phone: phone.metrics.inp?.p75 ?? null,
          cruxClsP75Phone: phone.metrics.cls?.p75 ?? null,
        },
        at
      );
    } catch {
      console.error("[seo-intel] pagespeed history step failed");
    }
    return { ok: errors === 0, message: errors === 0 ? "PageSpeed check complete." : `PageSpeed check finished with ${errors} error${errors === 1 ? "" : "s"}.`, errors };
  } finally {
    await prisma.setting.deleteMany({ where: { key: LOCK_SETTING_KEY } });
  }
}
