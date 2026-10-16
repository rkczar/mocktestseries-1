/**
 * Server-side checks for the Premium review gate and Unlock destinations
 * (lib/payments/access.ts#getAttemptReviewAccess / paywallHref,
 * lib/student-data.ts#getAnswerRevealStatuses / isQuestionReviewableInAttempt
 * / getSavedQuestions). Run after scripts/premium-conversion-fixture.ts setup.
 *
 *   FIXTURE=<dir>/pcqa.json DATABASE_URL=<scratch *premium*> NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-premium-conversion.ts
 *
 * Toggles Premium enforcement OFF and back ON on the scratch DB (restored
 * before exit). Refuses to run unless DATABASE_URL names a *premium* DB.
 */
import "dotenv/config";
import fs from "node:fs";

if (!/premium/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a *premium* scratch database.");
  process.exit(2);
}
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE!, "utf8"));

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

async function main() {
  const { prisma } = await import("../lib/prisma");
  const access = await import("../lib/payments/access");
  const data = await import("../lib/student-data");
  const { bumpPremiumPolicyCache } = await import("../lib/premium-policy");
  const { getTrialStatus } = await import("../lib/premium-trial");
  const { getStudentExamAccessSummaries } = await import("../lib/payments/student-access");
  const S = F.students as Record<string, string>;
  const A = F.attempts as Record<string, string>;
  const qPaid = F.questions.paid as string[];
  const qFree = F.questions.free as string[];

  const snapshot = async () =>
    JSON.stringify(
      await prisma.testAttempt.findMany({
        where: { studentId: { in: Object.values(S) } },
        orderBy: { id: "asc" },
        select: { id: true, status: true, score: true, maxScore: true, correctCount: true, incorrectCount: true, unansweredCount: true, submittedAt: true, _count: { select: { questions: true } } },
      })
    );
  const before = await snapshot();

  const review = async (persona: string, attemptKey: string) => {
    const attempt = await data.getOwnedAttempt(A[attemptKey], S[persona]);
    if (!attempt) throw new Error(`attempt ${attemptKey} not owned by ${persona}`);
    return access.getAttemptReviewAccess(S[persona], attempt);
  };
  const paperAccess = (persona: string, paper: "free" | "paid") =>
    access.getContentAccess(S[persona], { kind: "PREVIOUS_YEAR_PAPER", id: F.papers[paper], examId: F.examId });

  console.log("1. Free student");
  {
    const free = await paperAccess("free", "free");
    check("Free 2024 paper stays free (FREE_ACCESS)", free.allowed && free.status === "FREE_ACCESS", free.status);
    const paid = await paperAccess("free", "paid");
    check("Premium paper is locked for a free student", !paid.allowed && paid.premium === true, paid.status);
    check("…the free trial is still offered to a student who never used it", paid.trialUnused === true);
    check("Unlock (trial unused) → dashboard trial / Premium options popup", access.paywallHref(paid) === "/student/dashboard?premium=locked", access.paywallHref(paid));
    check("…same lock without a trial to offer → the Premium plan checkout", access.paywallHref({ ...paid, trialUnused: false }) === `/student/checkout/${F.premium.code}`);
    check("…purchases paused → the plan list, never a dead link", access.paywallHref({ ...paid, trialUnused: false, purchasesPaused: true }) === "/student/plans?locked=1");
    const r = await review("free", "freeFree");
    check("Free paper review stays available", r.allowed);
  }

  console.log("2. Active trial");
  {
    const paid = await paperAccess("trialActive", "paid");
    check("Premium paper allowed during the trial", paid.allowed && paid.viaTrial === true, paid);
    const r = await review("trialActive", "trialActivePaid");
    check("Premium review allowed during the trial", r.allowed && r.viaTrial === true);
    const st = await data.getAnswerRevealStatuses(S.trialActive, qPaid);
    check("Premium answers revealable during the trial", qPaid.every((q) => st.get(q) === "REVEALABLE"), [...st]);
  }

  console.log("3. Trial expired after a Premium paper was attempted");
  {
    const paid = await paperAccess("trialExpired", "paid");
    check("Premium paper locked after the trial", !paid.allowed, paid.status);
    check("…no trial offer once the trial was used", paid.trialUnused === false);
    check("…so Unlock goes straight to the Premium plan checkout", access.paywallHref(paid) === `/student/checkout/${F.premium.code}`, access.paywallHref(paid));
    const r = await review("trialExpired", "trialExpiredPaid");
    check("Premium review DENIED after the trial (attempt record alone grants nothing)", !r.allowed && r.status === "PAYMENT_REQUIRED", r.status);
    check("…locked review links to the Premium checkout", access.paywallHref(r) === `/student/checkout/${F.premium.code}`);
    const rf = await review("trialExpired", "trialExpiredFree");
    check("Free 2024 paper review still available after the trial", rf.allowed);
    const st = await data.getAnswerRevealStatuses(S.trialExpired, [...qPaid, ...qFree]);
    check("Premium questions → PREMIUM_LOCKED (Saved Questions / Ask AI rule)", qPaid.every((q) => st.get(q) === "PREMIUM_LOCKED"), [...st]);
    check("Free-paper questions stay REVEALABLE", qFree.every((q) => st.get(q) === "REVEALABLE"), [...st]);
    check("Ask AI from the Premium review is refused (isQuestionReviewableInAttempt)", !(await data.isQuestionReviewableInAttempt(S.trialExpired, A.trialExpiredPaid, qPaid[0])));
    check("Ask AI from the free review still allowed", await data.isQuestionReviewableInAttempt(S.trialExpired, A.trialExpiredFree, qFree[0]));
    const saved = await data.getSavedQuestions(S.trialExpired);
    const sp = saved.find((q) => q.id === qPaid[0]);
    const sf = saved.find((q) => q.id === qFree[0]);
    check("Saved Premium question: text, options, explanation withheld", Boolean(sp) && sp!.lockReason === "PREMIUM_LOCKED" && sp!.text === "" && sp!.options.length === 0 && !sp!.explanation && !sp!.rich, sp);
    check("…its payload has no Premium marker at all", !JSON.stringify(sp).includes("PCQAPAID"));
    check("Saved free question: answer + explanation still shown", Boolean(sf?.answerRevealed) && sf!.options.some((o) => o.isCorrect === true) && Boolean(sf!.explanation), sf);
  }

  console.log("4. Active paid student");
  {
    const r = await review("paid", "paidPaid");
    check("Premium review allowed with an active Premium entitlement", r.allowed && r.status === "ACTIVE_SUBSCRIPTION" && !r.viaTrial);
    const st = await data.getAnswerRevealStatuses(S.paid, qPaid);
    check("Premium answers revealable", qPaid.every((q) => st.get(q) === "REVEALABLE"));
    check("Ask AI from the Premium review allowed", await data.isQuestionReviewableInAttempt(S.paid, A.paidPaid, qPaid[0]));
  }

  console.log("5. Paid plan expired");
  {
    const r = await review("paidExpired", "paidExpiredPaid");
    check("Premium review denied once the paid entitlement expired", !r.allowed && r.status === "EXPIRED", r.status);
  }

  console.log("6. Ownership");
  {
    check("Another student's attempt is not returned (getOwnedAttempt)", (await data.getOwnedAttempt(A.paidPaid, S.other)) === null);
    check("Ask AI via someone else's attempt id is refused", !(await data.isQuestionReviewableInAttempt(S.other, A.paidPaid, qPaid[0])));
    const st = await data.getAnswerRevealStatuses(S.other, qPaid);
    check("Never-attempted questions stay NO_ACCESS", qPaid.every((q) => st.get(q) === "NO_ACCESS"));
  }

  console.log("7. Upgrade card data (authoritative state)");
  {
    const exams = [{ id: F.examId, name: "PCQA MEDICAL OFFICER EXAM 2026" }];
    for (const [persona, wantState, wantPhase] of [
      ["free", "FREE", "ELIGIBLE"],
      ["trialActive", "FREE", "ACTIVE"],
      ["trialExpired", "FREE", "EXPIRED"],
      ["paidExpired", "EXPIRED", "ELIGIBLE"],
      ["paid", "ACTIVE", "PAID"],
    ] as const) {
      const [summary] = await getStudentExamAccessSummaries(S[persona], exams);
      const trial = await getTrialStatus(S[persona]);
      check(`${persona}: access state ${wantState}, trial phase ${wantPhase}, checkout link ${wantState === "ACTIVE" ? "n/a" : "present"}`, summary?.state === wantState && trial.phase === wantPhase && (wantState === "ACTIVE" || Boolean(summary?.checkoutHref)), { state: summary?.state, phase: trial.phase, href: summary?.checkoutHref });
    }
  }

  console.log("8. Enforcement OFF restores the legacy rules (no competing system)");
  {
    const row = await prisma.setting.findUniqueOrThrow({ where: { key: "access.premium_policy" } });
    const value = row.value as Record<string, unknown>;
    try {
      await prisma.setting.update({ where: { key: "access.premium_policy" }, data: { value: { ...value, enforcementEnabled: false } } });
      bumpPremiumPolicyCache();
      const r = await review("trialExpired", "trialExpiredPaid");
      check("Enforcement OFF: the legacy decision applies (PYQ not sold separately → open)", r.allowed && r.status === "FREE_ACCESS", r.status);
    } finally {
      await prisma.setting.update({ where: { key: "access.premium_policy" }, data: { value: value as object } });
      bumpPremiumPolicyCache();
    }
    const again = await review("trialExpired", "trialExpiredPaid");
    check("Enforcement back ON: locked again", !again.allowed);
  }

  console.log("9. Results and history unchanged");
  {
    const after = await snapshot();
    check("Every attempt row (status, score, counts, questions) is identical after all checks", before === after);
    const sub = await prisma.testAttempt.findUniqueOrThrow({ where: { id: A.trialExpiredPaid } });
    check("Locked attempt keeps its score and SUBMITTED status", sub.status === "SUBMITTED" && sub.score !== null && sub.maxScore !== null);
    const hist = await data.getStudentAttemptHistory(S.trialExpired);
    check("History still lists both attempts", hist.length === 2);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
