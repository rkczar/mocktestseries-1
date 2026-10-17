import "server-only";
import { getUsdInr } from "@/lib/ai-engine/fx";
import { usdToInr } from "@/lib/ai-engine/config";
import { IMAGE_TOKENS, loadModels, modelProblem } from "@/lib/ai-import/ai";
import type { ImporterSettings, ImporterTask } from "@/lib/ai-import/config";
import type { FileFacts } from "@/lib/ai-import/analyze";

/**
 * Pre-processing cost estimate from the CURRENT catalog prices (Admin → AI →
 * Models, synced from OpenRouter) and the current USD→INR rate. It is an
 * ESTIMATE: actual cost is what the provider reports per call (Cost Center).
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
}

export interface CostEstimate {
  lines: EstimateLine[];
  totalUsd: number | null;
  totalInr: number | null;
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

export async function estimateJobCost(input: { paperFacts: FileFacts[]; keyFacts: FileFacts[]; settings: ImporterSettings }): Promise<CostEstimate> {
  const { settings } = input;
  const fx = await getUsdInr();
  const m = settings.models;
  const catalog = await loadModels([m.extract, m.verify, m.classify, m.key ?? m.extract].filter((x): x is string => !!x));
  const notes: string[] = [];

  let pagesNeedingAi = 0;
  let extractIn = 0;
  let extractOut = 0;
  let scannedPages = 0;
  let expectedQuestions = 0;
  for (const f of input.paperFacts) {
    const qpp = f.textPages ? Math.max(2, Math.round(f.localQuestionCount / Math.max(1, f.textPages))) : 5;
    for (const p of f.pagesDetail) {
      if (p.kind === "DOCUMENT") continue;
      const aiNeeded = p.kind === "SCANNED" || p.risk.length > 0 || p.images > 0 || (p.kind === "TEXT" && p.localQuestions === 0);
      const q = p.kind === "SCANNED" ? qpp : Math.max(p.localQuestions, 1);
      expectedQuestions += p.kind === "BLANK" ? 0 : q;
      if (!aiNeeded) continue;
      pagesNeedingAi++;
      if (p.kind === "SCANNED") scannedPages++;
      extractIn += SYSTEM_TOKENS + IMAGE_TOKENS + Math.ceil(Math.min(p.textChars * 1.3, 12_000) / 3) + 120;
      extractOut += 400 + 350 * q;
    }
    if (f.kind === "DOCX" || f.kind === "XLSX" || f.kind === "CSV") expectedQuestions += f.localQuestionCount;
  }
  const keyPages = input.keyFacts.reduce((a, f) => a + f.scannedPages, 0);

  const price = (id: string | null, vision: boolean) => {
    if (!id) return { model: null, problem: "not configured in Import Settings", p: null as { prompt: number; completion: number } | null };
    const row = catalog.get(id);
    const problem = modelProblem(row, vision);
    if (problem || !row) return { model: id, problem, p: null };
    return { model: id, problem: null, p: { prompt: row.promptPrice!, completion: Math.max(row.completionPrice!, row.reasoningPrice ?? 0) } };
  };
  const line = (task: ImporterTask, label: string, id: string | null, vision: boolean, calls: number, inTok: number, outTok: number): EstimateLine => {
    const pr = price(id, vision);
    const usd = pr.p ? inTok * pr.p.prompt + outTok * pr.p.completion : null;
    return { task, label, model: pr.model, calls, inputTokens: inTok, outputTokens: outTok, usd, inr: usdToInr(usd, fx.rate), pricePerM: pr.p ? { prompt: pr.p.prompt * 1e6, completion: pr.p.completion * 1e6 } : null, problem: calls ? pr.problem : null };
  };

  const lines: EstimateLine[] = [];
  lines.push(line("extract", "Page extraction (vision)", m.extract, true, pagesNeedingAi, extractIn, extractOut));
  const lowConfidencePages = scannedPages;
  if (m.verify && lowConfidencePages) {
    const per = pagesNeedingAi ? { i: extractIn / pagesNeedingAi, o: extractOut / pagesNeedingAi } : { i: 0, o: 0 };
    lines.push(line("verify", "Second read of scanned pages (different model)", m.verify, true, lowConfidencePages, Math.round(per.i * lowConfidencePages), Math.round(per.o * lowConfidencePages)));
  }
  if (settings.verification.independentAnswer) {
    lines.push(line("verify", "Independent answer opinion (per question)", m.verify, false, expectedQuestions, expectedQuestions * 600, expectedQuestions * 250));
  }
  const classifyCalls = Math.ceil(expectedQuestions / 20);
  lines.push(line("classify", "Topic classification (20 questions per call)", m.classify, false, classifyCalls, classifyCalls * (SYSTEM_TOKENS + 20 * 250 + 3_500), classifyCalls * 900));
  if (keyPages) lines.push(line("key", "Scanned answer-key pages", m.key ?? m.extract, true, keyPages, keyPages * (SYSTEM_TOKENS + IMAGE_TOKENS + 200), keyPages * 1_200));

  const active = lines.filter((l) => l.calls > 0);
  const missing = active.filter((l) => l.usd === null);
  for (const l of missing) notes.push(`${l.label}: ${l.problem ?? "no price"} — these calls will not run; the affected questions are flagged for correction instead.`);
  if (!settings.aiEnabled) notes.push("Paid AI processing is OFF (Import Settings). Only local parsing runs; pages that need AI are flagged.");
  const reservePct = 20;
  const baseUsd = active.reduce((a, l) => a + (l.usd ?? 0), 0);
  const totalUsd = active.length && missing.length < active.length ? baseUsd * (1 + reservePct / 100) : active.length ? null : 0;
  const totalInr = usdToInr(totalUsd, fx.rate);
  const pricesSyncedAt = [...catalog.values()].map((r) => r.lastSyncedAt).sort((a, b) => a.getTime() - b.getTime())[0]?.toISOString() ?? null;
  const concurrency = settings.limits.concurrency;
  return {
    lines,
    totalUsd,
    totalInr,
    reservePct,
    pagesNeedingAi,
    perPageInr: totalInr !== null && pagesNeedingAi ? totalInr / pagesNeedingAi : null,
    perQuestionInr: totalInr !== null && expectedQuestions ? totalInr / expectedQuestions : null,
    expectedQuestions,
    fxRate: fx.rate,
    fxDate: fx.rateDate,
    pricesSyncedAt,
    aiEnabled: settings.aiEnabled,
    estimatedMinutes: Math.max(1, Math.ceil((pagesNeedingAi * 30) / concurrency / 60 + (input.paperFacts.reduce((a, f) => a + f.pages, 0) * 2) / 60)),
    notes,
    computedAt: new Date().toISOString(),
  };
}
