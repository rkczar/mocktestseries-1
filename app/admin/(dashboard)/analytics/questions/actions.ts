"use server";

import { getAdminSession } from "@/lib/rbac";
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
 * Read-only Question Insights actions. Same access rule as the rest of
 * Admin → Analytics: any signed-in, active admin (MASTER_ADMIN, FULL_ADMIN,
 * TEACHER) — re-checked here because a Server Action is callable on its own,
 * not only from the page. Filters arrive as the page's query string and are
 * re-validated server-side by parseInsightFilters; ids are format-checked and
 * only ever reach SQL as bound parameters. Marking a question Needs Review
 * reuses the existing QUESTIONS_MANAGE-gated bulk-actions route instead.
 */

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const ID = /^[a-z0-9]{10,40}$/i;

async function requireAdmin(): Promise<boolean> {
  const session = await getAdminSession();
  return Boolean(session?.user);
}

function filtersFrom(query: string) {
  const filters = parseInsightFilters(Object.fromEntries(new URLSearchParams(String(query ?? "").slice(0, 2000))));
  return { filters, range: resolveRange(filters) };
}

export async function selectTopQuestionsAction(query: string, n: number): Promise<Result<string[]>> {
  if (!(await requireAdmin())) return { ok: false, error: "Your admin session has expired. Sign in again." };
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
  if (!(await requireAdmin())) return { ok: false, error: "Your admin session has expired. Sign in again." };
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
