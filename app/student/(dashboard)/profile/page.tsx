import { notFound } from "next/navigation";
import { User, Mail, Phone, Calendar, ShieldCheck, LogOut } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getStudentProfile, getLatestDeletionRequest } from "@/lib/student-data";
import { formatIst } from "@/lib/ist-time";
import { studentLogoutAction } from "@/app/student/(dashboard)/actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/student/back-button";
import { EditProfileDialog, ChangePasswordDialog, DeleteAccountDialog } from "./profile-dialogs";

export const metadata = { title: "My Profile — Mock Test Series.in" };

const PROVIDER_LABEL: Record<string, string> = {
  CREDENTIALS: "Email & Password",
  GOOGLE: "Google",
  OTP: "Mobile OTP",
};

export default async function StudentProfilePage() {
  const student = await requireStudent();
  const [profile, latestDeletion] = await Promise.all([
    getStudentProfile(student.id),
    getLatestDeletionRequest(student.id),
  ]);
  const pendingDeletion = latestDeletion?.status === "PENDING" ? latestDeletion : null;
  const rejectedDeletion = latestDeletion?.status === "REJECTED" ? latestDeletion : null;
  if (!profile) notFound();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <BackButton href="/student/dashboard" />

      <Card>
        <CardContent className="flex flex-col items-center gap-3 pt-8 text-center">
          <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-[var(--color-primary)]/15 text-[var(--color-primary)]">
            {profile.profile?.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={profile.profile.photoUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <User className="h-8 w-8" aria-hidden />
            )}
          </div>
          <div>
            <p className="text-lg font-semibold text-[var(--color-foreground)]">{profile.name}</p>
            <p className="font-mono text-xs text-[var(--color-muted-foreground)]">{profile.studentId}</p>
          </div>
          {profile.profile?.bio ? (
            <p className="max-w-md text-sm text-[var(--color-muted-foreground)]">{profile.profile.bio}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account Details</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-3 text-sm">
            <Mail className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden />
            <span className="text-[var(--color-foreground)]">{profile.email ?? "—"}</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Phone className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden />
            <span className="text-[var(--color-foreground)]">{profile.mobile ?? "—"}</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Calendar className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden />
            <span className="text-[var(--color-foreground)]">Joined {profile.createdAt.toLocaleDateString()}</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <ShieldCheck className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden />
            <span className="text-[var(--color-foreground)]">
              Signed in with {PROVIDER_LABEL[profile.authProvider] ?? profile.authProvider}
            </span>
          </div>
        </CardContent>
      </Card>

      {pendingDeletion ? (
        <Card className="border-[var(--color-warning)]/40">
          <CardContent className="pt-5 text-sm text-[var(--color-warning)]">
            Your account deletion request is pending Admin review. Requested on{" "}
            {formatIst(pendingDeletion.requestedAt)}.
          </CardContent>
        </Card>
      ) : rejectedDeletion ? (
        <Card>
          <CardContent className="pt-5 text-sm text-[var(--color-muted-foreground)]">
            Your previous account deletion request was declined
            {rejectedDeletion.reviewedAt ? ` on ${formatIst(rejectedDeletion.reviewedAt)}` : ""}. Your account remains
            active — you can submit a new request below if you still want your account deleted.
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Manage Account</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <EditProfileDialog name={profile.name} bio={profile.profile?.bio ?? ""} />
          <ChangePasswordDialog canChangePassword={profile.authProvider === "CREDENTIALS"} />
          <form action={studentLogoutAction}>
            <Button type="submit" variant="outline" size="sm">
              <LogOut className="h-4 w-4" aria-hidden /> Logout
            </Button>
          </form>
          <DeleteAccountDialog alreadyRequested={Boolean(pendingDeletion)} />
        </CardContent>
      </Card>
    </div>
  );
}
