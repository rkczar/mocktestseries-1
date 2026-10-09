"use server";

import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import {
  MAX_COPY_QUESTIONS,
  TOP_CHOICES,
  getTopQuestionIds,
  parseInsightFilters,
  prepareQuestionCopy,
  resolveRange,
  type CopyPreparation,
} from "@/lib/question-insights";
import { COPY_BLOCK_SIZES, type CopyBlockSize } from "@/lib/question-insights-format";

/**
 * Read-only Question Insights actions (select top / prepare copy). They hand
 * out full question text for posting, so they need QUESTIONS_MANAGE
 * (MASTER_ADMIN, TEACHER) — the page hides the controls without it, and the
 * key is re-checked here because a Server Action is callable on its own.
 * Filters arrive as the page's query string and are re-validated server-side
 * by parseInsightFilters; ids are format-checked and only ever reach SQL as
 * bound parameters. Marking a question Needs Review
 * reuses the existing QUESTIONS_MANAGE-gated bulk-actions route instead.
 */

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const ID = /^[a-z0-9]{10,40}$/i;

const NOT_ALLOWED = "You don't have permission to copy questions.";

/** Copying prepares question text for posting — the same key as the page's other management actions. */
async function requireQuestionsManager(): Promise<boolean> {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    return true;
  } catch (error) {
    if (error instanceof UnauthorizedError) return false;
    throw error;
  }
}

function filtersFrom(query: string) {
  const filters = parseInsightFilters(Object.fromEntries(new URLSearchParams(String(query ?? "").slice(0, 2000))));
  return { filters, range: resolveRange(filters) };
}

export async function selectTopQuestionsAction(query: string, n: number): Promise<Result<string[]>> {
  if (!(await requireQuestionsManager())) return { ok: false, error: NOT_ALLOWED };
  if (!(TOP_CHOICES as readonly number[]).includes(n)) return { ok: false, error: "Invalid selection size." };
  const { filters, range } = filtersFrom(query);
  return { ok: true, data: await getTopQuestionIds(filters, range, n) };
}

export async function prepareCopyAction(input: {
  query: string;
  ids?: string[];
  top?: number;
  blockSize: number;
  includeExplanation: boolean;
}): Promise<Result<CopyPreparation & { ids: string[] }>> {
  if (!(await requireQuestionsManager())) return { ok: false, error: NOT_ALLOWED };
  const blockSize = (COPY_BLOCK_SIZES as readonly number[]).includes(input.blockSize) ? (input.blockSize as CopyBlockSize) : 0;
  const { filters, range } = filtersFrom(input.query);

  let ids: string[];
  if (typeof input.top === "number") {
    if (!(TOP_CHOICES as readonly number[]).includes(input.top)) return { ok: false, error: "Invalid top size." };
    ids = await getTopQuestionIds(filters, range, input.top);
  } else {
    if (!Array.isArray(input.ids)) return { ok: false, error: "No questions selected." };
    ids = Array.from(new Set(input.ids.filter((x) => typeof x === "string" && ID.test(x))));
    if (ids.length > MAX_COPY_QUESTIONS) return { ok: false, error: `Select at most ${MAX_COPY_QUESTIONS} questions to copy.` };
  }
  if (ids.length === 0) return { ok: false, error: "No questions to copy for these filters." };

  const prepared = await prepareQuestionCopy({ ids, filters, range, blockSize, includeExplanation: input.includeExplanation === true });
  return { ok: true, data: { ...prepared, ids } };
}
