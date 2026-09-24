/**
 * Converts between the structured JSON stored per homepage section field and
 * the plain-text textarea representation used for simple fields (Section 21
 * of the original spec) — no code editing required for those. The
 * `statistics` and `upcomingExamsConfig` fields are richer, JSON-native
 * objects edited through dedicated components instead (statistics-field-
 * editor.tsx / upcoming-exams-field-editor.tsx), so this file also carries
 * their types and back-compat normalizers.
 */

export type StatDynamicKey =
  | "questionsAnswered"
  | "aiExplanations"
  | "examsActive"
  | "testSeriesCount"
  | "questionBank"
  | "registeredStudents"
  | "activeStudents"
  | "mockTestsAttempted"
  | "mockTestsPublished"
  | "previousYearPapers";

export interface StatMetric {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  /** Optional decorative pill, e.g. "New" or "Popular" — not a mode indicator. */
  badge?: string;
  /** Optional link, making a MANUAL card double as a custom marketing card. */
  link?: string;
  enabled: boolean;
  mode: "LIVE" | "DEMO" | "MANUAL";
  dynamicKey?: StatDynamicKey;
  demoValue?: string;
  manualValue?: string;
}

export const STAT_DATA_SOURCE_LABELS: Record<StatDynamicKey, string> = {
  questionsAnswered: "Student Question Attempts (Answer)",
  aiExplanations: "AI Explanations",
  examsActive: "Active Exams",
  testSeriesCount: "Active Test Series",
  questionBank: "Published Questions",
  registeredStudents: "Registered Students",
  activeStudents: "Active Students",
  mockTestsAttempted: "Submitted Mock Test Attempts",
  mockTestsPublished: "Published Mock Tests",
  previousYearPapers: "Active Previous Year Papers",
};

export interface UpcomingExamConfig {
  id: string;
  examId: string;
  enabled: boolean;
  descriptionOverride?: string;
  ctaText?: string;
  ctaHref?: string;
}

function generateId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

/**
 * Upgrades a stored metric to the current 3-mode shape. Handles the old
 * 2-mode shape (`source: "DYNAMIC" | "ADMIN_CONFIGURED"`) transparently so
 * previously published homepages keep working without a DB migration.
 */
export function normalizeStatMetric(raw: unknown): StatMetric {
  const r = (raw ?? {}) as Record<string, unknown>;

  let mode: StatMetric["mode"];
  if (r.mode === "LIVE" || r.mode === "DEMO" || r.mode === "MANUAL") {
    mode = r.mode;
  } else if (r.source === "DYNAMIC") {
    mode = "LIVE";
  } else {
    mode = "MANUAL";
  }

  return {
    id: typeof r.id === "string" && r.id ? r.id : generateId(),
    label: typeof r.label === "string" ? r.label : "",
    description: typeof r.description === "string" ? r.description : undefined,
    icon: typeof r.icon === "string" ? r.icon : undefined,
    badge: typeof r.badge === "string" ? r.badge : undefined,
    link: typeof r.link === "string" ? r.link : undefined,
    enabled: typeof r.enabled === "boolean" ? r.enabled : true,
    mode,
    dynamicKey: typeof r.dynamicKey === "string" ? (r.dynamicKey as StatDynamicKey) : undefined,
    demoValue: typeof r.demoValue === "string" ? r.demoValue : undefined,
    manualValue: typeof r.manualValue === "string" ? r.manualValue : undefined,
  };
}

export function normalizeStatMetrics(raw: unknown): StatMetric[] {
  return Array.isArray(raw) ? raw.map(normalizeStatMetric) : [];
}

/**
 * Upgrades stored Upcoming Exams config to the per-exam shape. Falls back to
 * the old flat `references.examIds` list (each exam defaulted to enabled,
 * order = array order) so previously published homepages keep working.
 */
export function normalizeUpcomingExams(raw: unknown, fallbackExamIds?: unknown): UpcomingExamConfig[] {
  if (Array.isArray(raw) && raw.length > 0) {
    return raw
      .map((item) => {
        const r = (item ?? {}) as Record<string, unknown>;
        return {
          id: typeof r.id === "string" && r.id ? r.id : generateId(),
          examId: typeof r.examId === "string" ? r.examId : "",
          enabled: typeof r.enabled === "boolean" ? r.enabled : true,
          descriptionOverride: typeof r.descriptionOverride === "string" ? r.descriptionOverride : undefined,
          ctaText: typeof r.ctaText === "string" ? r.ctaText : undefined,
          ctaHref: typeof r.ctaHref === "string" ? r.ctaHref : undefined,
        };
      })
      .filter((c) => c.examId);
  }

  if (Array.isArray(fallbackExamIds)) {
    return fallbackExamIds.filter((id): id is string => typeof id === "string").map((examId) => ({ id: generateId(), examId, enabled: true }));
  }

  return [];
}

export type HeroPanelMode = "DEMO" | "LIVE" | "HIDDEN";

export interface HeroPanelConfig {
  enabled: boolean;
  mode: HeroPanelMode;
  showBadge: boolean;
  badgeLabel?: string;
  score?: string;
  maxScore?: string;
  percentile?: string;
  correct?: string;
  time?: string;
}

/**
 * Normalizes the HERO "analytics preview" panel. Legacy content (no `panel`
 * field) always degrades to disabled, so an old config can never accidentally
 * display fake scorecard values.
 */
export function normalizeHeroPanel(raw: unknown): HeroPanelConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const mode = r.mode === "DEMO" || r.mode === "LIVE" ? r.mode : "HIDDEN";
  return {
    enabled: r.enabled === true,
    mode,
    showBadge: r.showBadge !== false,
    badgeLabel: typeof r.badgeLabel === "string" ? r.badgeLabel : "Preview",
    score: typeof r.score === "string" ? r.score : undefined,
    maxScore: typeof r.maxScore === "string" ? r.maxScore : undefined,
    percentile: typeof r.percentile === "string" ? r.percentile : undefined,
    correct: typeof r.correct === "string" ? r.correct : undefined,
    time: typeof r.time === "string" ? r.time : undefined,
  };
}

export function pairListToText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((pair) => (Array.isArray(pair) ? `${pair[0] ?? ""} | ${pair[1] ?? ""}` : "")).join("\n");
}

export function textToPairList(text: string): [string, string][] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [a, ...rest] = line.split("|");
      return [a.trim(), rest.join("|").trim()] as [string, string];
    });
}

export function listToText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.join("\n");
}

export function textToList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function idListToText(ids: unknown, options: { id: string; name: string }[]): string {
  if (!Array.isArray(ids)) return "";
  const byId = new Map(options.map((o) => [o.id, o.name]));
  return ids.map((id) => byId.get(id) ?? id).join(", ");
}
