"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Clock, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCountdown } from "@/lib/live-cbt-core";
import { enrollInLiveTestAction, type EnrollLiveTestState } from "../actions";
import { StartMockForm } from "./start-mock-form";

export interface LiveCbtPanelProps {
  mockTestId: string;
  /** Server clock at render (ms) — the client only corrects its own clock by it. */
  serverNow: number;
  startsAt: number | null;
  endsAt: number | null;
  enrolled: boolean;
  enrollmentOpensAt: number | null;
  /** Effective close (own close time, else the window end). */
  enrollmentClosesAt: number | null;
  /** The student's latest SUBMITTED attempt, if any. */
  submitted: { attemptId: string; resultReleaseAt: number | null } | null;
  /** Labels for times, pre-formatted on the server in IST. */
  labels: { startsAt: string | null; endsAt: string | null; opensAt: string | null; resultReleaseAt: string | null };
  canStart: boolean;
}

function EnrollButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full" data-testid="enroll-button">
      {pending ? "Enrolling…" : "Enroll in Live Test"}
    </Button>
  );
}

/**
 * Live CBT state on the Mock Test page: Enroll → "You're Enrolled · Starts
 * in" → (at the start instant, no reload) Start Live Test → Completed. The
 * countdown is UI only, on a clock corrected to the server's; every button
 * goes through the server gates (lib/live-cbt.ts, lib/test-attempt.ts), and
 * each boundary also soft-refreshes the server-rendered data.
 */
export function LiveCbtPanel(p: LiveCbtPanelProps) {
  const router = useRouter();
  const offset = useRef<number | null>(null);
  const [now, setNow] = useState(p.serverNow);
  const [state, formAction] = useActionState<EnrollLiveTestState, FormData>(enrollInLiveTestAction, {});

  useEffect(() => {
    if (offset.current === null) offset.current = p.serverNow - Date.now();
    const tick = () => setNow(Date.now() + (offset.current ?? 0));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [p.serverNow]);

  const phase = p.startsAt !== null && now < p.startsAt ? "BEFORE" : p.endsAt !== null && now >= p.endsAt ? "CLOSED" : "LIVE";
  const enrollState =
    p.enrollmentOpensAt !== null && now < p.enrollmentOpensAt ? "NOT_OPEN" : p.enrollmentClosesAt !== null && now >= p.enrollmentClosesAt ? "CLOSED" : "OPEN";
  const released = p.submitted ? p.submitted.resultReleaseAt === null || now >= p.submitted.resultReleaseAt : false;

  // Re-sync server-rendered state at each boundary (start, end, enrollment open, result release).
  const boundary = `${phase}|${enrollState}|${released}`;
  const lastBoundary = useRef(boundary);
  useEffect(() => {
    if (lastBoundary.current !== boundary) {
      lastBoundary.current = boundary;
      router.refresh();
    }
  }, [boundary, router]);
  useEffect(() => {
    if (state.enrolled) router.refresh();
  }, [state.enrolled, router]);

  const enrolled = p.enrolled || state.enrolled === true;

  if (p.submitted) {
    return (
      <div className="flex flex-col gap-2 text-center" data-testid="live-cbt-panel" data-phase="SUBMITTED">
        <p className="flex items-center justify-center gap-1.5 font-semibold text-[var(--color-foreground)]">
          <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" aria-hidden />
          {phase === "CLOSED" ? "Live Test Completed" : "Live Test Submitted"}
        </p>
        {released ? (
          <Button asChild size="lg" className="w-full">
            <Link href={`/student/attempt/${p.submitted.attemptId}/result`}>
              <Trophy className="h-4 w-4" aria-hidden /> View Result
            </Link>
          </Button>
        ) : (
          <p className="text-sm text-[var(--color-muted-foreground)]" data-testid="result-releases">
            Result, answers and leaderboard release {p.labels.resultReleaseAt ? `at ${p.labels.resultReleaseAt}` : "soon"}
            {p.submitted.resultReleaseAt !== null ? ` · in ${formatCountdown(p.submitted.resultReleaseAt - now)}` : ""}
          </p>
        )}
      </div>
    );
  }

  if (phase === "CLOSED") {
    return (
      <div className="flex flex-col gap-1 text-center" data-testid="live-cbt-panel" data-phase="CLOSED">
        <p className="font-semibold text-[var(--color-foreground)]">Live Test Completed</p>
        <p className="text-sm text-[var(--color-muted-foreground)]">The test window has closed. New attempts are no longer accepted.</p>
      </div>
    );
  }

  if (!enrolled) {
    return (
      <div className="flex flex-col gap-3" data-testid="live-cbt-panel" data-phase={`${phase}-NOT-ENROLLED`}>
        {phase === "BEFORE" && p.startsAt !== null ? (
          <p className="text-center text-sm text-[var(--color-muted-foreground)]">
            Starts in <span className="font-mono font-semibold text-[var(--color-foreground)]" data-testid="starts-in">{formatCountdown(p.startsAt - now)}</span>
          </p>
        ) : null}
        {enrollState === "OPEN" ? (
          <form action={formAction} className="flex flex-col gap-2">
            <input type="hidden" name="mockTestId" value={p.mockTestId} />
            <EnrollButton />
          </form>
        ) : enrollState === "NOT_OPEN" ? (
          <Button size="lg" disabled className="w-full">
            Enrollment opens {p.labels.opensAt ? p.labels.opensAt : "soon"}
            {p.enrollmentOpensAt !== null ? ` · in ${formatCountdown(p.enrollmentOpensAt - now)}` : ""}
          </Button>
        ) : (
          <Button size="lg" disabled className="w-full">
            Enrollment closed
          </Button>
        )}
        {state.error ? (
          <p role="alert" className="flex items-center gap-1.5 text-sm text-[var(--color-error)]">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {state.error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="live-cbt-panel" data-phase={`${phase}-ENROLLED`}>
      <p className="flex items-center justify-center gap-1.5 font-semibold text-[var(--color-success)]" data-testid="enrolled-badge">
        <CheckCircle2 className="h-5 w-5" aria-hidden /> You&apos;re Enrolled
      </p>
      {phase === "BEFORE" && p.startsAt !== null ? (
        <>
          <p className="text-center text-sm text-[var(--color-muted-foreground)]">
            Starts in{" "}
            <span className="block font-mono text-3xl font-bold text-[var(--color-foreground)]" data-testid="starts-in">
              {formatCountdown(p.startsAt - now)}
            </span>
          </p>
          <Button size="lg" disabled className="w-full">
            <Clock className="h-4 w-4" aria-hidden /> Starts {p.labels.startsAt}
          </Button>
        </>
      ) : p.canStart ? (
        <>
          <StartMockForm mockTestId={p.mockTestId} label="Start Live Test" />
          {p.endsAt !== null ? (
            <p className="text-center text-xs text-[var(--color-muted-foreground)]">
              Window closes in <span className="font-mono" data-testid="ends-in">{formatCountdown(p.endsAt - now)}</span> — your attempt ends then.
            </p>
          ) : null}
        </>
      ) : (
        <Button size="lg" disabled className="w-full">
          No questions published yet
        </Button>
      )}
    </div>
  );
}
