import { RestrictedCard } from "@/components/admin/restricted-card";
import { getAdminSession, hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { formatIst } from "@/lib/ist-time";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listFormatProfiles } from "@/lib/ai-import/format-profile";
import { FormatProfileEditor } from "./format-profile-editor";

export const metadata = { title: "Format Profiles — AI Question Importer" };
export const dynamic = "force-dynamic";

/**
 * Admin → AI Question Importer → Format Profiles: reusable paper layouts learned from verified questions only.
 * Verify 1 checks each new paper of the same exam and source format against its profile and reports deviations;
 * a profile never changes a question. Master Admin can edit and disable profiles (every change is a new version).
 */
export default async function FormatProfilesPage() {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="Format Profiles" />;
  const [profiles, session] = await Promise.all([listFormatProfiles(), getAdminSession()]);
  const canEdit = session?.user?.role === "MASTER_ADMIN" && (session.user.permissions ?? []).includes(PERMISSIONS.AI_IMPORTER_MANAGE);
  const exams = new Map((await prisma.exam.findMany({ where: { id: { in: profiles.map((p) => p.examId) } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Format Profiles</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">
          How a paper of one exam and source format is laid out — option labels, numbered statements, where the answer is printed, pages, figures and known reading errors. A profile is saved from an import&apos;s verified questions only (Review Exceptions → Save Format Profile). Verify 1 checks every later paper of the same exam and format against it and reports deviations as findings; it never changes a question.
        </p>
      </div>
      {!profiles.length && (
        <Card>
          <CardContent className="py-4 text-sm text-[var(--color-muted-foreground)]" data-testid="no-format-profiles">
            No format profile yet.
          </CardContent>
        </Card>
      )}
      {profiles.map((p) => (
        <Card key={p.id} data-testid="format-profile" data-enabled={p.enabled ? "true" : "false"}>
          <CardHeader>
            <CardTitle>
              {p.name} <span className="text-sm font-normal text-[var(--color-muted-foreground)]">v{p.version} · {exams.get(p.examId) ?? "exam removed"} · {p.sourceKind.toUpperCase()} · {p.enabled ? "enabled" : "disabled"}</span>
            </CardTitle>
            <CardDescription>
              Learned from {p.evidence.verifiedQuestions} verified question(s) of “{p.evidence.jobTitle}” on {formatIst(new Date(p.evidence.at))}. Last changed {formatIst(new Date(p.updatedAt))}.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <FormatProfileEditor profile={p} canEdit={canEdit} />
            {p.history.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs text-[var(--color-muted-foreground)]">History ({p.history.length} earlier version(s))</summary>
                <ul className="mt-1 flex flex-col gap-1 text-xs">
                  {[...p.history].reverse().map((h) => (
                    <li key={h.version} className="rounded border border-[var(--color-border)] p-2">
                      v{h.version} · {formatIst(new Date(h.at))} · {h.enabled ? "enabled" : "disabled"} · {h.note}
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[11px] text-[var(--color-muted-foreground)]">{JSON.stringify(h.rules, null, 1)}</pre>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
