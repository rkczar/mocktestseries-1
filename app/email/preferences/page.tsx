import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { PublicPageShell } from "@/components/homepage/public-page-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { getEmailPreference, verifyPreferencesToken } from "@/lib/email/preferences";
import { SUPPORT_EMAIL } from "@/lib/email/config";
import { PreferencesForm } from "./preferences-form";

export const metadata: Metadata = {
  title: "Email preferences — Mock Test Series",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

/**
 * Email preferences, reached from the link in every email. The signed token
 * (lib/email/preferences.ts) is the only credential: it can show and change
 * this student's promotional opt-out, nothing else — no login required.
 */
export default async function EmailPreferencesPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const studentId = verifyPreferencesToken(token);
  const student = studentId ? await prisma.student.findUnique({ where: { id: studentId }, select: { name: true, email: true, status: true } }) : null;
  const pref = student && studentId ? await getEmailPreference(studentId) : null;

  return (
    <PublicPageShell>
      <div className="mx-auto w-full max-w-xl px-4 py-10 sm:px-6">
        <Card>
          <CardHeader>
            <CardTitle>Email preferences</CardTitle>
            <CardDescription>
              {student ? `For ${student.email ?? student.name}` : "This link is invalid or has expired."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            {student && pref ? (
              <>
                <PreferencesForm token={token} promotionalOptOut={pref.promotionalOptOut} />
                <p className="text-[var(--color-muted-foreground)]">
                  Account, security and payment emails (password changes, payment receipts and invoices) are always sent,
                  because they are needed to run your account.
                </p>
              </>
            ) : (
              <p className="text-[var(--color-muted-foreground)]">
                Please use the link from a recent email, or contact {SUPPORT_EMAIL}.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </PublicPageShell>
  );
}
