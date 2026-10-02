/**
 * Pure clipboard-text builder for Admin → Analytics → Question Insights
 * ("Copy Top 10/20/Selected"). No Prisma / server-only imports, so the
 * server action and the client preview share the exact same output.
 *
 * The output is deliberately PLAIN text — no Telegram/WhatsApp markdown
 * (`*bold*`, `_italic_`) — so it pastes cleanly into Telegram, WhatsApp,
 * email or anywhere else. It only ever contains question content and
 * aggregate percentages: never a student name, email, phone, id or any
 * individual performance.
 */
import { toShareText } from "@/lib/whatsapp-share-template";

export const COPY_SITE_NAME = "MockTestSeries.in";
export const COPY_SEPARATOR = "━━━━━━━━━━━━━━━━━━";
export const COPY_BLOCK_SIZES = [0, 5, 10] as const; // 0 = all selected in one block
export type CopyBlockSize = (typeof COPY_BLOCK_SIZES)[number];

/** One question exactly as stored (canonical, not the attempt snapshot) plus its aggregate stats for the period. */
export interface CopyQuestion {
  id: string;
  code: string;
  text: string;
  imageUrl: string | null;
  options: { label: string; text: string; imageUrl: string | null; isCorrect: boolean }[];
  /** null when the question had no valid answered attempts in the period (e.g. picked from Most Reported). */
  wrongPct: number | null;
  /** Existing cached explanation text, or null — never generated for the copy. */
  explanation: string | null;
}

export type CopyIssue = "NO_CORRECT_OPTION" | "MULTIPLE_CORRECT_OPTIONS";

/** Exactly one option must be marked correct; anything else is a data issue and must never be posted with an invented answer. */
export function answerKeyIssue(options: { isCorrect: boolean }[]): CopyIssue | null {
  const correct = options.filter((o) => o.isCorrect).length;
  if (correct === 0) return "NO_CORRECT_OPTION";
  if (correct > 1) return "MULTIPLE_CORRECT_OPTIONS";
  return null;
}

export const COPY_ISSUE_LABEL: Record<CopyIssue, string> = {
  NO_CORRECT_OPTION: "No correct option set",
  MULTIPLE_CORRECT_OPTIONS: "More than one correct option",
};

function optionText(o: { text: string; imageUrl: string | null }): string {
  return toShareText(o.text) || (o.imageUrl ? "(image — see website)" : "");
}

/** Whole-number percentage the way students read it ("68%"), clamped to 0–100. */
export function formatPct(value: number): string {
  return `${Math.min(100, Math.max(0, Math.round(value)))}%`;
}

export function hasAnyImage(q: { imageUrl: string | null; options: { imageUrl: string | null }[] }): boolean {
  return Boolean(q.imageUrl) || q.options.some((o) => Boolean(o.imageUrl));
}

function renderQuestion(q: CopyQuestion, n: number, includeExplanation: boolean): string {
  const correct = q.options.find((o) => o.isCorrect)!;
  const lines: string[] = [`Q${n}. ${toShareText(q.text)}`];
  if (hasAnyImage(q)) lines.push("", `🖼 This question has an image — view it on ${COPY_SITE_NAME}`);
  lines.push("");
  for (const o of q.options) lines.push(`${o.label.trim()}. ${optionText(o)}`.trimEnd());
  lines.push("", `✅ Correct Answer: ${correct.label.trim()}. ${optionText(correct)}`.trimEnd());
  if (q.wrongPct !== null) lines.push(`📊 ${formatPct(q.wrongPct)} students answered incorrectly.`);
  if (includeExplanation && q.explanation) lines.push("", `💡 Explanation: ${toShareText(q.explanation)}`);
  return lines.join("\n");
}

export interface CopyBlock {
  /** 1-based question numbers covered by this block, e.g. 11–20. */
  from: number;
  to: number;
  text: string;
}

export interface BuildCopyResult {
  blocks: CopyBlock[];
  /** Questions left out of the copy because their answer key is broken. */
  excluded: { id: string; code: string; issue: CopyIssue }[];
  includedCount: number;
}

/**
 * Builds the clipboard block(s). Questions with a broken answer key are
 * excluded (and reported) rather than posted with a guessed answer.
 * Numbering runs continuously across blocks (Block 2 starts at Q11), and
 * every block carries the header and footer so each paste stands alone.
 */
export function buildCopyBlocks(params: {
  questions: CopyQuestion[];
  headline: string;
  subtitle: string;
  blockSize: CopyBlockSize;
  includeExplanation: boolean;
}): BuildCopyResult {
  const excluded: BuildCopyResult["excluded"] = [];
  const valid: CopyQuestion[] = [];
  for (const q of params.questions) {
    const issue = answerKeyIssue(q.options);
    if (issue) excluded.push({ id: q.id, code: q.code, issue });
    else valid.push(q);
  }

  const size = params.blockSize > 0 ? params.blockSize : Math.max(1, valid.length);
  const chunks: CopyQuestion[][] = [];
  for (let i = 0; i < valid.length; i += size) chunks.push(valid.slice(i, i + size));

  const footer = `📚 Practice more:\n${COPY_SITE_NAME}`;
  const blocks = chunks.map((chunk, index) => {
    const start = index * size + 1;
    const part = chunks.length > 1 ? ` (Part ${index + 1}/${chunks.length})` : "";
    const header = `${params.headline}${part}\n${params.subtitle}`;
    const body = chunk.map((q, i) => renderQuestion(q, start + i, params.includeExplanation)).join(`\n\n${COPY_SEPARATOR}\n\n`);
    return { from: start, to: start + chunk.length - 1, text: `${header}\n\n${body}\n\n${COPY_SEPARATOR}\n\n${footer}` };
  });

  return { blocks, excluded, includedCount: valid.length };
}
