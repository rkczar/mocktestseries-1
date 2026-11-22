/**
 * Importer redesign P1 — cost, budget and routing (audit 2026-11-19, area E). Pure checks: no AI, no network, no DB rows.
 *
 *  R1 the re-scan preflight prices a page read as the gateway reserves it (bilingual 10,000-token limit + bilingual
 *     prompt), and a re-scan stopped by the budget is not queued again while the budget state is unchanged.
 *  R2 Resume / Retry probe the budget with the next request's worst case (₹0 let an exhausted cap through).
 *  R3 one budget warning per budget state (fallback pricing moved to estimate.ts requestMaxPricer, verify-importer-two-step K); the job page does not repeat the approval's warning.
 *  R5 the 150 s request timeout also bounds the body read (totalDeadline).
 *  R6 answer opinions / AI classifications already paid for are found again by (content hash, model).
 *  R7 an administrator's crop of a scanned page is cut from the original scan, not the 150-dpi render.
 *
 *   /root/mts-scratch/redesign/run-suite.sh scripts/verify-ai-import-redesign-cost.ts
 */
import { readFileSync } from "node:fs";
import { usdToInr } from "@/lib/ai-engine/config";
import { PRICE_MARGIN, aiResultIndex, estimateInputTokens, pageReadOutputTokens, requestWorstInr } from "@/lib/ai-import/ai";
import { budgetBlock, budgetShortfall, budgetStateKey } from "@/lib/ai-import/budget-guard";
import { nextRequestMaxInr } from "@/lib/ai-import/jobs";
import { PROFILES, profileInputTokens, requestUsd } from "@/lib/ai-import/select";
import { EXTRACT_SYSTEM } from "@/lib/ai-import/prompts";
import { BILINGUAL_RULES } from "@/lib/ai-import/bilingual";
import { contentPartOf } from "@/lib/ai-import/verify-core";
import type { ModelPlan, TaskChoice } from "@/lib/ai-import/selection-types";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `\n      ${JSON.stringify(detail).slice(0, 400)}`}`);
}

const FX = 88;
// Synthetic gemini-like vision price (USD per token / image token).
const price = { prompt: 1.25e-6, completion: 10e-6, image: 1.25e-6, request: 0 };
const choice = (task: TaskChoice["task"], model: string, maxInr: number, candidates: TaskChoice["candidates"] = [], fallbacks: string[] = []): TaskChoice => ({ task, model, fallbacks, mode: "auto", reason: "", vision: true, price, maxUsd: null, maxInr, typicalInr: null, routes: [], privacy: { zdrRequired: false, dataCollection: "deny", zdrVerified: false }, candidates });

// ---- R1 -------------------------------------------------------------------------------------------------------------
{
  // What the plan (select.ts PROFILES, 8,000 tokens) prices vs what the gateway reserves for a bilingual page read.
  const planMax = usdToInr(requestUsd(price, profileInputTokens("extract"), PROFILES.extract.maxOut, 1) * PRICE_MARGIN, FX)!;
  const tokens = estimateInputTokens(EXTRACT_SYSTEM + BILINGUAL_RULES, [{ type: "text", text: "x".repeat(PROFILES.extract.textChars) }, { type: "image_url", image_url: { url: "" } }]);
  const gateway = requestWorstInr(price, tokens, pageReadOutputTokens(true), 1, FX);
  check("R1 bilingual page read: output limit 10,000 (process.ts aiPage), 8,000 otherwise", pageReadOutputTokens(true) === 10_000 && pageReadOutputTokens(false) === 8_000);
  check(`R1 the old preflight (plan maximum ₹${planMax.toFixed(2)}) is below the bilingual reservation (₹${gateway.toFixed(2)})`, planMax < gateway, { planMax, gateway });
  // With ₹2 left in the cap the old preflight lets the re-scan through and the gateway refuses it; the new one refuses first.
  const caps = { monthlyInr: 1500, totalInr: 290 };
  const job = { spentInr: 0, inFlightInr: 0, confirmedMaxInr: null };
  const spend = { monthInr: 0, allInr: 290 - (planMax + gateway) / 2 };
  check("R1 old preflight passes, gateway would refuse (the 23 queued-then-paused cycles)", budgetBlock({ amountInr: planMax, caps, job, spend }) === null && budgetBlock({ amountInr: gateway, caps, job, spend }) !== null);
  const k = budgetStateKey(caps, spend);
  check("R1 budget state: unchanged spend/caps → same key; new spend or raised cap → different key", k === budgetStateKey(caps, { ...spend }) && k !== budgetStateKey(caps, { ...spend, allInr: spend.allInr + 0.01 }) && k !== budgetStateKey({ ...caps, totalInr: 400 }, spend));
  const review = readFileSync("lib/ai-import/review.ts", "utf8");
  check("R1 review.ts re-scan preflight uses pageReadWorstInr + refuses an unchanged budget state", /pageReadWorstInr\(jobId, plan\.tasks\.extract, bilingual\)/.test(review) && /budgetState\b[\s\S]{0,400}RESCAN_REQUESTED/.test(review) && /pages, budgetState \}/.test(review));
}

// ---- R2 -------------------------------------------------------------------------------------------------------------
{
  const plan = { tasks: { extract: choice("extract", "a", 0.9), verify: choice("verify", "b", 0.4), key: choice("key", "c", 0.3), classify: choice("classify", "d", 0.11) } } as unknown as ModelPlan;
  check("R2 next request = the cheapest priced task (₹0.11)", nextRequestMaxInr(plan) === 0.11);
  const caps = { monthlyInr: 1500, totalInr: 290 };
  const args = { caps, job: { spentInr: 0, inFlightInr: 0, confirmedMaxInr: null }, spend: { monthInr: 0, allInr: 289.9 } };
  check("R2 ₹289.90 of ₹290 spent: the old ₹0 probe passes, the next-request probe blocks", budgetBlock({ ...args, amountInr: 0 }) === null && budgetBlock({ ...args, amountInr: nextRequestMaxInr(plan) })?.scope === "total");
  const jobs = readFileSync("lib/ai-import/jobs.ts", "utf8");
  check("R2 authorizeRemaining (Resume / Retry / Retry failed) checks the budget before queueing", /importerBudgetBlock\(job\.id, current, \{ beforeConfirmation: true, amountInr: nextRequestMaxInr\(plan\) \}\)/.test(jobs));
}

// ---- R3 -------------------------------------------------------------------------------------------------------------
{
  const same = budgetShortfall(5000, { monthlyInr: 1500, totalInr: 1500, monthUsedInr: 336, allUsedInr: 336 });
  check("R3 equal monthly / total caps: one warning, not two", same.short.length === 1, same.short);
  const total = budgetShortfall(150, { monthlyInr: 1500, totalInr: 200, monthUsedInr: 13.54, allUsedInr: 89.69 });
  check("R3 the tighter limit is the one named (total cap ₹200)", total.short.length === 1 && /₹200\.00 paid-testing cap by up to ₹39\.69/.test(total.short[0]), total.short);
  const month = budgetShortfall(150, { monthlyInr: 100, totalInr: 200, monthUsedInr: 90, allUsedInr: 89.69 });
  check("R3 the tighter limit is the one named (monthly ₹10 left)", month.short.length === 1 && /₹140\.00 more than the monthly budget left \(₹10\.00 of ₹100\.00\)/.test(month.short[0]), month.short);
  const ui = readFileSync("components/admin/ai-importer/cost-summary.tsx", "utf8");
  check("R3 the job page (confirmed maximum shown) does not repeat the approval's warning", /priced && confirmedMaxInr === undefined \? maxInr : null/.test(ui));
}

// ---- R5 -------------------------------------------------------------------------------------------------------------
{
  const ai = readFileSync("lib/ai-import/ai.ts", "utf8");
  check("R5 importerAiCall sends totalDeadline: true with its 150 s timeout", /timeoutMs: 150_000,[\s\S]{0,200}totalDeadline: true/.test(ai));
}

// ---- R6 -------------------------------------------------------------------------------------------------------------
{
  const q = (stem: string) => ({ stem, type: "SINGLE", section: "", number: 1, options: ["A", "B", "C", "D"].map((label) => ({ label, text: `opt ${label}` })) });
  const rows = [
    { data: { ...q("Drug of choice for X?"), classification: { ai: { model: "m2", status: "USED", subjectId: "s1", topicId: "t1", subTopicId: null, confidence: 0.9 } } }, editedData: null, aiAnswer: ["B"], aiAnswerModel: "m1", aiAnswerConfidence: 0.8 },
    { data: q("Older read"), editedData: q("Drug of choice for X?"), aiAnswer: ["C"], aiAnswerModel: "m1", aiAnswerConfidence: 0.2 },
    { data: { ...q("Rejected one"), classification: { ai: { model: "m2", status: "REJECTED", subjectId: "s9" } } }, editedData: null, aiAnswer: [], aiAnswerModel: null, aiAnswerConfidence: null },
  ];
  const idx = aiResultIndex(rows);
  const h = contentPartOf(q("Drug of choice for X?") as never);
  check("R6 stored opinion found by (content, model); the newest row wins", idx.opinions.get(`${h}|m1`)?.answer.join() === "B");
  check("R6 another model or changed content is not reused", !idx.opinions.has(`${h}|m3`) && !idx.opinions.has(`${contentPartOf(q("Drug of choice for Y?") as never)}|m1`));
  check("R6 a USED AI classification is reused; a REJECTED one is not", idx.classifications.get(`${h}|m2`)?.topicId === "t1" && idx.classifications.size === 1);
}

// ---- R7 -------------------------------------------------------------------------------------------------------------
{
  const review = readFileSync("lib/ai-import/review.ts", "utf8");
  check("R7 cropFigureFromPage cuts from the original scan (cropFromScan) before the render", /cropFromScan\(scan, layout, norm\.box/.test(review) && /from: fromScan \? "scan" : "render"/.test(review));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
