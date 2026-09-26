/**
 * TEST ENGINE CORE — HIGH RISK SHARED PATH (see ops/TEST-ENGINE.md).
 *
 * The single serializer from a frozen attempt to what the student player
 * receives. Pure (no prisma, no server-only) so the regression suite can
 * assert on exactly what reaches the browser:
 *  - the correct option is NEVER included unless the server already revealed
 *    that question in an INSTANT (practice) attempt;
 *  - a malformed snapshot becomes a skippable notice instead of breaking
 *    the player.
 */
export interface SnapshotLike {
  text?: unknown;
  imageUrl?: string | null;
  difficulty?: string;
  options?: unknown;
  correctLabel?: string;
}

export interface AttemptQuestionLike {
  questionId: string;
  questionSnapshot: unknown;
  answer?: { selectedOptionLabel: string | null; status: string; revealedAt?: Date | null } | null;
}

export interface SerializedPlayerQuestion {
  questionId: string;
  text: string;
  imageUrl: string | null;
  difficulty: string;
  options: { label: string; text: string; imageUrl: string | null }[];
  malformed: boolean;
  reveal: { correctLabel: string } | null;
  selectedOptionLabel: string | null;
  markForReview: boolean;
  saved: boolean;
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
    return {
      questionId: tq.questionId,
      text: typeof snapshot.text === "string" ? snapshot.text : "",
      imageUrl: snapshot.imageUrl ?? null,
      difficulty: typeof snapshot.difficulty === "string" ? snapshot.difficulty : "",
      options,
      malformed,
      // Only a server-revealed INSTANT question ever carries its answer.
      reveal: revealed ? { correctLabel: snapshot.correctLabel ?? "" } : null,
      selectedOptionLabel: tq.answer?.selectedOptionLabel ?? null,
      markForReview: status === "MARKED_FOR_REVIEW" || status === "ANSWERED_AND_MARKED",
      saved: opts.savedIds?.has(tq.questionId) ?? false,
    };
  });
}
