import { notFound } from "next/navigation";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { getCommunication } from "@/lib/communications";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { BackButton } from "@/components/student/back-button";
import { CommunicationStatusSelect } from "../status-select";
import { InternalNoteForm } from "../note-form";
import { AssignToMeButton } from "../assign-button";

export const metadata = { title: "Communication — Mock Test Series.in Admin" };

const INTEREST_LABEL: Record<string, string> = {
  TEACHER: "Teacher / Educator",
  TEST_SERIES_CREATOR: "Test Series Creator / Contributor",
  IT_SUPPORT: "IT / Technical Support",
  CONTENT_CONTRIBUTOR: "Content / Question Contributor",
  OTHER: "Other",
};

function formatDate(d: Date): string {
  return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

export default async function CommunicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!session?.user?.permissions?.includes(PERMISSIONS.COMMUNICATIONS_VIEW)) {
    return <RestrictedCard title="Communication" />;
  }

  const { id } = await params;
  const communication = await getCommunication(id);
  if (!communication) notFound();

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/admin/communications" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">
            {communication.type === "CONTACT" ? "Contact Message" : "Grow With Us Request"}
          </h1>
          <p className="font-mono text-sm text-[var(--color-muted-foreground)]">{communication.referenceId}</p>
        </div>
        <CommunicationStatusSelect id={communication.id} status={communication.status} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Message</CardTitle>
              <CardDescription>
                {communication.subject ??
                  (communication.interestType ? (INTEREST_LABEL[communication.interestType] ?? communication.interestType) : null)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm text-[var(--color-foreground)]">{communication.message}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Internal Note</CardTitle>
              <CardDescription>Visible only to admins — never shown to the submitter.</CardDescription>
            </CardHeader>
            <CardContent>
              <InternalNoteForm id={communication.id} initialNote={communication.internalNote ?? ""} />
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Submitter</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1.5 text-sm">
              <p className="text-[var(--color-foreground)]">{communication.name}</p>
              <a href={`mailto:${communication.email}`} className="text-[var(--color-primary)] hover:underline">
                {communication.email}
              </a>
              {communication.phone ? <p className="text-[var(--color-muted-foreground)]">{communication.phone}</p> : null}
              {communication.student ? (
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  Signed-in student: {communication.student.name} ({communication.student.studentId})
                </p>
              ) : (
                <p className="text-xs text-[var(--color-muted-foreground)]">Public visitor (not signed in)</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between">
                <span className="text-[var(--color-muted-foreground)]">Created</span>
                <span>{formatDate(communication.createdAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--color-muted-foreground)]">Source</span>
                <span>{communication.type === "CONTACT" ? "Contact Us — Message Us" : "Grow with Us dialog"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--color-muted-foreground)]">Assigned</span>
                <span>{communication.assignedAdmin?.name ?? "Unassigned"}</span>
              </div>
              {!communication.assignedAdmin ? <AssignToMeButton id={communication.id} /> : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
