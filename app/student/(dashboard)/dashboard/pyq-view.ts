import "server-only";
import { getDashboardPreviousYearPapers } from "@/lib/student-data";
import { evaluateContentAccess, loadAccessContext, paywallHref } from "@/lib/payments/access";

/**
 * Flat, client-safe shape for the dashboard's Previous Year Papers section.
 * Access is evaluated here with the same evaluateContentAccess rule the exam
 * page uses; it's display only — startPreviousYearPaperAttempt and the run
 * page re-check entitlement server-side regardless.
 */
export interface DashboardPaperView {
  id: string;
  title: string;
  year: number;
  paperCode: string | null;
  questionCount: number;
  inProgressAttemptId: string | null;
  lastSubmittedAttemptId: string | null;
  locked: null | { label: "Premium" | "Expired"; ctaLabel: "Unlock" | "Renew"; href: string | null };
}

export async function getDashboardPaperViews(studentId: string, examId: string): Promise<DashboardPaperView[]> {
  const [papers, ctx] = await Promise.all([getDashboardPreviousYearPapers(studentId, examId), loadAccessContext(studentId)]);
  return papers.map((p) => {
    const access = evaluateContentAccess(ctx, { kind: "PREVIOUS_YEAR_PAPER", id: p.id, examId: p.examId });
    const expired = access.status === "EXPIRED";
    const canBuy = access.status !== "NOT_AVAILABLE" && !access.purchasesPaused;
    return {
      id: p.id,
      title: p.title,
      year: p.year,
      paperCode: p.paperCode,
      questionCount: p.questionCount,
      inProgressAttemptId: p.inProgressAttemptId,
      lastSubmittedAttemptId: p.lastSubmittedAttemptId,
      locked: access.allowed
        ? null
        : { label: expired ? "Expired" : "Premium", ctaLabel: expired ? "Renew" : "Unlock", href: canBuy ? paywallHref(access) : null },
    };
  });
}
