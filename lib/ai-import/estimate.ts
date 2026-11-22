import "server-only";
import { getUsdInr } from "@/lib/ai-engine/fx";
import { usdToInr } from "@/lib/ai-engine/config";
import { IMAGE_TOKENS, PRICE_MARGIN, REQUEST_ATTEMPTS, inputImagePriceUsd, loadModels } from "@/lib/ai-import/ai";
import { requestUsd } from "@/lib/ai-import/select";
import type { PlanPrice } from "@/lib/ai-import/selection-types";
import { OPINION_TOKENS_REASONING, type ImporterSettings, type ImporterTask, type SelectionTask, type VerifyMode } from "@/lib/ai-import/config";
import type { FileFacts } from "@/lib/ai-import/analyze";
import type { ModelPlan } from "@/lib/ai-import/selection-types";
import { CLASSIFY_BATCH } from "@/lib/ai-import/prompts";

/**
 * Pre-processing cost estimate from the job's model plan (lib/ai-import/select.ts:
 * the highest current OpenRouter price over the routes each model may use) and
 * the plan's USD→INR rate. `totalInr` is the typical ESTIMATE; `maxInr` is the
 * conservative MAXIMUM — every possible request at the reserved worst case
 * (full output limit, second reads of every AI page, REQUEST_ATTEMPTS sends per
 * request, and REQUEST_ATTEMPTS sends to a fallback model priced at the plan's
 * actual next model — ai.ts importerAiCall / importerAiCallChecked).
 * Actual cost is what the provider reports per call (Cost Center).
 */

export interface EstimateLine {
  task: ImporterTask;
  label: string;
  model: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  inr: number | null;
  /** USD per million tokens used for this line. */
  pricePerM: { prompt: number; completion: number } | null;
  problem: string | null;
  /** Conservative maximum of this line: calls (worst case) × the reserved maximum per request. */
  maxCalls: number;
  maxInr: number | null;
}

export interface CostEstimate {
  lines: EstimateLine[];
  totalUsd: number | null;
  totalInr: number | null;
  /** Conservative maximum (₹) of every request this job may make; null when a line cannot be priced. */
  maxInr: number | null;
  /** The automatic (or manual) model choice per task, with reasons. */
  plan: ModelPlan | null;
  /** 20% reserve for retries / fallbacks / longer answers. */
  reservePct: number;
  pagesNeedingAi: number;
  perPageInr: number | null;
  perQuestionInr: number | null;
  expectedQuestions: number;
  fxRate: number | null;
  fxDate: string | null;
  pricesSyncedAt: string | null;
  aiEnabled: boolean;
  estimatedMinutes: number;
  notes: string[];
  computedAt: string;
}

const SYSTEM_TOKENS = 1_100;
/** Output limit of each kind of request, as sent (process.ts, paper-verify.ts, post.ts, keys.ts): the per-call worst case. */
export const MAX_OUT = { extract: 10_000, verifyPage: 8_000, opinion: OPINION_TOKENS_REASONING, classify: 2_500, key: 6_000 } as const;

/**
 * Maximum (₹) of ONE importer request of a role, at CURRENT catalog prices: REQUEST_ATTEMPTS sends to the job's model +
 * one send to each other model of the role's chain (ai.ts importerAiCall → chainCall), every send with this request's
 * own input tokens and output limit — a per-question answer opinion is never priced like a page-image read.
 */
export async function requestMaxPricer(settings: ImporterSettings, plan: ModelPlan | null, fxRate: number | null) {
  const chainModels = (sel: SelectionTask) => (settings.fallbackChains?.[sel as keyof typeof settings.fallbackChains] ?? []).map((e) => e.model);
  const roles: SelectionTask[] = ["extract", "verify", "classify", "key"];
  const rows = await loadModels([...new Set(roles.flatMap((t) => [...chainModels(t), plan?.tasks[t]?.model ?? ""]).filter(Boolean))]);
  const price = (id: string, vision: boolean): PlanPrice | null => {
    const m = rows.get(id);
    if (!m || m.promptPrice === null || m.completionPrice === null || (vision && !m.inputModalities.includes("image"))) return null;
    return { prompt: m.promptPrice, completion: Math.max(m.completionPrice, m.reasoningPrice ?? 0), image: vision ? (inputImagePriceUsd(m) ?? 0) : 0, request: m.requestPrice ?? 0 };
  };
  const perRequest = (sel: SelectionTask, vision: boolean, inputTokens: number, maxOut: number): number | null => {
    const c = plan?.tasks[sel];
    // The dearer of the current catalog price and the plan's confirmed route price (requests may use any route up to it).
    const cat = c?.model ? price(c.model, vision) : null;
    if (!c?.price) return null;
    const pr = cat ? { prompt: Math.max(cat.prompt, c.price.prompt), completion: Math.max(cat.completion, c.price.completion), image: Math.max(cat.image, vision ? c.price.image : 0), request: Math.max(cat.request, c.price.request) } : c.price;
    if (!c?.model || !pr || fxRate === null) return null;
    const worst = (p: PlanPrice) => usdToInr(requestUsd(p, inputTokens, maxOut, vision ? 1 : 0) * PRICE_MARGIN, fxRate) ?? 0;
    const chain = chainModels(sel).filter((id) => id !== c.model).map((id) => price(id, vision)).filter((p): p is PlanPrice => p !== null);
    // No chain: the one-model switch after an unusable answer (REQUEST_ATTEMPTS sends, never pricier by default).
    const fallback = chain.length ? chain.reduce((a, p) => a + worst(p), 0) : REQUEST_ATTEMPTS * worst(pr);
    return REQUEST_ATTEMPTS * worst(pr) + fallback;
  };
  return { price, perRequest };
}

export async function estimateJobCost(input: { paperFacts: FileFacts[]; keyFacts: FileFacts[]; settings: ImporterSettings; plan: ModelPlan | null; verifyMode?: VerifyMode }): Promise<CostEstimate> {
  const { settings, plan } = input;
  const fx = plan?.fxRate ? { rate: plan.fxRate, rateDate: plan.fxDate } : await getUsdInr();
  const notes: string[] = [...(plan?.problems ?? [])];

  let pagesNeedingAi = 0;
  let extractIn = 0;
  let extractOut = 0;
  let scannedPages = 0;
  let expectedQuestions = 0;
  // "Verify every page": the second model also reads every page the local reader handled (text layer).
  let localPages = 0;
  let localIn = 0;
  let localOut = 0;
  for (const f of input.paperFacts) {
    const qpp = f.textPages ? Math.max(2, Math.round(f.localQuestionCount / Math.max(1, f.textPages))) : 5;
    for (const p of f.pagesDetail) {
      if (p.kind === "DOCUMENT") continue;
      const aiNeeded = p.kind === "SCANNED" || p.risk.length > 0 || p.images > 0 || (p.kind === "TEXT" && p.localQuestions === 0);
      const q = p.kind === "SCANNED" ? qpp : Math.max(p.localQuestions, 1);
      expectedQuestions += p.kind === "BLANK" ? 0 : q;
      if (!aiNeeded) {
        if (p.kind !== "BLANK") {
          localPages++;
          localIn += SYSTEM_TOKENS + IMAGE_TOKENS + Math.ceil(Math.min(p.textChars * 1.3, 12_000) / 3) + 120;
          localOut += 400 + 350 * q;
        }
        continue;
      }
      pagesNeedingAi++;
      if (p.kind === "SCANNED") scannedPages++;
      extractIn += SYSTEM_TOKENS + IMAGE_TOKENS + Math.ceil(Math.min(p.textChars * 1.3, 12_000) / 3) + 120;
      extractOut += 400 + 350 * q;
    }
    if (f.kind === "DOCX" || f.kind === "XLSX" || f.kind === "CSV" || f.kind === "MD") expectedQuestions += f.localQuestionCount;
  }
  const keyPages = input.keyFacts.reduce((a, f) => a + f.scannedPages, 0);

  const pricer = await requestMaxPricer(settings, plan, fx.rate);
  const line = (task: ImporterTask, sel: SelectionTask, label: string, vision: boolean, calls: number, inTok: number, outTok: number, maxCalls: number, maxOut: number): EstimateLine => {
    const c = plan?.tasks[sel];
    const model = c?.model ?? null;
    // No confirmed route price = the request cannot run ("no price"); otherwise the current catalog price.
    const pr = c?.price ? ((model ? pricer.price(model, vision) : null) ?? c.price) : null;
    const problem = !plan ? "no model plan" : !model ? c?.reason ?? "no model" : !pr ? "no price" : null;
    const usd = pr && model ? inTok * pr.prompt + outTok * pr.completion + calls * (pr.request + (vision ? IMAGE_TOKENS * pr.image : 0)) : null;
    const perRequest = pr ? pricer.perRequest(sel, vision, calls ? Math.ceil(inTok / calls) : 0, maxOut) : null;
    const maxInr = model && perRequest !== null ? maxCalls * perRequest : null;
    return { task, label, model, calls, inputTokens: inTok, outputTokens: outTok, usd, inr: usdToInr(usd, fx.rate), pricePerM: pr ? { prompt: pr.prompt * 1e6, completion: pr.completion * 1e6 } : null, problem: calls ? problem : null, maxCalls, maxInr: calls ? maxInr : 0 };
  };

  const lines: EstimateLine[] = [];
  lines.push(line("extract", "extract", "Page reading (vision; digital + scanned)", true, pagesNeedingAi, extractIn, extractOut, pagesNeedingAi, MAX_OUT.extract));
  const verifyModel = plan?.tasks.verify.model ?? null;
  // A second read runs for scanned pages and for any page whose extraction confidence is low: at most every AI page.
  if (input.verifyMode === "all" && verifyModel && pagesNeedingAi + localPages) {
    // Every page is read a second time by a different model: all AI pages plus the locally read ones.
    lines.push(line("verify", "verify", "Independent verification of every page (different model)", true, pagesNeedingAi + localPages, extractIn + localIn, extractOut + localOut, pagesNeedingAi + localPages, MAX_OUT.verifyPage));
  } else if (verifyModel && pagesNeedingAi) {
    const per = { i: extractIn / pagesNeedingAi, o: extractOut / pagesNeedingAi };
    lines.push(line("verify", "verify", "Second read of scanned / low-confidence pages (different model)", true, scannedPages, Math.round(per.i * scannedPages), Math.round(per.o * scannedPages), pagesNeedingAi, MAX_OUT.verifyPage));
  }
  if (settings.verification.independentAnswer && verifyModel) {
    lines.push(line("verify", "verify", "Independent answer opinion (per question)", false, expectedQuestions, expectedQuestions * 600, expectedQuestions * 250, expectedQuestions, MAX_OUT.opinion));
  }
  const classifyCalls = Math.ceil(expectedQuestions / CLASSIFY_BATCH);
  lines.push(line("classify", "classify", `Topic classification (${CLASSIFY_BATCH} questions per call)`, false, classifyCalls, classifyCalls * (SYSTEM_TOKENS + CLASSIFY_BATCH * 250 + 3_500), classifyCalls * 900, classifyCalls, MAX_OUT.classify));
  if (keyPages) lines.push(line("key", "key", "Scanned answer-key pages", true, keyPages, keyPages * (SYSTEM_TOKENS + IMAGE_TOKENS + 200), keyPages * 1_200, keyPages, MAX_OUT.key));

  const active = lines.filter((l) => l.calls > 0 || l.maxCalls > 0);
  const missing = active.filter((l) => l.calls > 0 && l.usd === null);
  for (const l of missing) notes.push(`${l.label}: ${l.problem ?? "no price"} — these calls will not run; the affected questions are flagged for correction instead.`);
  if (!settings.aiEnabled) notes.push("Paid AI processing is OFF (Import Settings). Only local parsing runs; pages that need AI are flagged.");
  const reservePct = 20;
  const baseUsd = active.reduce((a, l) => a + (l.usd ?? 0), 0);
  const totalUsd = active.length && missing.length < active.length ? baseUsd * (1 + reservePct / 100) : active.length ? null : 0;
  const totalInr = usdToInr(totalUsd, fx.rate);
  // Lines that cannot run add nothing to the maximum (their calls are never made).
  const runnable = active.filter((l) => l.model !== null && l.problem === null);
  const maxInr = runnable.every((l) => l.maxInr !== null) ? Math.round(runnable.reduce((a, l) => a + (l.maxInr ?? 0), 0) * 10_000) / 10_000 : null;
  const concurrency = settings.limits.concurrency;
  return {
    lines,
    totalUsd,
    totalInr,
    maxInr,
    plan,
    reservePct,
    pagesNeedingAi,
    perPageInr: totalInr !== null && pagesNeedingAi ? totalInr / pagesNeedingAi : null,
    perQuestionInr: totalInr !== null && expectedQuestions ? totalInr / expectedQuestions : null,
    expectedQuestions,
    fxRate: fx.rate,
    fxDate: fx.rateDate,
    pricesSyncedAt: plan?.routesFetchedAt ?? null,
    aiEnabled: settings.aiEnabled,
    estimatedMinutes: Math.max(1, Math.ceil((pagesNeedingAi * 30) / concurrency / 60 + (input.paperFacts.reduce((a, f) => a + f.pages, 0) * 2) / 60)),
    notes,
    computedAt: new Date().toISOString(),
  };
}
