/**
 * Client-safe shapes of the Import Settings Model Assistant
 * (lib/ai-import/assistant.ts). Every field is a measured or published fact
 * (catalog modalities and prices, stored provider routes, the importer's own
 * request history); model QUALITY is never claimed — it is "Not tested"
 * unless a real benchmark result exists, and none does yet.
 */

export const ASSISTANT_PURPOSES = ["ocr", "mathematics", "chemistry", "diagrams", "answer_key", "verification", "classification"] as const;
export type AssistantPurpose = (typeof ASSISTANT_PURPOSES)[number];

export const PURPOSE_LABELS: Record<AssistantPurpose, string> = {
  ocr: "Scanned PDF pages (OCR)",
  mathematics: "Mathematics (formulas on pages)",
  chemistry: "Chemistry (equations, structures)",
  diagrams: "Diagrams and figures",
  answer_key: "Answer-key reading",
  verification: "Independent verification (second read)",
  classification: "Topic classification",
};

/** What the purpose needs, as checked here (requirements only — never a quality judgement). */
export const PURPOSE_REQUIREMENTS: Record<AssistantPurpose, string> = {
  ocr: "Reads images (published input modality), returns text, fixed published price.",
  mathematics: "Formulas on scanned pages are read from the page image, so the requirements are the same as OCR. The catalog publishes no mathematics ability, so formula accuracy is Not tested.",
  chemistry: "Equations and structures are read from the page image: same requirements as OCR. The catalog publishes no chemistry ability, so accuracy is Not tested.",
  diagrams: "Figure positions are read from the page image: same requirements as OCR. Figure-box accuracy is Not tested.",
  answer_key: "Reads images (scanned keys), fixed published price.",
  verification: "Same requirements as OCR, and a DIFFERENT model than page reading (a different vendor is preferred), so the second read is independent.",
  classification: "Returns text (no image input needed), fixed published price.",
};

export type RouteState = "verified" | "stale" | "not_read" | "unavailable" | "no_zdr";

export interface AssistantCandidate {
  id: string;
  name: string;
  vendor: string;
  onList: boolean;
  /** Provider routes: verified = read within 6 h with a route serving normally (and ZDR when required). */
  route: { state: RouteState; text: string };
  /** zero = OpenRouter publishes a price of 0 (known zero, not unknown). */
  price: { state: "published" | "zero" | "unknown"; maxInr: number | null; text: string };
  imageInput: boolean;
  /** Published request parameters (facts about the API, not about quality). */
  params: { reasoning: boolean; structuredOutput: boolean };
  /** Importer requests in the last 24 h (measured). */
  history: { requests: number; ok: number; rateLimited: number; text: string };
  limitations: string[];
  /** Configuration checks (no AI request); quality is always "Not tested" until a benchmark exists. */
  test: { config: "passed" | "failed" | "not_run"; configText: string; quality: "not_tested" };
}

export interface PurposeRecommendation {
  purpose: AssistantPurpose;
  label: string;
  requirements: string;
  /** Best first; at most 3. */
  candidates: AssistantCandidate[];
  recommended: string | null;
  /** Why nothing could be recommended (null when something was). */
  none: string | null;
  excluded: { reason: string; count: number }[];
}

export interface AssistantResult {
  computedAt: string;
  /** Always "catalog": AI reasoning for recommendations is not approved (and is never used while Paid AI is off). */
  method: "catalog";
  methodNote: string;
  paidAiOn: boolean;
  purposes: PurposeRecommendation[];
  /** Models to add to the importer's list if the recommendations are applied (not yet on it). */
  toAdd: string[];
  currentList: string[];
  /** Listed models that no purpose recommends (kept unless removed by hand). */
  notRecommended: string[];
  catalogSyncedAt: string | null;
  routesFetchedAt: string | null;
}

export interface ConfigCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface ModelTestResult {
  id: string;
  checks: ConfigCheck[];
  passed: boolean;
}

export interface ModelTestReport {
  at: string;
  /** Plan-wide checks (provider, key, exchange rate, Paid AI, routes). */
  global: ConfigCheck[];
  models: ModelTestResult[];
  /** Real quality tests stay disabled: they need paid AI requests and a separate approval. */
  quality: { enabled: false; reason: string };
  aiRequestsSent: 0;
}

export interface ApplyResult {
  added: string[];
  list: string[];
  /** Re-validation after saving: the automatic choice per task with fresh routes (route, price, privacy, budget). */
  tasks: { task: string; label: string; model: string | null; reason: string; maxInr: number | null }[];
  routesError: string | null;
}
