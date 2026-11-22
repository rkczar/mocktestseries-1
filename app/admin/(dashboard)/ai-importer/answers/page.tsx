import Link from "next/link";
import { VerifyAllButton } from "./verify-all-button";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ANSWER_STATUS_LABELS } from "@/lib/ai-import/config";
import { statusVariant } from "@/lib/ai-import/config";
import { ANSWER_VERDICT_LABELS, verifyAnswers, type AnswerVerdict } from "@/lib/ai-import/verify-answers";
import { verifyAnswersReport } from "@/lib/ai-import/verify-answers-run";
import { VA_CATEGORY_LABELS, type VaCategory } from "@/lib/ai-import/verify-answers-core";

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
  const canUse = await hasPermission(PERMISSIONS.AI_IMPORTER_USE);
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
  // Verify All Answers: read-only, computed only when asked (no OCR / AI / writes).
  const check = sp.verify === "1" ? await verifyAnswers(jobId) : null;
  // Verify Answers report: read-only (key mapping now + stored independent AI answers).
  const va = sp.va === "1" ? await verifyAnswersReport(jobId) : null;
  const VA_VARIANT: Record<VaCategory, "success" | "error" | "warning" | "neutral"> = { CONFIRMED: "success", MISSING: "error", INCORRECT_MAPPING: "error", DUPLICATE: "error", WITHDRAWN: "neutral", AI_DISAGREES: "warning", MANUAL_REVIEW: "warning" };
  const VERDICT_VARIANT: Record<AnswerVerdict, "success" | "error" | "warning" | "neutral"> = { MATCH: "success", MISMATCH: "error", UNVERIFIED: "warning", NO_KEY: "neutral" };
  const unmatched = await prisma.aiImportKeyEntry.findMany({ where: { jobId, status: { in: ["UNMATCHED", "DUPLICATE"] } }, take: 200, orderBy: { sourceNumber: "asc" }, select: { id: true, sourceNumber: true, section: true, rawValue: true, status: true } });
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Answer Keys &amp; Verification</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">Official keys are matched by question number (or by position when a paper restarts numbering per section). An AI opinion is only a check — it never becomes an official answer. Upload a key later from the job page; matching re-runs automatically.</p>
      </div>
      <ul className="flex flex-col gap-1 text-sm" data-testid="answer-job-list">
        {jobs.map((j) => (
          <li key={j.id} className="flex flex-wrap items-center gap-2">
            <Link className={j.id === jobId ? "font-semibold underline" : "underline"} href={`/admin/ai-importer/answers?job=${j.id}`}>
              {j.title}
            </Link>
            {canUse && <VerifyAllButton jobId={j.id} title={j.title} />}
          </li>
        ))}
      </ul>
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
      {va && (
        <Card data-testid="va-report">
          <CardHeader>
            <CardTitle>Verify Answers</CardTitle>
            <CardDescription>A: is the official key read and mapped to the right question? B: does an independent AI answer agree? The official key stays authoritative — a disagreement only asks for manual review. Read-only.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm" data-testid="va-summary">
              {va.rows.length} checked · overall confidence {Math.round(va.confidence * 100)}% · needing manual review {va.rows.filter((r) => r.category !== "CONFIRMED" && r.category !== "WITHDRAWN").length}
              {va.state ? ` · last run ${va.state.status.toLowerCase()}${va.state.model ? ` with ${va.state.model}` : " (key check only)"}${typeof va.state.actualInr === "number" ? `, actual cost ₹${va.state.actualInr.toFixed(2)}` : ""}${va.state.stopReason ? ` — ${va.state.stopReason}` : ""}` : " · not run yet (the AI column is empty)"}
            </p>
            <div className="flex flex-wrap gap-2" data-testid="va-counts">
              {(Object.keys(VA_CATEGORY_LABELS) as VaCategory[]).map((c) => (
                <Badge key={c} variant={VA_VARIANT[c]} data-category={c} data-count={va.counts[c]}>{VA_CATEGORY_LABELS[c]}: {va.counts[c]}</Badge>
              ))}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm" data-testid="va-rows">
                <thead className="text-xs text-[var(--color-muted-foreground)]">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Q</th>
                    <th className="py-1 pr-2 font-medium">Result</th>
                    <th className="py-1 pr-2 font-medium">Official / saved</th>
                    <th className="py-1 pr-2 font-medium">Key source</th>
                    <th className="py-1 pr-2 font-medium">AI answer</th>
                    <th className="py-1 pr-2 font-medium">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {va.rows.map((r) => (
                    <tr key={r.id} className="border-t border-[var(--color-border)] align-top" data-testid="va-row" data-category={r.category}>
                      <td className="py-1.5 pr-2"><Link className="underline" href={`/admin/ai-importer/questions/${r.id}`}>{r.label}</Link></td>
                      <td className="py-1.5 pr-2"><Badge variant={VA_VARIANT[r.category]}>{VA_CATEGORY_LABELS[r.category]}</Badge></td>
                      <td className="py-1.5 pr-2">{r.official.join(", ") || "—"} / {r.saved.join(", ") || "—"}</td>
                      <td className="py-1.5 pr-2 text-xs">{r.keyRaw ?? "—"}{r.keyPage ? ` (page ${r.keyPage})` : ""}</td>
                      <td className="py-1.5 pr-2 text-xs">{r.ai ? `${r.ai.defective ? "defective" : r.ai.answer.join(", ") || "—"} (${Math.round(r.ai.confidence * 100)}%, ${r.ai.model}${r.ai.source === "cached" ? ", reused" : ""})${r.aiStale ? " — question changed since; not counted" : ""}` : "—"}</td>
                      <td className="py-1.5 pr-2 text-xs">{r.mapping}{r.ai && !r.aiStale && r.category === "AI_DISAGREES" ? ` AI: ${r.ai.reason}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {va.history.length > 0 && (
              <div className="text-xs" data-testid="va-history">
                <div className="font-medium">Earlier runs</div>
                <ul className="list-disc pl-5">
                  {va.history.map((h) => (
                    <li key={h.at}>{h.at.slice(0, 16).replace("T", " ")} UTC · {h.model ?? "key check only"} · {h.status.toLowerCase()} · {h.checked} checked, {h.counts.CONFIRMED} mapped, {h.counts.AI_DISAGREES} AI disagreements, {h.counts.MISSING + h.counts.INCORRECT_MAPPING + h.counts.DUPLICATE} key problems · ₹{h.actualInr.toFixed(2)}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      <Card data-testid="verify-all-answers">
        <CardHeader>
          <CardTitle>Verify All Answers</CardTitle>
          <CardDescription>Compares every question&apos;s saved answer with the answer key identified for this paper, using the key already read. Read-only: nothing is re-scanned, changed or approved.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Link className="w-fit rounded border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium underline" href={`/admin/ai-importer/answers?job=${jobId}&verify=1`} data-testid="verify-all-answers-run">
            {check ? "Verify all answers again" : "Verify all answers"}
          </Link>
          {check && (
            <>
              <div className="flex flex-wrap gap-2" data-testid="verify-answer-counts">
                {(Object.keys(ANSWER_VERDICT_LABELS) as AnswerVerdict[]).map((v) => (
                  <Badge key={v} variant={VERDICT_VARIANT[v]} data-verdict={v} data-count={check.counts[v]}>
                    {ANSWER_VERDICT_LABELS[v]}: {check.counts[v]}
                  </Badge>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm" data-testid="verify-answer-rows">
                  <thead className="text-xs text-[var(--color-muted-foreground)]">
                    <tr>
                      <th className="py-1 pr-2 font-medium">Q</th>
                      <th className="py-1 pr-2 font-medium">Result</th>
                      <th className="py-1 pr-2 font-medium">Saved answer</th>
                      <th className="py-1 pr-2 font-medium">Answer key</th>
                      <th className="py-1 pr-2 font-medium">Why</th>
                      <th className="py-1 pr-2 font-medium">Admin approval</th>
                    </tr>
                  </thead>
                  <tbody>
                    {check.rows.map((r) => (
                      <tr key={r.id} className="border-t border-[var(--color-border)] align-top" data-testid="verify-answer-row" data-verdict={r.verdict}>
                        <td className="py-1.5 pr-2">
                          <Link className="underline" href={`/admin/ai-importer/questions/${r.id}`}>{r.label}</Link>
                        </td>
                        <td className="py-1.5 pr-2"><Badge variant={VERDICT_VARIANT[r.verdict]}>{ANSWER_VERDICT_LABELS[r.verdict]}</Badge></td>
                        <td className="py-1.5 pr-2">{r.saved.length ? `${r.saved.join(", ")}${r.adminChosen ? " (admin)" : ""}` : "—"}</td>
                        <td className="py-1.5 pr-2">{r.keyRaw ?? "—"}{r.official.length && r.keyRaw !== r.official.join(", ") ? ` → ${r.official.join(", ")}` : ""}{r.keyPage ? ` (page ${r.keyPage})` : ""}</td>
                        <td className="py-1.5 pr-2 text-xs">{r.reason}</td>
                        <td className="py-1.5 pr-2 text-xs">{r.approved ? "Approved" : "Not approved"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
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
