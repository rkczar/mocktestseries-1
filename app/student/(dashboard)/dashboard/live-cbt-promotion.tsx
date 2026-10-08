"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { AlertTriangle, CalendarClock, CheckCircle2, Clock, ListChecks, Radio, Trophy } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LiveCbtShareButton } from "@/components/student/live-cbt-share-button";
import { formatCountdown, formatIstDay, formatIstWindow } from "@/lib/live-cbt-core";
import type { LiveCbtPromotionView } from "@/lib/live-cbt";
import { enrollInLiveTestAction, type EnrollLiveTestState } from "../test-series/actions";
import { StartMockForm } from "../test-series/[mockTestId]/start-mock-form";

function EnrollNowButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending} className="w-full" data-testid="promo-enroll">
      {pending ? "Enrolling…" : "Enroll Now"}
    </Button>
  );
}

/**
 * Student Dashboard → Live CBT card (block "live-cbt-promotion"): the most
 * relevant admin-promoted Live CBT (lib/live-cbt.ts#getDashboardLiveCbtPromotion).
 * The countdown runs on a clock corrected to the server's and flips the card
 * from UPCOMING to LIVE without a reload; the buttons are the same Server
 * Actions as the test page (enroll, start/resume), so every gate —
 * enrollment, payment, window, attempt policy — is still the server's.
 */
export function LiveCbtPromotionCard({ promo, serverNow }: { promo: LiveCbtPromotionView; serverNow: number }) {
  const offset = useRef<number | null>(null);
  const [now, setNow] = useState(serverNow);
  const [enrollState, enrollAction] = useActionState<EnrollLiveTestState, FormData>(enrollInLiveTestAction, {});

  useEffect(() => {
    if (offset.current === null) offset.current = serverNow - Date.now();
    const tick = () => setNow(Date.now() + (offset.current ?? 0));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [serverNow]);

  const startsAt = new Date(promo.startsAt);
  const endsAt = new Date(promo.endsAt);
  const testHref = `/student/test-series/${promo.mockTestId}`;
  const enrolled = promo.enrolled || enrollState.enrolled === true;
  const state = promo.state === "COMPLETED" ? "COMPLETED" : now < startsAt.getTime() ? "UPCOMING" : now < endsAt.getTime() ? "LIVE" : "ENDED";
  const opensAt = promo.enrollmentOpensAt ? new Date(promo.enrollmentOpensAt).getTime() : null;
  const closesAt = promo.enrollmentClosesAt ? new Date(promo.enrollmentClosesAt).getTime() : null;
  const enrollOpen = (opensAt === null || now >= opensAt) && (closesAt === null || now < closesAt);
  const releaseAt = promo.resultReleaseAt ? new Date(promo.resultReleaseAt).getTime() : null;
  const released = promo.resultReleased || (releaseAt !== null && now >= releaseAt);

  let action: React.ReactNode;
  if (state === "COMPLETED") {
    action =
      released && promo.submittedAttemptId ? (
        <Button asChild size="lg" className="w-full">
          <Link href={`/student/attempt/${promo.submittedAttemptId}/result`} data-testid="promo-primary">
            <Trophy className="h-4 w-4" aria-hidden /> View Result
          </Link>
        </Button>
      ) : (
        <Button size="lg" variant="outline" disabled className="w-full" data-testid="promo-primary">
          Result Pending{releaseAt !== null ? ` · in ${formatCountdown(releaseAt - now)}` : ""}
        </Button>
      );
  } else if (state === "ENDED") {
    action = (
      <Button size="lg" variant="outline" disabled className="w-full" data-testid="promo-primary">
        Live Test window closed
      </Button>
    );
  } else if (!promo.accessAllowed || (promo.enrollmentEnabled && !enrolled && !enrollOpen)) {
    // Locked (paid) or enrollment not open: the test page explains and shows the right options.
    action = (
      <Button asChild size="lg" variant={state === "LIVE" ? "primary" : "outline"} className="w-full">
        <Link href={testHref} data-testid="promo-primary">
          View Live Test
        </Link>
      </Button>
    );
  } else if (promo.enrollmentEnabled && !enrolled) {
    action = (
      <form action={enrollAction} className="w-full">
        <input type="hidden" name="mockTestId" value={promo.mockTestId} />
        <EnrollNowButton />
      </form>
    );
  } else if (state === "LIVE") {
    action = promo.questionCount > 0 ? (
      <div className="w-full" data-testid="promo-start">
        <StartMockForm mockTestId={promo.mockTestId} label={promo.inProgressAttemptId ? "Resume Live Test" : "Enter Live Test"} />
      </div>
    ) : (
      <Button size="lg" disabled className="w-full">
        No questions published yet
      </Button>
    );
  } else {
    action = (
      <Button asChild size="lg" variant="outline" className="w-full">
        <Link href={testHref} data-testid="promo-primary">
          View Live Test
        </Link>
      </Button>
    );
  }

  return (
    <Card className="border-[var(--color-error)]/40" data-testid="live-cbt-promotion" data-state={state} data-enrolled={enrolled}>
      <CardContent className="flex flex-col gap-4 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="error" data-testid="promo-badge">
            <Radio className="h-3 w-3" aria-hidden /> LIVE CBT
          </Badge>
          {state === "LIVE" ? <Badge variant="warning">Live Now</Badge> : null}
          {state === "UPCOMING" ? <Badge variant="info">Upcoming</Badge> : null}
          {state === "COMPLETED" ? <Badge variant="success">Submitted</Badge> : null}
          {promo.enrollmentEnabled && enrolled && state !== "COMPLETED" ? (
            <Badge variant="success" data-testid="promo-enrolled">
              <CheckCircle2 className="h-3 w-3" aria-hidden /> Enrolled
            </Badge>
          ) : null}
        </div>
        <div className="min-w-0">
          <p className="break-words text-base font-semibold text-[var(--color-foreground)]" data-testid="promo-title">
            {promo.title}
          </p>
          <p className="text-sm text-[var(--color-muted-foreground)]">{promo.examName}</p>
          {promo.promoText ? <p className="mt-1 text-sm text-[var(--color-foreground)]">{promo.promoText}</p> : null}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
              <CalendarClock className="h-3.5 w-3.5" aria-hidden /> Date
            </dt>
            <dd className="font-medium text-[var(--color-foreground)]" data-testid="promo-date">{formatIstDay(startsAt)}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
              <Clock className="h-3.5 w-3.5" aria-hidden /> Time
            </dt>
            <dd className="font-medium text-[var(--color-foreground)]" data-testid="promo-time">{formatIstWindow(startsAt, endsAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-muted-foreground)]">Duration</dt>
            <dd className="font-medium text-[var(--color-foreground)]">{promo.durationMinutes} min</dd>
          </div>
          <div>
            <dt className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
              <ListChecks className="h-3.5 w-3.5" aria-hidden /> Questions
            </dt>
            <dd className="font-medium text-[var(--color-foreground)]">{promo.questionCount}</dd>
          </div>
        </dl>
        {state === "UPCOMING" ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Starts in{" "}
            <span className="font-mono text-lg font-bold text-[var(--color-foreground)]" data-testid="promo-countdown">
              {formatCountdown(startsAt.getTime() - now)}
            </span>
          </p>
        ) : state === "LIVE" ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Window closes in{" "}
            <span className="font-mono font-semibold text-[var(--color-foreground)]" data-testid="promo-ends-in">
              {formatCountdown(endsAt.getTime() - now)}
            </span>{" "}
            — late joiners get only the remaining time.
          </p>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="sm:flex-1">{action}</div>
          {promo.share && state !== "COMPLETED" && state !== "ENDED" ? (
            <LiveCbtShareButton url={promo.share.url} message={promo.share.message} title={promo.title} className="sm:w-40" />
          ) : null}
        </div>
        {enrollState.error ? (
          <p role="alert" className="flex items-center gap-1.5 text-sm text-[var(--color-error)]">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {enrollState.error}
          </p>
        ) : null}
        {promo.promotedCount > 1 ? (
          <Link href="/student/test-series" className="text-sm font-medium text-[var(--color-primary)] hover:underline" data-testid="promo-all">
            View all Live Tests ({promo.promotedCount}) →
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
