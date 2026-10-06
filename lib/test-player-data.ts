/**
 * TEST ENGINE CORE — HIGH RISK SHARED PATH (see ops/TEST-ENGINE.md).
 *
 * The single serializer from a frozen attempt to what the student player
 * receives. Pure (no prisma, no server-only) so the regression suite can
 * assert on exactly what reaches the browser:
 *  - the correct option is NEVER included unless the server already revealed
 *    that question in an INSTANT (practice) attempt;
 *  - a malformed snapshot becomes a skippable notice instead of breaking
 *    the player;
 *  - the human explanation (snapshot v2) follows the correct option: it is
 *    only included inside `reveal`, and EXPLANATION images with it;
 *  - a v1 or PLAIN snapshot serializes exactly as before (no `rich` key).
 *  - v3 (NEET Phase 4) adds keys ONLY for advanced types: `questionType`,
 *    `selectedLabels` (MULTIPLE_CORRECT), `match` (MATCH_THE_FOLLOWING), and a
 *    MULTIPLE_CORRECT reveal carries `correctLabels` — under the same rule as
 *    `correctLabel`. A SINGLE_CORRECT question serializes exactly as before.
 * Rich text is rendered here, on the server, by lib/rich-content.ts.
 */
import { explanationView, matchView, richQuestionView } from "@/lib/rich-content";
import type { ExplanationView, MatchView, RichQuestionView } from "@/lib/rich-content-types";
import { snapshotCorrectLabels, snapshotQuestionType } from "@/lib/question-types";

export interface SnapshotLike {
  text?: unknown;
  imageUrl?: string | null;
  difficulty?: string;
  options?: unknown;
  correctLabel?: string;
  v?: unknown;
  contentFormat?: unknown;
  explanation?: unknown;
  assets?: unknown;
  questionType?: unknown;
  correctLabels?: unknown;
  matchSpec?: unknown;
}

export interface AttemptQuestionLike {
  questionId: string;
  questionSnapshot: unknown;
  answer?: { selectedOptionLabel: string | null; selectedLabels?: string[] | null; status: string; revealedAt?: Date | null } | null;
}

export interface SerializedPlayerQuestion {
  questionId: string;
  text: string;
  imageUrl: string | null;
  difficulty: string;
  options: { label: string; text: string; imageUrl: string | null }[];
  malformed: boolean;
  reveal: { correctLabel: string; correctLabels?: string[]; explanation?: ExplanationView } | null;
  selectedOptionLabel: string | null;
  markForReview: boolean;
  saved: boolean;
  /** RICH_V1 (snapshot v2/v3) only: rendered text/options and question/option images. */
  rich?: RichQuestionView;
  /** Advanced types only (snapshot v3); absent = SINGLE_CORRECT. */
  questionType?: "MULTIPLE_CORRECT" | "MATCH_THE_FOLLOWING";
  /** MULTIPLE_CORRECT only: the saved label set. */
  selectedLabels?: string[];
  /** MATCH_THE_FOLLOWING only: rendered List I / List II. */
  match?: MatchView;
}

export function isMalformedSnapshot(snapshot: SnapshotLike | null | undefined): boolean {
  const options = Array.isArray(snapshot?.options) ? (snapshot.options as { label?: unknown }[]) : [];
  const labels = options.map((o) => o?.label);
  return options.length < 2 || labels.some((l) => typeof l !== "string" || l === "") || new Set(labels).size !== labels.length;
}

export function toPlayerQuestions(
  questions: AttemptQuestionLike[],
  opts: { instantMode: boolean; savedIds?: Set<string> }
): SerializedPlayerQuestion[] {
  return questions.map((tq) => {
    const snapshot = (tq.questionSnapshot ?? {}) as SnapshotLike;
    const malformed = isMalformedSnapshot(snapshot);
    const options = malformed
      ? []
      : (snapshot.options as { label: string; text?: string; imageUrl?: string | null }[]).map((o) => ({
          label: o.label,
          text: typeof o.text === "string" ? o.text : "",
          imageUrl: o.imageUrl ?? null,
        }));
    const revealed = opts.instantMode && !!tq.answer?.revealedAt;
    const status = tq.answer?.status;
    const rich = malformed ? null : richQuestionView(snapshot);
    const explanation = revealed ? explanationView(snapshot) : null;
    const type = snapshotQuestionType(snapshot);
    const multi = type === "MULTIPLE_CORRECT";
    const match = type === "MATCH_THE_FOLLOWING" && !malformed ? matchView(snapshot) : null;
    return {
      questionId: tq.questionId,
      text: typeof snapshot.text === "string" ? snapshot.text : "",
      imageUrl: snapshot.imageUrl ?? null,
      difficulty: typeof snapshot.difficulty === "string" ? snapshot.difficulty : "",
      options,
      malformed,
      // Only a server-revealed INSTANT question ever carries its answer.
      reveal: revealed
        ? {
            correctLabel: snapshot.correctLabel ?? "",
            ...(multi ? { correctLabels: snapshotCorrectLabels(snapshot) } : {}),
            ...(explanation ? { explanation } : {}),
          }
        : null,
      selectedOptionLabel: tq.answer?.selectedOptionLabel ?? null,
      markForReview: status === "MARKED_FOR_REVIEW" || status === "ANSWERED_AND_MARKED",
      saved: opts.savedIds?.has(tq.questionId) ?? false,
      ...(rich ? { rich } : {}),
      ...(type !== "SINGLE_CORRECT" ? { questionType: type } : {}),
      ...(multi ? { selectedLabels: tq.answer?.selectedLabels ?? [] } : {}),
      ...(match ? { match } : {}),
    };
  });
}
