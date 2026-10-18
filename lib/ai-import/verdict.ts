/**
 * AI File Analyzer verdict for the one-page importer (pure, no I/O). Turns the
 * free local analysis (lib/ai-import/analyze.ts — measured, never AI) and the
 * job's cost estimate / model plan into what the administrator needs before
 * clicking "Process & Import Questions": detected facts (kept apart from
 * estimates), the reading strategy, the model that will be used and why, the
 * maximum possible cost, and — when the file cannot be processed usefully —
 * the reason and the one next action.
 */
import type { JobAnalysis } from "@/lib/ai-import/analyze";
import type { CostEstimate } from "@/lib/ai-import/estimate";
import { SELECTION_TASK_LABELS } from "@/lib/ai-import/config";

export type FactKind = "detected" | "estimate" | "unavailable";

export interface AnalyzerFact {
  label: string;
  value: string;
  kind: FactKind;
  tone?: "warning" | "error";
}

export type Strategy = "LOCAL" | "AI" | "LOCAL_PARTIAL" | "BLOCKED";

export interface AnalyzerVerdict {
  facts: AnalyzerFact[];
  strategy: Strategy;
  strategyLabel: string;
  /** The model (or the free local reader) that reads the pages, with the reason. */
  model: { name: string; route: string | null; reason: string; maxPerRequestInr: number | null; local: boolean };
  /** Other tasks that use a model (verification, answer key, topics), when AI runs. */
  otherModels: { task: string; model: string | null; reason: string }[];
  /** Conservative maximum this job can spend (₹0 for local reading); null when it cannot be priced. */
  maxCostInr: number | null;
  estimatedCostInr: number | null;
  /** Whether the analysis is metadata-only (no AI was or will be used for analysis — always true here). */
  analysisMode: string;
  canProcess: boolean;
  /** Why processing is not possible / not useful, and the single next action. */
  blocker: { reason: string; nextAction: string } | null;
  warnings: string[];
}

const inr = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `₹${v.toFixed(2)}`);

export function analyzerVerdict(input: {
  analysis: JobAnalysis;
  estimate: CostEstimate | null;
  aiEnabled: boolean;
  remainingBudgetInr: number;
  jobBudgetInr: number;
  limits: { maxPagesPerFile: number; maxFileMb: number };
  /** FULL_PAPER / MIXED: subjects come from section headings (or the AI classifier); SINGLE_SUBJECT: the chosen subject. */
  paperType?: string;
  /** Neither the job nor its exam has a year: the Bulk Import would refuse every question. */
  yearMissing?: boolean;
}): AnalyzerVerdict {
  const { analysis: a, aiEnabled } = input;
  const est = input.estimate ?? a.estimate;
  const papers = a.files.filter((f) => f.role === "PAPER");
  const keys = a.files.filter((f) => f.role === "ANSWER_KEY");
  const pf = papers.map((f) => f.facts).filter((f): f is NonNullable<typeof f> => !!f);
  const kf = keys.map((f) => f.facts).filter((f): f is NonNullable<typeof f> => !!f);
  const failed = a.files.filter((f) => f.error);
  const t = a.totals;
  const warnings: string[] = [];
  const facts: AnalyzerFact[] = [];

  const kinds = [...new Set(pf.map((f) => f.kind))].join(", ") || "—";
  facts.push({ label: "File type", value: kinds, kind: "detected" });
  facts.push({ label: "Pages", value: pf.length ? `${t.pages}` : "Could not be counted", kind: pf.length ? "detected" : "unavailable", tone: pf.length ? undefined : "error" });
  const isDoc = pf.length > 0 && pf.every((f) => ["DOCX", "XLSX", "CSV"].includes(f.kind));
  const docType = isDoc ? "Document (exact text)" : t.scannedPages === 0 ? "Digital PDF (text layer on every page)" : t.textPages === 0 ? "Scanned (no text layer)" : `Mixed: ${t.textPages} digital, ${t.scannedPages} scanned`;
  facts.push({ label: "Digital or scanned", value: docType, kind: "detected", tone: t.scannedPages ? "warning" : undefined });
  facts.push({ label: "OCR / vision needed", value: t.scannedPages ? `Yes — ${t.scannedPages} page${t.scannedPages === 1 ? "" : "s"}` : "No", kind: "detected", tone: t.scannedPages ? "warning" : undefined });

  const keyInPaper = pf.some((f) => f.answerKeyDetected);
  const keyFileScanned = kf.reduce((n, f) => n + f.scannedPages, 0);
  const keyValue = keys.length ? `Separate answer key uploaded (${keys.length} file${keys.length === 1 ? "" : "s"}${keyFileScanned ? `, ${keyFileScanned} scanned page${keyFileScanned === 1 ? "" : "s"}` : ""})` : keyInPaper ? "An answer key appears inside the paper" : "Not detected";
  facts.push({ label: "Answer key", value: keyValue, kind: keys.length || keyInPaper ? "detected" : "detected" });

  const imgs = t.embeddedImages;
  facts.push({ label: "Diagrams / images", value: imgs ? `${imgs} embedded image${imgs === 1 ? "" : "s"} (kept with their questions)` : t.scannedPages ? "Not measurable on scanned pages" : "None detected", kind: imgs || !t.scannedPages ? "detected" : "unavailable" });
  const tables = pf.some((f) => f.tablesLikely);
  const formulas = pf.some((f) => f.formulasLikely);
  if (tables || formulas) facts.push({ label: "Tables / formulas", value: [tables ? "tables likely" : null, formulas ? "formulas or symbols likely" : null].filter(Boolean).join(", "), kind: "detected" });

  if (t.scannedPages === 0 && pf.length) facts.push({ label: "Questions", value: `${t.localQuestions} recognized`, kind: "detected", tone: t.localQuestions ? undefined : "warning" });
  else if (pf.length) facts.push({ label: "Questions", value: t.localQuestions ? `${t.localQuestions} recognized on digital pages; scanned pages not countable without AI` : "Not countable without AI (scanned)", kind: t.localQuestions ? "detected" : "unavailable" });
  if (est && t.scannedPages) facts.push({ label: "Likely questions", value: `about ${est.expectedQuestions}`, kind: "estimate" });

  const types = new Map<string, number>();
  for (const f of pf) for (const [k, v] of Object.entries(f.questionTypes)) types.set(k, (types.get(k) ?? 0) + v);
  if (types.get("Numerical")) warnings.push(`Numerical-answer questions were noticed (${types.get("Numerical")}). They cannot be stored as 4-option questions and will be marked Not importable — never converted into MCQs.`);
  const special = [...types.entries()].filter(([k]) => k !== "Numerical");
  if (special.length) facts.push({ label: "Special formats", value: special.map(([k, v]) => `${k} ×${v}`).join(", "), kind: "detected" });

  for (const f of failed) warnings.push(`${f.name}: ${f.error}`);
  for (const f of pf) if (f.pages > input.limits.maxPagesPerFile) warnings.push(`A file has ${f.pages} pages; the limit is ${input.limits.maxPagesPerFile}.`);

  // ---- Strategy and model --------------------------------------------------------------------
  const plan = est?.plan ?? null;
  const extract = plan?.tasks.extract ?? null;
  const needsVision = t.scannedPages > 0;
  let strategy: Strategy;
  let blocker: AnalyzerVerdict["blocker"] = null;
  let model: AnalyzerVerdict["model"];
  const localModel = (reason: string): AnalyzerVerdict["model"] => ({ name: "Local reader (no AI)", route: "On this server", reason, maxPerRequestInr: 0, local: true });

  if (!pf.length) {
    strategy = "BLOCKED";
    model = localModel("Nothing could be read from the uploaded file.");
    blocker = { reason: failed.length ? `The file could not be analyzed: ${failed[0].error}` : "No question paper was uploaded.", nextAction: "Upload the question paper again (PDF, Word, JPG, PNG, XLSX or CSV)." };
  } else if (!needsVision) {
    strategy = "LOCAL";
    model = localModel(t.localQuestions ? "Every page has a text layer, so questions, options and embedded images are read exactly from the file — no AI is needed to read them, so this is the cheapest suitable choice (₹0 for reading)." : "Every page has a text layer, but no numbered questions were recognized.");
    if (!t.localQuestions && !isDoc) {
      strategy = "BLOCKED";
      blocker = { reason: "No numbered questions with options were recognized in this file.", nextAction: "Check that this is a question paper with numbered questions and options (A)–(D), then upload it again." };
    }
  } else if (!aiEnabled) {
    model = localModel("Paid AI is switched off for the importer, so only pages with a text layer can be read.");
    if (t.textPages > 0 && t.localQuestions > 0) {
      strategy = "LOCAL_PARTIAL";
      warnings.push(`${t.scannedPages} scanned page${t.scannedPages === 1 ? "" : "s"} will be skipped because reading them needs AI vision, which is switched off. Only the ${t.localQuestions} question(s) on digital pages can be imported.`);
    } else {
      strategy = "BLOCKED";
      blocker = {
        reason: `This file is scanned: ${t.scannedPages} page${t.scannedPages === 1 ? " has" : "s have"} no text layer. Reading it needs AI vision (OCR), and paid AI is switched off for the importer.`,
        nextAction: "Upload a digital PDF or Word copy of the paper — or ask the owner to approve the paid AI pilot (Importer Settings → AI switch, models and privacy check). Nothing has been charged.",
      };
    }
  } else if (!extract?.model) {
    strategy = "BLOCKED";
    model = { name: "No suitable model", route: null, reason: extract?.reason ?? "No model plan could be made.", maxPerRequestInr: null, local: false };
    blocker = { reason: `Scanned pages need a vision model, but none is eligible: ${extract?.reason ?? "no model plan"}`, nextAction: "Add a suitable, priced, privacy-eligible vision model to the importer's own model list (Importer Settings → Importer models). Nothing has been charged." };
  } else {
    strategy = "AI";
    model = { name: extract.model, route: extract.routes.join(", ") || null, reason: extract.reason, maxPerRequestInr: extract.maxInr, local: false };
    if (t.textPages) warnings.push(`${t.textPages} digital page(s) are read locally for free; only the ${t.scannedPages} scanned page(s) are sent to the model.`);
  }

  if (keyFileScanned && !(aiEnabled && plan?.tasks.key.model)) warnings.push("The answer key is an image or scanned page. It cannot be read without AI vision, so answers stay \"Answer unverified\" and those questions are not imported automatically. A digital (text) answer key works without AI.");
  if (!keys.length && !keyInPaper && strategy !== "BLOCKED") warnings.push("No answer key was found. Questions without an answer are kept for review and are not imported automatically. Add the answer key under Advanced options to match answers.");

  if (strategy !== "BLOCKED" && input.paperType !== "SINGLE_SUBJECT" && !(aiEnabled && plan?.tasks.classify.model)) warnings.push("Subjects are taken from section headings in the file (for example \"Anatomy\"), because AI classification is off. Questions without a heading are kept for review with \"Subject unknown\". For a one-subject paper, choose Single-subject paper under Advanced options before uploading.");
  // Paid AI is used when scanned pages are read by a model, and also — with AI on — for topic
  // classification, verification or a scanned key of a digital paper: any priced call in the estimate.
  const aiLines = aiEnabled && !!est && est.lines.some((l) => l.calls > 0);
  const usesAi = strategy === "AI" || (strategy !== "BLOCKED" && aiLines);
  const maxCostInr = usesAi ? (est?.maxInr ?? null) : 0;
  if (usesAi && blocker === null) {
    if (maxCostInr === null) blocker = { reason: "The maximum possible AI cost cannot be calculated (a price or the exchange rate is missing), so paid processing will not start.", nextAction: "Refresh the model routes in Importer Settings, then analyze again." };
    else if (maxCostInr > input.jobBudgetInr) blocker = { reason: `The maximum possible cost (${inr(maxCostInr)}) is above this job's budget (${inr(input.jobBudgetInr)}).`, nextAction: "Process fewer pages (for example a 2-page sample file) — the pilot limits cannot be raised here." };
    else if (maxCostInr > input.remainingBudgetInr) blocker = { reason: `The maximum possible cost (${inr(maxCostInr)}) is above the remaining pilot budget (${inr(input.remainingBudgetInr)}).`, nextAction: "Process a smaller file. The all-time pilot budget does not reset." };
    if (blocker) strategy = "BLOCKED";
  }

  if (blocker === null && input.yearMissing) {
    blocker = { reason: "This import has no paper year and its exam has no year set, so the Question Bank would refuse every question.", nextAction: "Delete this import and upload the file again, entering the paper's year." };
    strategy = "BLOCKED";
  }
  const otherModels = usesAi && plan ? (["verify", "key", "classify"] as const).map((k) => ({ task: SELECTION_TASK_LABELS[k], model: plan.tasks[k].model, reason: plan.tasks[k].reason })) : [];
  if (usesAi && strategy !== "AI") model = { ...model, reason: `${model.reason} Paid AI is on, so the steps listed below (for example topic classification) use the cheapest suitable importer model; their cost is included.` };
  const strategyLabel = {
    LOCAL: usesAi ? "Read locally from the text layer; AI only for the steps listed" : "Read locally from the text layer — exact and free",
    LOCAL_PARTIAL: "Digital pages read locally; scanned pages skipped (AI off)",
    AI: "Digital pages read locally; scanned pages read by AI vision",
    BLOCKED: "Cannot be processed as it is",
  }[strategy];

  return {
    facts,
    strategy,
    strategyLabel,
    model,
    otherModels,
    maxCostInr,
    estimatedCostInr: usesAi ? (est?.totalInr ?? null) : 0,
    analysisMode: "Local, metadata-only analysis on this server — no AI request was made and nothing was charged.",
    canProcess: blocker === null,
    blocker,
    warnings,
  };
}
