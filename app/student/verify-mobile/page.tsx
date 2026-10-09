import { redirect } from "next/navigation";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { Card } from "@/components/ui/card";
import { safeStudentCallback, DEFAULT_STUDENT_DESTINATION } from "@/lib/student-callback";
import { requireStudentAllowUnverified, StudentUnauthorizedError, VERIFY_MOBILE_PATH } from "@/lib/student-session";
import { getMobileVerificationState } from "@/lib/mobile-verification";
import { getStudentRecoveryState } from "@/lib/account-recovery";
import { studentLogoutAction } from "../(dashboard)/actions";
import { VerifyMobileForm } from "./verify-mobile-form";

export const metadata = { title: "Verify Mobile Number — Mock Test Series.in", robots: { index: false } };

/**
 * One-time mobile verification for a signed-in student (existing accounts,
 * Google sign-ups). requireStudent()/proxy send every unverified student here
 * while the Admin switch is ON; the only other things this restricted session
 * can do are sign out and reach support.
 */
export default async function VerifyMobilePage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  const { callbackUrl } = await searchParams;
  let destination = safeStudentCallback(callbackUrl);
  if (destination.split(/[?#]/)[0] === VERIFY_MOBILE_PATH) destination = DEFAULT_STUDENT_DESTINATION;

  let student;
  try {
    student = await requireStudentAllowUnverified();
  } catch (error) {
    if (error instanceof StudentUnauthorizedError) {
      redirect(`/login?callbackUrl=${encodeURIComponent(`${VERIFY_MOBILE_PATH}?callbackUrl=${encodeURIComponent(destination)}`)}`);
    }
    throw error;
  }

  const state = await getMobileVerificationState(student.id);
  if (state.verified) redirect(destination);
  const recovery = await getStudentRecoveryState(student.id);

  return (
    <main className="flex min-h-screen items-start justify-center bg-[var(--color-background)] px-4 py-10 sm:items-center">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <BrandLogo size="lg" href="/" />
        </div>
        <Card className="p-6">
          <div className="mb-5 flex flex-col items-center gap-3 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-primary)]/10 text-[var(--color-primary)]">
              <ShieldCheck className="h-6 w-6" aria-hidden />
            </span>
            <h1 className="text-lg font-semibold text-[var(--color-foreground)]">One-Time Mobile Verification Required</h1>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              To keep MockTestSeries secure and protect student accounts, please verify your mobile number. This is required
              only once.
            </p>
          </div>
          <VerifyMobileForm suggestedDigits={state.suggestedDigits} destination={destination} recovery={recovery} />
        </Card>
        <div className="mt-5 flex flex-col items-center gap-2 text-sm text-[var(--color-muted-foreground)]">
          <p>
            Signed in as <span className="font-medium text-[var(--color-foreground)]">{student.name ?? student.studentId}</span>
          </p>
          <div className="flex items-center gap-4">
            <form action={studentLogoutAction}>
              <button type="submit" className="text-[var(--color-primary)] hover:underline">
                Sign out
              </button>
            </form>
            <Link href="/contact" className="text-[var(--color-primary)] hover:underline">
              Need help? Contact support
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
