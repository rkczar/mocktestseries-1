import Link from "next/link";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ANSWER_STATUS_LABELS } from "@/lib/ai-import/config";
import { statusVariant } from "../jobs/[jobId]/job-workspace";

export const metadata = { title: "Answer Keys & Verification — AI Question Importer" };
export const dynamic = "force-dynamic";

/**
 * Admin → AI Question Importer → Answer Keys & Verification: per job, the
 * answer-key files, how their entries matched, and every question's answer
 * status. An AI opinion is never shown as an official answer.
 */
export default async function AnswersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="Answer Keys & Verification" />;
  const sp = await searchParams;
  const jobs = await prisma.aiImportJob.findMany({ orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, title: true } });
  const jobId = sp.job && jobs.some((j) => j.id === sp.job) ? sp.job : jobs[0]?.id;
  if (!jobId) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-[var(--color-muted-foreground)]">No imports yet.</CardContent>
      </Card>
    );
  }
  const [keyFiles, entries, statusCounts, problems] = await Promise.all([
    prisma.aiImportFile.findMany({ where: { jobId, role: "ANSWER_KEY" }, orderBy: { createdAt: "asc" } }),
    prisma.aiImportKeyEntry.groupBy({ by: ["keyFileId", "status"], where: { jobId }, _count: { _all: true } }),
    prisma.aiImportQuestion.groupBy({ by: ["answerStatus"], where: { jobId }, _count: { _all: true } }),
    prisma.aiImportQuestion.findMany({
      where: { jobId, answerStatus: { notIn: ["OFFICIAL_MATCHED", "INDEPENDENTLY_VERIFIED"] } },
      orderBy: [{ fileId: "asc" }, { orderIndex: "asc" }],
      take: 500,
      select: { id: true, sourceLabel: true, answerStatus: true, officialAnswerRaw: true, sourceAnswer: true, aiAnswer: true, aiAnswerModel: true, finalAnswer: true, answerConfirmedById: true, issues: true },
    }),
  ]);
  const unmatched = await prisma.aiImportKeyEntry.findMany({ where: { jobId, status: { in: ["UNMATCHED", "DUPLICATE"] } }, take: 200, orderBy: { sourceNumber: "asc" }, select: { id: true, sourceNumber: true, section: true, rawValue: true, status: true } });
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Answer Keys &amp; Verification</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">Official keys are matched by question number (or by position when a paper restarts numbering per section). An AI opinion is only a check — it never becomes an official answer. Upload a key later from the job page; matching re-runs automatically.</p>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        {jobs.map((j) => (
          <Link key={j.id} className={j.id === jobId ? "font-semibold underline" : "underline"} href={`/admin/ai-importer/answers?job=${j.id}`}>
            {j.title}
          </Link>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Answer status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2" data-testid="answer-status-counts">
          {statusCounts.map((s) => (
            <Badge key={s.answerStatus} variant={statusVariant(s.answerStatus)}>
              {ANSWER_STATUS_LABELS[s.answerStatus]}: {s._count._all}
            </Badge>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Answer-key files</CardTitle>
          <CardDescription>{keyFiles.length ? "Entries read from each key and how they matched." : "No answer key uploaded for this job. Questions keep their printed answer (if any) as UNVERIFIED."}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1 text-sm" data-testid="key-files">
            {keyFiles.map((f) => (
              <li key={f.id}>
                <span className="font-medium">{f.originalName}</span> — {f.status.toLowerCase()}
                {f.errorMessage ? <span className="text-[var(--color-warning)]"> · {f.errorMessage}</span> : null}
                {" · "}
                {entries.filter((e) => e.keyFileId === f.id).map((e) => `${e.status.toLowerCase()} ${e._count._all}`).join(" · ") || "no entries"}
              </li>
            ))}
          </ul>
          {unmatched.length > 0 && (
            <div className="mt-3 text-xs" data-testid="unmatched-entries">
              <div className="font-medium">Key entries without a matching question / listed twice</div>
              {unmatched.map((u) => `${u.section ? `${u.section} ` : ""}${u.sourceNumber}=${u.rawValue} (${u.status.toLowerCase()})`).join(" · ")}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Questions without a confirmed answer ({problems.length})</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-left text-sm" data-testid="answer-problems">
            <thead className="text-xs text-[var(--color-muted-foreground)]">
              <tr>
                <th className="py-1 pr-2 font-medium">Q</th>
                <th className="py-1 pr-2 font-medium">Status</th>
                <th className="py-1 pr-2 font-medium">Official key</th>
                <th className="py-1 pr-2 font-medium">Printed in paper</th>
                <th className="py-1 pr-2 font-medium">AI opinion</th>
                <th className="py-1 pr-2 font-medium">Will import with</th>
              </tr>
            </thead>
            <tbody>
              {problems.map((p) => (
                <tr key={p.id} className="border-t border-[var(--color-border)]">
                  <td className="py-1.5 pr-2">
                    <Link className="underline" href={`/admin/ai-importer/questions/${p.id}`}>
                      Q{p.sourceLabel}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-2">
                    <Badge variant={statusVariant(p.answerStatus)}>{ANSWER_STATUS_LABELS[p.answerStatus]}</Badge>
                  </td>
                  <td className="py-1.5 pr-2">{p.officialAnswerRaw ?? "—"}</td>
                  <td className="py-1.5 pr-2">{p.sourceAnswer.join(", ") || "—"}</td>
                  <td className="py-1.5 pr-2">{p.aiAnswer.length ? `${p.aiAnswer.join(", ")} (${p.aiAnswerModel})` : "—"}</td>
                  <td className="py-1.5 pr-2">{p.finalAnswer.length ? `${p.finalAnswer.join(", ")}${p.answerConfirmedById ? " (admin)" : ""}` : <span className="text-[var(--color-error)]">nothing — blocked</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
