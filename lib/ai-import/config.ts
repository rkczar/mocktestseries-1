/**
 * AI Question Importer — client-safe definitions: settings shape + defaults,
 * limits, status labels and the pure helpers shared by the worker, the
 * server actions and the admin pages. Server code lives next to it
 * (lib/ai-import/*.ts with `server-only`).
 */

export const IMPORTER_SETTING_KEY = "ai.importer";

/** Engine "features" the importer logs under (AiGatewayCall.feature / AiBudgetReservation.feature). */
export const IMPORTER_TASKS = ["analyze", "extract", "verify", "classify", "key"] as const;
export type ImporterTask = (typeof IMPORTER_TASKS)[number];
export const importerFeature = (task: ImporterTask) => `qimport_${task}`;
export const IMPORTER_FEATURE_PREFIX = "qimport_";

export const TASK_LABELS: Record<ImporterTask, string> = {
  analyze: "File analysis",
  extract: "Question extraction",
  verify: "Independent verification",
  classify: "Topic classification",
  key: "Answer-key reading",
};

export interface ImporterModels {
  /** Vision model for page extraction (scanned / complex pages). null = AI extraction disabled. */
  extract: string | null;
  /** Fallback vision models tried in order when the extractor fails. */
  extractFallbacks: string[];
  /** A DIFFERENT model for second reads and the independent answer opinion. */
  verify: string | null;
  /** Cheap text model for topic classification. */
  classify: string | null;
  /** Vision model for scanned answer keys (defaults to the extractor). */
  key: string | null;
}

export interface ImporterSettings {
  /** Master switch for PAID AI calls. Local parsing, review, import and publishing work without it. */
  aiEnabled: boolean;
  models: ImporterModels;
  privacy: {
    /** OpenRouter provider.data_collection for every importer call ("deny" = providers that do not store/train on prompts). */
    dataCollection: "deny" | "allow";
    /** Only Zero-Data-Retention endpoints. */
    zdr: boolean;
  };
  budget: {
    /** Importer-only monthly budget (IST month) — separate from the platform/student AI budget. */
    monthlyInr: number;
    /** Default per-job cap offered on New Import. */
    defaultJobCapInr: number;
    /** Hard ceiling for one AI request (INR). */
    maxRequestInr: number;
    /**
     * The OpenRouter key is shared with student Ask AI: an importer request is refused
     * unless at least this much (USD) of the key's limit would remain after its worst case.
     */
    keyReserveUsd: number;
    /** Retry once after a transient provider error (off = one attempt per request, never a retry). */
    retryTransient: boolean;
  };
  limits: {
    maxFileMb: number;
    maxPagesPerFile: number;
    maxFilesPerJob: number;
    /** Page render resolution for extraction and crops. */
    renderDpi: number;
    /** Parallel AI calls per job (bounded; the VPS has 2 CPUs). */
    concurrency: number;
  };
  verification: {
    /** Below this extraction confidence a scanned question gets a second read by the verify model. */
    secondReadBelow: number;
    /** Ask the verify model for an independent answer (an AI OPINION, never an official answer). */
    independentAnswer: boolean;
    /** Topic confidence needed to accept an AI topic without review. */
    topicMinConfidence: number;
    /** Near-duplicate similarity threshold (0..1, word-shingle Jaccard). */
    nearDuplicateAt: number;
  };
  publish: {
    /** Questions without an official key may be imported/published with their answer marked UNVERIFIED. */
    allowUnverifiedAnswers: boolean;
    /** A topic is required before a question may be published. */
    requireTopic: boolean;
  };
  retention: {
    /** Original uploaded papers are kept this many days after upload (then eligible for cleanup). */
    originalDays: number;
    /** Page renders / temp files of finished jobs are kept this many days. */
    intermediateDays: number;
    /** The worker removes EXPIRED temp files, renders and originals of finished jobs by itself (reference-checked). Off by default. */
    autoCleanup: boolean;
  };
}

export const DEFAULT_IMPORTER_SETTINGS: ImporterSettings = {
  aiEnabled: false,
  models: { extract: null, extractFallbacks: [], verify: null, classify: null, key: null },
  privacy: { dataCollection: "deny", zdr: false },
  budget: { monthlyInr: 1500, defaultJobCapInr: 200, maxRequestInr: 10, keyReserveUsd: 5, retryTransient: false },
  limits: { maxFileMb: 100, maxPagesPerFile: 300, maxFilesPerJob: 10, renderDpi: 150, concurrency: 2 },
  verification: { secondReadBelow: 0.8, independentAnswer: false, topicMinConfidence: 0.7, nearDuplicateAt: 0.85 },
  publish: { allowUnverifiedAnswers: false, requireTopic: true },
  retention: { originalDays: 90, intermediateDays: 14, autoCleanup: false },
};

export const SETTINGS_BOUNDS = {
  maxFileMb: [1, 200],
  maxPagesPerFile: [1, 600],
  maxFilesPerJob: [1, 20],
  renderDpi: [100, 220],
  concurrency: [1, 3],
  monthlyInr: [0, 1_000_000],
  defaultJobCapInr: [0, 100_000],
  maxRequestInr: [0.01, 1_000],
  keyReserveUsd: [0, 10_000],
  originalDays: [1, 3650],
  intermediateDays: [1, 365],
} as const;

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,60}\/[A-Za-z0-9._:-]{1,100}$/;

const clamp = (v: unknown, [min, max]: readonly [number, number], fallback: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const frac = (v: unknown, fallback: number) => clamp(v, [0, 1], fallback);
const model = (v: unknown): string | null => (typeof v === "string" && MODEL_ID.test(v.trim()) ? v.trim() : null);

export function normalizeImporterSettings(raw: unknown): ImporterSettings {
  const r = (raw ?? {}) as Partial<ImporterSettings> & Record<string, never>;
  const d = DEFAULT_IMPORTER_SETTINGS;
  const m = (r.models ?? {}) as Partial<ImporterModels>;
  const extract = model(m.extract);
  return {
    aiEnabled: r.aiEnabled === true,
    models: {
      extract,
      extractFallbacks: Array.isArray(m.extractFallbacks) ? [...new Set(m.extractFallbacks.map(model).filter((x): x is string => !!x && x !== extract))].slice(0, 3) : [],
      verify: model(m.verify),
      classify: model(m.classify),
      key: model(m.key),
    },
    privacy: {
      dataCollection: r.privacy?.dataCollection === "allow" ? "allow" : "deny",
      zdr: r.privacy?.zdr === true,
    },
    budget: {
      monthlyInr: clamp(r.budget?.monthlyInr, SETTINGS_BOUNDS.monthlyInr, d.budget.monthlyInr),
      defaultJobCapInr: clamp(r.budget?.defaultJobCapInr, SETTINGS_BOUNDS.defaultJobCapInr, d.budget.defaultJobCapInr),
      maxRequestInr: clamp(r.budget?.maxRequestInr, SETTINGS_BOUNDS.maxRequestInr, d.budget.maxRequestInr),
      keyReserveUsd: clamp(r.budget?.keyReserveUsd, SETTINGS_BOUNDS.keyReserveUsd, d.budget.keyReserveUsd),
      retryTransient: r.budget?.retryTransient === true,
    },
    limits: {
      maxFileMb: Math.round(clamp(r.limits?.maxFileMb, SETTINGS_BOUNDS.maxFileMb, d.limits.maxFileMb)),
      maxPagesPerFile: Math.round(clamp(r.limits?.maxPagesPerFile, SETTINGS_BOUNDS.maxPagesPerFile, d.limits.maxPagesPerFile)),
      maxFilesPerJob: Math.round(clamp(r.limits?.maxFilesPerJob, SETTINGS_BOUNDS.maxFilesPerJob, d.limits.maxFilesPerJob)),
      renderDpi: Math.round(clamp(r.limits?.renderDpi, SETTINGS_BOUNDS.renderDpi, d.limits.renderDpi)),
      concurrency: Math.round(clamp(r.limits?.concurrency, SETTINGS_BOUNDS.concurrency, d.limits.concurrency)),
    },
    verification: {
      secondReadBelow: frac(r.verification?.secondReadBelow, d.verification.secondReadBelow),
      independentAnswer: r.verification?.independentAnswer === true,
      topicMinConfidence: frac(r.verification?.topicMinConfidence, d.verification.topicMinConfidence),
      nearDuplicateAt: clamp(r.verification?.nearDuplicateAt, [0.5, 1], d.verification.nearDuplicateAt),
    },
    publish: {
      allowUnverifiedAnswers: r.publish?.allowUnverifiedAnswers === true,
      requireTopic: r.publish?.requireTopic !== false,
    },
    retention: {
      originalDays: Math.round(clamp(r.retention?.originalDays, SETTINGS_BOUNDS.originalDays, d.retention.originalDays)),
      intermediateDays: Math.round(clamp(r.retention?.intermediateDays, SETTINGS_BOUNDS.intermediateDays, d.retention.intermediateDays)),
      autoCleanup: r.retention?.autoCleanup === true,
    },
  };
}

// ---- Accepted files ---------------------------------------------------------------------------

export const ACCEPTED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "docx", "xlsx", "csv"] as const;
export type AcceptedExtension = (typeof ACCEPTED_EXTENSIONS)[number];
/** Refused with a clear reason (never parsed). */
export const REFUSED_EXTENSIONS: Record<string, string> = {
  doc: "Old binary Word (.doc) files are not processed (they can carry macros and need LibreOffice). Save the file as .docx or PDF and upload that.",
  docm: "Macro-enabled Word files are refused. Save as .docx without macros, or as PDF.",
  xlsm: "Macro-enabled Excel files are refused. Save as .xlsx without macros.",
  xls: "Old Excel (.xls) files are refused. Save as .xlsx or .csv.",
  rtf: "RTF files are not supported. Save as .docx or PDF.",
  odt: "OpenDocument files are not supported. Save as .docx or PDF.",
  zip: "Archives are not accepted here. Upload the papers themselves.",
};
export const CHUNK_BYTES = 8 * 1024 * 1024;

// ---- Labels -----------------------------------------------------------------------------------

export const JOB_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Uploading",
  ANALYZING: "Analyzing",
  AWAITING_CONFIRMATION: "Awaiting confirmation",
  QUEUED: "Queued",
  PROCESSING: "Processing",
  NEEDS_REVIEW: "Ready to import",
  PAUSED: "Paused",
  PAUSED_BUDGET: "Paused — budget limit",
  IMPORTING: "Importing",
  COMPLETED: "Completed",
  COMPLETED_WITH_ISSUES: "Completed with issues",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export const QUESTION_STATUS_LABELS: Record<string, string> = {
  EXTRACTED: "Extracted",
  READY: "Ready",
  NEEDS_CORRECTION: "Needs correction",
  NOT_IMPORTABLE: "Not importable",
  DUPLICATE: "Duplicate",
  REJECTED: "Rejected",
  IMPORTED: "Imported (draft)",
  PUBLISHED: "Published",
  IMPORT_FAILED: "Import failed",
};

export const ANSWER_STATUS_LABELS: Record<string, string> = {
  OFFICIAL_MATCHED: "Official answer key matched",
  INDEPENDENTLY_VERIFIED: "Answer independently verified",
  UNVERIFIED: "Answer unverified",
  KEY_MISSING: "Answer key missing",
  KEY_MISMATCH: "Answer key mismatch",
  AMBIGUOUS_MAPPING: "Ambiguous key mapping",
  WITHDRAWN: "Possible withdrawn question",
};

/** Issue codes stored on AiImportQuestion.issueCodes. `blocking` = cannot be imported until fixed. */
export const ISSUE_DEFS: Record<string, { label: string; blocking: boolean; publishBlocking: boolean }> = {
  EXTRACTION_UNCERTAIN: { label: "Extraction needs correction", blocking: false, publishBlocking: true },
  OPTIONS_INCOMPLETE: { label: "Options missing or unreadable", blocking: true, publishBlocking: true },
  UNREADABLE_TEXT: { label: "Unreadable text", blocking: false, publishBlocking: true },
  IMAGE_MAPPING_UNCERTAIN: { label: "Image mapping uncertain", blocking: true, publishBlocking: true },
  IMAGE_MISSING: { label: "Essential image missing", blocking: true, publishBlocking: true },
  UNSUPPORTED_TYPE: { label: "Not importable (type not supported)", blocking: true, publishBlocking: true },
  TOPIC_UNCERTAIN: { label: "Topic needs correction", blocking: false, publishBlocking: true },
  SUBJECT_UNKNOWN: { label: "Subject unknown", blocking: true, publishBlocking: true },
  ANSWER_MISSING: { label: "No answer available", blocking: true, publishBlocking: true },
  ANSWER_MISMATCH: { label: "Answer key mismatch", blocking: false, publishBlocking: true },
  ANSWER_AMBIGUOUS: { label: "Ambiguous answer-key mapping", blocking: false, publishBlocking: true },
  ANSWER_UNVERIFIED: { label: "Answer unverified", blocking: false, publishBlocking: false },
  POSSIBLE_WITHDRAWN: { label: "Possible withdrawn question", blocking: false, publishBlocking: true },
  FORMULA_ISSUE: { label: "Formula needs checking", blocking: false, publishBlocking: true },
  NUMBERING_GAP: { label: "Numbering gap nearby", blocking: false, publishBlocking: false },
  DUPLICATE_EXISTING: { label: "Duplicate of an existing question", blocking: true, publishBlocking: true },
  DUPLICATE_NEAR: { label: "Near-duplicate of an existing question", blocking: false, publishBlocking: true },
  DUPLICATE_IN_BATCH: { label: "Duplicate within this batch", blocking: true, publishBlocking: true },
  AI_OPINION_DIFFERS: { label: "AI opinion differs from the key", blocking: false, publishBlocking: false },
};

export function issueLabel(code: string): string {
  return ISSUE_DEFS[code]?.label ?? code;
}

/** Question types the existing Question model can hold (4 options A–D). */
export const IMPORTABLE_TYPES = ["SINGLE_CORRECT", "MULTIPLE_CORRECT", "MATCH_THE_FOLLOWING", "ASSERTION_REASON"] as const;
export const OPTION_LABELS = ["A", "B", "C", "D"] as const;

export function formatBytes(n: number | bigint | null | undefined): string {
  const v = typeof n === "bigint" ? Number(n) : n ?? 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
}

/** Badge colour for a job / question / answer status (shared by server and client components). */
export function statusVariant(s: string): "success" | "warning" | "error" | "info" | "neutral" | "primary" {
  if (s === "COMPLETED" || s === "PUBLISHED" || s === "OFFICIAL_MATCHED" || s === "READY") return "success";
  if (s === "FAILED" || s === "CANCELLED" || s === "REJECTED" || s === "IMPORT_FAILED" || s === "KEY_MISMATCH" || s === "NOT_IMPORTABLE") return "error";
  if (s.startsWith("PAUSED") || s === "NEEDS_CORRECTION" || s === "COMPLETED_WITH_ISSUES" || s === "UNVERIFIED" || s === "AMBIGUOUS_MAPPING" || s === "WITHDRAWN" || s === "DUPLICATE" || s === "KEY_MISSING") return "warning";
  if (["ANALYZING", "QUEUED", "PROCESSING", "IMPORTING"].includes(s)) return "info";
  return "neutral";
}
