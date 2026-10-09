import "server-only";
import {
  MIN_ATTEMPT_CHOICES,
  getInsightExportRows,
  getInsightFilterOptions,
  parseInsightFilters,
  resolveRange,
  type InsightFilters,
  type InsightRow,
  type ResolvedRange,
} from "@/lib/question-insights";
import { statusesFor, type QuestionStatusInfo } from "@/lib/instagram/posts";
import type { SeriesStats } from "@/lib/instagram/types";

/**
 * Admin → Instagram → Most Missed MCQ. A thin layer over Admin → Analytics →
 * Question Insights (lib/question-insights.ts), used unchanged: same answer
 * universe (final answers of SUBMITTED attempts), same Asia/Kolkata ranges,
 * same "Most Wrong" ranking. Only aggregate counts leave this module — never
 * a student id, name or attempt. The two extra thresholds (minimum wrong
 * answers, minimum wrong %) filter the ranked rows; they never change a count.
 */

export const MM_RANGES = ["today", "yesterday", "7d", "custom"] as const;
export const MM_SORTS = ["wrong", "wrongPct"] as const;
export const MM_MIN_WRONG_CHOICES = [0, 1, 3, 5, 10, 20] as const;
export const MM_MIN_PCT_CHOICES = [0, 30, 40, 50, 60, 70] as const;
/** Ranked rows read before thresholds are applied (Insights export path, capped). */
const SCAN_CAP = 500;
export const MM_SHOW = 50;

export interface MostMissedFilters {
  insight: InsightFilters;
  minWrong: number;
  minPct: number;
}

const pick = <T extends readonly number[]>(choices: T, raw: string | undefined, fallback: T[number]): T[number] => {
  const n = Number(raw);
  return (choices as readonly number[]).includes(n) ? (n as T[number]) : fallback;
};

export function parseMostMissedFilters(raw: Record<string, string | string[] | undefined>): MostMissedFilters {
  const flat = (k: string) => {
    const v = raw[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const range = (MM_RANGES as readonly string[]).includes(flat("range") ?? "") ? flat("range") : "yesterday";
  const sort = (MM_SORTS as readonly string[]).includes(flat("sort") ?? "") ? flat("sort") : "wrong";
  const insight = parseInsightFilters({
    tab: "wrong",
    range,
    from: flat("from"),
    to: flat("to"),
    examId: flat("examId"),
    subjectId: flat("subjectId"),
    min: flat("min") ?? "10",
    sort,
  });
  return { insight, minWrong: pick(MM_MIN_WRONG_CHOICES, flat("minWrong"), 0), minPct: pick(MM_MIN_PCT_CHOICES, flat("minPct"), 0) };
}

export function mostMissedQuery(f: MostMissedFilters, overrides: Record<string, string | number | undefined> = {}): string {
  const p = new URLSearchParams();
  const v: Record<string, string | number | undefined> = {
    range: f.insight.range,
    from: f.insight.range === "custom" ? f.insight.from : undefined,
    to: f.insight.range === "custom" ? f.insight.to : undefined,
    examId: f.insight.examId,
    subjectId: f.insight.subjectId,
    min: f.insight.min,
    sort: f.insight.sort,
    minWrong: f.minWrong || undefined,
    minPct: f.minPct || undefined,
    ...overrides,
  };
  for (const [k, val] of Object.entries(v)) if (val !== undefined && val !== "") p.set(k, String(val));
  return p.toString();
}

export interface MostMissedRow {
  rank: number;
  id: string;
  code: string;
  preview: string;
  examName: string;
  subject: string;
  topic: string | null;
  attempts: number;
  wrong: number;
  wrongPct: number;
  hasImage: boolean;
  keyIssue: boolean;
  keyChanged: boolean;
  reviewRequired: boolean;
  instagram: QuestionStatusInfo;
}

export interface MostMissedResult {
  range: ResolvedRange;
  rows: MostMissedRow[];
  /** Ranked questions meeting the minimum attempts before the extra thresholds. */
  scanned: number;
  truncated: boolean;
}

const RANGE_LABELS: Record<string, string> = { today: "Today", yesterday: "Yesterday", "7d": "Last 7 Days" };

export function rangeLabelFor(r: ResolvedRange): string {
  return RANGE_LABELS[r.preset] ?? r.headlineSuffix.replace(/[()]/g, "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function getMostMissed(f: MostMissedFilters, now = new Date()): Promise<MostMissedResult> {
  const range = resolveRange(f.insight, now);
  if (range.error) return { range, rows: [], scanned: 0, truncated: false };
  const ranked: InsightRow[] = await getInsightExportRows(f.insight, range, SCAN_CAP);
  const kept = ranked.filter((r) => r.attempts > 0 && r.wrong >= f.minWrong && (r.wrongPct ?? 0) >= f.minPct).slice(0, MM_SHOW);
  const statuses = await statusesFor(kept.map((r) => r.id));
  return {
    range,
    scanned: ranked.length,
    truncated: ranked.length >= SCAN_CAP,
    rows: kept.map((r, i) => ({
      rank: i + 1,
      id: r.id,
      code: r.code,
      preview: r.textPreview,
      examName: r.examName,
      subject: r.subjectName,
      topic: r.topicName,
      attempts: r.attempts,
      wrong: r.wrong,
      wrongPct: r.wrongPct ?? 0,
      hasImage: r.hasImage,
      keyIssue: r.keyIssue !== null,
      keyChanged: r.keyChanged,
      reviewRequired: r.reviewRequired,
      instagram: statuses.get(r.id)!,
    })),
  };
}

/**
 * Re-computes one question's numbers server-side for the draft (the client
 * never supplies them). Null when the question no longer meets the filters.
 */
export async function statsForQuestion(f: MostMissedFilters, questionId: string, now = new Date()): Promise<SeriesStats | null> {
  const result = await getMostMissed(f, now);
  const row = result.rows.find((r) => r.id === questionId);
  if (!row) return null;
  return {
    attempts: row.attempts,
    wrong: row.wrong,
    wrongPct: Math.round(row.wrongPct * 100) / 100,
    rangeLabel: rangeLabelFor(result.range),
    headlineSuffix: result.range.headlineSuffix,
    rangePreset: result.range.preset,
    capturedAt: now.toISOString(),
  };
}

export async function mostMissedFilterOptions(f: MostMissedFilters) {
  const { exams, subjects } = await getInsightFilterOptions(f.insight);
  return { exams, subjects, minAttemptChoices: MIN_ATTEMPT_CHOICES };
}
