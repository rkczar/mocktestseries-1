"use client";

import { useState, useTransition } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { chooseExamAction } from "../welcome/actions";
import { trackEvent } from "@/lib/analytics-events";

type PopupExam = { id: string; code: string; name: string; shortName: string };

/** Mandatory "Select Your Exam" popup: shown on the Dashboard only while the student has no active-exam enrollment. */
export function ExamEnrollPopup({ exams }: { exams: PopupExam[] }) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function choose(exam: PopupExam) {
    if (isPending) return; // one enrollment request at a time
    setError(null);
    setPendingId(exam.id);
    startTransition(async () => {
      trackEvent("exam_enroll", { exam_code: exam.code, source: "dashboard_popup" });
      try {
        // Success redirects to the Dashboard, which no longer renders this popup.
        const r = await chooseExamAction(exam.id);
        if (r?.error) setError(r.error);
      } catch (e) {
        // redirect() surfaces as a thrown NEXT_REDIRECT on success: let Next handle it.
        if ((e as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw e;
        setError("Could not save your exam. Please check your connection and try again.");
      }
      setPendingId(null);
    });
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="max-h-[90dvh] max-w-lg overflow-y-auto [&>button:last-child]:hidden"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        data-testid="exam-enroll-popup"
      >
        <DialogTitle className="text-lg font-semibold text-[var(--color-foreground)]">Select Your Exam</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Choose the exam you are preparing for to open your dashboard.
        </DialogDescription>
        {exams.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--color-muted-foreground)]">No exams are available right now. Please check back soon.</p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {exams.map((exam) => (
              <button
                key={exam.id}
                type="button"
                disabled={isPending}
                onClick={() => choose(exam)}
                aria-busy={pendingId === exam.id}
                data-testid={`exam-enroll-${exam.code}`}
                className="flex min-h-20 flex-col items-start justify-center gap-1 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left transition hover:border-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="font-semibold text-[var(--color-foreground)]">{exam.shortName}</span>
                {pendingId === exam.id || exam.name !== exam.shortName ? (
                  <span className="text-xs text-[var(--color-muted-foreground)]">
                    {pendingId === exam.id ? "Enrolling…" : exam.name}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
        {error ? (
          <p role="alert" className="mt-3 text-sm text-[var(--color-error)]">
            {error}
          </p>
        ) : null}
        <p className="mt-4 text-xs text-[var(--color-muted-foreground)]">
          Note: You can change your exam later in the My Exams section.
        </p>
      </DialogContent>
    </Dialog>
  );
}
