/**
 * Client-safe shapes of Import Settings → "AI Auto-Configure Everything"
 * (lib/ai-import/autoconfig.ts) and of "Reconfigure Models for This Job"
 * (lib/ai-import/reconfigure.ts). Every value is a published or measured fact
 * (catalog modalities and prices, provider routes read from OpenRouter, the
 * importer's own request history); quality is "Not tested" until a real
 * benchmark exists. No AI request is ever sent to build or apply them.
 */
import type { RouteState } from "@/lib/ai-import/assistant-types";
import type { ImporterSettings, SelectionTask } from "@/lib/ai-import/config";

export const AUTO_TASKS = ["scanned", "digital", "mathematics", "chemistry", "diagrams", "answer_key", "verification", "classification"] as const;
export type AutoTask = (typeof AUTO_TASKS)[number];

export const AUTO_TASK_LABELS: Record<AutoTask, string> = {
  scanned: "Scanned PDF OCR and page reading",
  digital: "Digital PDF reading",
  mathematics: "Mathematics questions",
  chemistry: "Chemistry questions",
  diagrams: "Diagram interpretation",
  answer_key: "Answer-key reading",
  verification: "Independent verification",
  classification: "Topic and subject classification",
};

/** The importer task (and model setting) each row is served by; digital pages are read locally first. */
export const AUTO_TASK_ENGINE: Record<AutoTask, SelectionTask> = {
  scanned: "extract",
  digital: "extract",
  mathematics: "extract",
  chemistry: "extract",
  diagrams: "extract",
  answer_key: "key",
  verification: "verify",
  classification: "classify",
};

export interface AutoTaskRow {
  task: AutoTask;
  label: string;
  engineTask: SelectionTask;
  /** The model this task will use (null = none is suitable: the task does not run). */
  model: string | null;
  /** Why this model, or why none. */
  reason: string;
  /** Published input modality; null when the task needs no image input. */
  imageInput: boolean | null;
  route: { state: RouteState | "not_needed"; text: string; at: string | null };
  /** zero = a published price of 0 (a known zero); unknown = never shown as ₹0.00. */
  price: { state: "published" | "zero" | "unknown" | "local"; maxInr: number | null; text: string };
  privacy: { eligible: boolean | null; text: string };
  rateLimit: { warning: string | null; text: string };
  quality: "not_tested";
  /** The next suitable models, best first (not selected). */
  alternatives: string[];
}

export interface AutoChange {
  key: string;
  label: string;
  current: string;
  proposed: string;
  changed: boolean;
  why: string;
}

export interface AutoJobCost {
  /** The reference job the estimate is for (no real job is priced here). */
  reference: string;
  estimateInr: number | null;
  maxInr: number | null;
  /** Hard per-job limit (unchanged). */
  jobCapInr: number;
  fitsJobCap: boolean | null;
  /** Scanned pages one job can read within the per-job limit at the conservative maximum (null = unknown). */
  maxScannedPagesPerJob: number | null;
  notes: string[];
}

export interface AutoConfigPreview {
  computedAt: string;
  /** Always "catalog": recommendations never use an AI request (AI reasoning is not approved). */
  method: "catalog";
  aiRequestsSent: 0;
  paidAiOn: boolean;
  paidAiText: string;
  routesFetchedAt: string | null;
  /** Provider routes could not be read now (nothing is proposed for unverified routes). */
  routesError: string | null;
  fx: { rate: number | null; date: string | null };
  tasks: AutoTaskRow[];
  changes: AutoChange[];
  jobCost: AutoJobCost;
  /** The complete settings document Apply would save (budgets, Paid AI and privacy are never changed). */
  proposed: ImporterSettings;
  /** Identifies the saved settings the preview was made from: Apply refuses if they changed meanwhile. */
  baselineKey: string;
  /** Identifies this exact proposal: Apply recomputes it and refuses if it differs. */
  proposalKey: string;
  /** Why Apply is not possible (empty = it is). */
  blocking: string[];
  /** Never changed by this configuration. */
  untouched: string[];
}

export interface AutoConfigApplied {
  savedAt: string;
  changes: AutoChange[];
  tasks: { task: AutoTask; label: string; model: string | null }[];
  auditId: string;
}

export interface ReconfigureTaskRow {
  task: SelectionTask;
  label: string;
  current: string | null;
  proposed: string | null;
  maxInr: number | null;
  reason: string;
  /** The manual choice could not be used, so `proposed` replaces it (explained before saving). */
  substituted: { from: string; why: string } | null;
  /** Measured quality of the model for this task: none has been tested. */
  quality: "not_tested";
}

export interface ReconfigurePreview {
  jobId: string;
  title: string;
  status: string;
  computedAt: string;
  aiRequestsSent: 0;
  paidAiOn: boolean;
  tasks: ReconfigureTaskRow[];
  /** Pages kept as they are (finished pages are never read or charged again). */
  donePages: number;
  /** Pages that will be read: failed + pending. */
  retryPages: number;
  failedKeyFiles: number;
  estimateInr: number | null;
  maxInr: number | null;
  /** What the job may still spend: its own budget (capped by the hard per-job limit) minus what it spent. */
  jobLeftInr: number;
  totalLeftInr: number;
  monthLeftInr: number;
  spentInr: number;
  routesFetchedAt: string | null;
  /** What happens after confirmation. */
  next: string;
  blocking: string[];
  proposalKey: string;
}

export interface ReconfigureResult {
  queued: boolean;
  message: string;
}
