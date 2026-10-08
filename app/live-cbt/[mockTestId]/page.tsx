import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarClock, CheckCircle2, Clock, ListChecks, Lock, Radio } from "lucide-react";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { LiveCbtShareButton } from "@/components/student/live-cbt-share-button";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getLiveCbtInvitation } from "@/lib/live-cbt";
import { formatIstDay, formatIstWindow, liveCbtInvitePath, liveCbtLoginHref } from "@/lib/live-cbt-core";
import { getStudentSession } from "@/lib/student-session";
import { getSiteUrl } from "@/lib/site-url";
import { BRAND_NAME } from "@/lib/brand";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ mockTestId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { mockTestId } = await params;
  const siteUrl = await getSiteUrl();
  const invite = await getLiveCbtInvitation(mockTestId, siteUrl);
  if (!invite) return { title: `Live CBT — ${BRAND_NAME}`, robots: { index: false, follow: false } };
  const title = `${invite.title} — Live CBT | ${BRAND_NAME}`;
  const description = `${invite.examName} Live CBT on ${formatIstDay(invite.startsAt)}, ${formatIstWindow(invite.startsAt, invite.endsAt)}. A real-time computer-based mock test — enroll and compete with other aspirants.`;
  const url = `${siteUrl}${liveCbtInvitePath(invite.mockTestId)}`;
  return {
    title,
    description,
    // A dated invitation, not an evergreen page: shared, never indexed.
    robots: { index: false, follow: true },
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "website", siteName: BRAND_NAME },
    twitter: { card: "summary", title, description },
  };
}

/**
 * Public Live CBT invitation — the URL the Share buttons send. Anyone can
 * read it signed out; it shows only the admin-configured test details (never
 * questions, students or results). Enroll goes to login/register with the
 * test page as the callback, and the test page's own server gates
 * (enrollment, payment, window, result release) decide everything after
 * that. 404 unless the test is published, windowed and sharing is ON.
 */
export default async function LiveCbtInvitationPage({ params }: Params) {
  const { mockTestId } = await params;
  const [siteUrl, session] = await Promise.all([getSiteUrl(), getStudentSession()]);
  const invite = await getLiveCbtInvitation(mockTestId, siteUrl);
  if (!invite) notFound();

  const signedIn = Boolean(session?.user);
  const testHref = `/student/test-series/${encodeURIComponent(invite.mockTestId)}`;
  const ended = invite.phase === "CLOSED";
  const enrollmentNote = !invite.enrollmentEnabled
    ? null
    : invite.enrollmentState === "NOT_OPEN_YET"
      ? "Enrollment has not opened yet."
      : invite.enrollmentState === "CLOSED"
        ? "Enrollment for this test has closed."
        : "Enrollment is open.";

  return (
    <PublicPageShell>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10 sm:px-6" data-testid="live-cbt-invitation" data-phase={invite.phase}>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="error">
              <Radio className="h-3 w-3" aria-hidden /> LIVE CBT
            </Badge>
            {invite.phase === "LIVE_NOW" ? <Badge variant="warning">Live Now</Badge> : null}
            {invite.phase === "UPCOMING" ? <Badge variant="info">Upcoming</Badge> : null}
            {ended ? <Badge variant="neutral">Ended</Badge> : null}
          </div>
          <h1 className="break-words text-2xl font-semibold text-[var(--color-foreground)]" data-testid="invite-title">
            {invite.title}
          </h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">{invite.examName}</p>
          {invite.promoText ? <p className="text-sm text-[var(--color-foreground)]">{invite.promoText}</p> : null}
        </div>

        <Card>
          <CardContent className="grid grid-cols-2 gap-4 pt-5 text-sm sm:grid-cols-4">
            <div>
              <p className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
                <CalendarClock className="h-3.5 w-3.5" aria-hidden /> Date
              </p>
              <p className="font-semibold text-[var(--color-foreground)]" data-testid="invite-date">{formatIstDay(invite.startsAt)}</p>
            </div>
            <div>
              <p className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
                <Clock className="h-3.5 w-3.5" aria-hidden /> Time
              </p>
              <p className="font-semibold text-[var(--color-foreground)]" data-testid="invite-time">{formatIstWindow(invite.startsAt, invite.endsAt)}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Duration</p>
              <p className="font-semibold text-[var(--color-foreground)]">{invite.durationMinutes} min</p>
            </div>
            <div>
              <p className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
                <ListChecks className="h-3.5 w-3.5" aria-hidden /> Questions
              </p>
              <p className="font-semibold text-[var(--color-foreground)]">{invite.questionCount}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-2 pt-5 text-sm text-[var(--color-muted-foreground)]">
            <p className="font-medium text-[var(--color-foreground)]">What is a Live CBT?</p>
            <ul className="flex flex-col gap-1.5">
              {[
                "A real-time computer-based mock test: every candidate takes it in the same fixed window.",
                "Enroll before the start; the test opens for enrolled students at the scheduled time.",
                "Joining late gives you only the remaining time — the test closes for everyone at the end of the window.",
                "Results, answers and the leaderboard are released as scheduled by the organizers.",
              ].map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden /> {line}
                </li>
              ))}
            </ul>
            {invite.paid ? (
              <p className="flex items-center gap-1.5 text-xs">
                <Lock className="h-3.5 w-3.5" aria-hidden /> This test needs paid access; you can unlock it on the test page.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="sm:flex-1">
            {ended ? (
              <Button size="lg" variant="outline" disabled className="w-full" data-testid="invite-cta">
                This Live CBT has ended
              </Button>
            ) : signedIn ? (
              <Button asChild size="lg" className="w-full">
                <Link href={testHref} data-testid="invite-cta">
                  {invite.phase === "LIVE_NOW" ? "Go to Live Test" : "Enroll Now"}
                </Link>
              </Button>
            ) : (
              <Button asChild size="lg" className="w-full">
                <Link href={liveCbtLoginHref(invite.mockTestId)} data-testid="invite-cta">
                  Login / Register to Enroll
                </Link>
              </Button>
            )}
          </div>
          {ended ? null : <LiveCbtShareButton url={invite.share.url} message={invite.share.message} title={invite.title} className="sm:w-40" />}
        </div>
        {enrollmentNote && !ended ? (
          <p className="text-center text-xs text-[var(--color-muted-foreground)]" data-testid="invite-enrollment">
            {enrollmentNote}
          </p>
        ) : null}
      </div>
    </PublicPageShell>
  );
}
