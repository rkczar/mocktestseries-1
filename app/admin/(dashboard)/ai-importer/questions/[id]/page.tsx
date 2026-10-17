import Link from "next/link";
import { notFound } from "next/navigation";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import { renderText } from "@/lib/rich-content";
import { RichText } from "@/components/content/rich-text";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ANSWER_STATUS_LABELS, ISSUE_DEFS, QUESTION_STATUS_LABELS } from "@/lib/ai-import/config";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { importBlocker, publishBlocker } from "@/lib/ai-import/adapter";
import { effective } from "@/lib/ai-import/post";
import { statusVariant } from "../../jobs/[jobId]/job-workspace";
import { QuestionReview } from "./question-review";

export const metadata = { title: "Review Question — AI Question Importer" };
export const dynamic = "force-dynamic";

/**
 * One extracted question beside its source page(s): the preview uses the
 * production text renderer (KaTeX / mhchem) and the original figure bytes,
 * laid out like the test player (stem figures above the options, option
 * figures inside their option).
 */
export default async function ImportQuestionPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="Review Question" />;
  const { id } = await params;
  const q = await prisma.aiImportQuestion.findUnique({ where: { id }, include: { figures: { orderBy: { createdAt: "asc" } }, checks: { orderBy: [{ stage: "asc" }, { createdAt: "asc" }] }, job: true } });
  if (!q) notFound();
  const [canUse, settings, taxonomy, pages, keyEntries] = await Promise.all([
    hasPermission(PERMISSIONS.AI_IMPORTER_USE),
    getImporterSettings(),
    getExamTaxonomy(prisma, q.job.examId),
    prisma.aiImportPage.findMany({ where: { fileId: q.fileId, pageNumber: { in: q.pages } }, orderBy: { pageNumber: "asc" }, select: { id: true, pageNumber: true, kind: true, model: true, errorMessage: true } }),
    prisma.aiImportKeyEntry.findMany({ where: { matchedQuestionId: q.id }, select: { rawValue: true, page: true, status: true } }),
  ]);
  const file = await prisma.aiImportFile.findUnique({ where: { id: q.fileId }, select: { originalName: true, detected: true, status: true } });
  const e = effective(q);
  const kind = (file?.detected as { kind?: string } | null)?.kind;
  const hasPageImages = (kind === "pdf" || kind === "png" || kind === "jpeg") && file?.status !== "PURGED";
  const stemFigures = q.figures.filter((f) => f.owner !== "OPTION");
  const fmt = e.contentFormat;
  const blockerImport = importBlocker(q, settings);
  const blockerPublish = q.questionId ? publishBlocker(q, settings) : blockerImport ?? publishBlocker(q, settings);
  const figureImg = (f: (typeof q.figures)[number]) =>
    f.originalKey ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={`/api/admin/ai-importer/figures/${f.id}/image`} alt={f.description ?? "Figure"} className="max-h-64 max-w-full rounded border border-[var(--color-border)] bg-white p-1" data-testid="preview-figure" />
    ) : (
      <span className="text-xs text-[var(--color-error)]">Figure missing</span>
    );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">
            {e.section ? `${e.section} · ` : ""}Question {q.sourceLabel}
          </h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            <Link className="underline" href={`/admin/ai-importer/jobs/${q.jobId}`}>
              {q.job.title}
            </Link>{" "}
            · {file?.originalName} · page {q.pages.join(", ")} · read by {e.method.replace(/_/g, " ").toLowerCase()}
            {e.model ? ` (${e.model})` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={statusVariant(q.status)} data-testid="q-status">
            {QUESTION_STATUS_LABELS[q.status]}
          </Badge>
          <Badge variant={statusVariant(q.answerStatus)} data-testid="q-answer-status">
            {ANSWER_STATUS_LABELS[q.answerStatus]}
          </Badge>
          {q.questionId && (
            <Link className="text-sm underline" href={`/admin/questions/preview/${q.questionId}`} data-testid="open-saved">
              Open saved question
            </Link>
          )}
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Source</CardTitle>
            <CardDescription>{hasPageImages ? "The original page(s) this question was read from." : file?.status === "PURGED" ? "The original file was removed after its retention period." : "Word and spreadsheet files have no page images; the text was read exactly."}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {hasPageImages &&
              pages.map((p) => (
                <figure key={p.id} className="flex flex-col gap-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/admin/ai-importer/pages/${p.id}/image`} alt={`Page ${p.pageNumber}`} className="w-full rounded border border-[var(--color-border)] bg-white" loading="lazy" data-testid="source-page" />
                  <figcaption className="text-xs text-[var(--color-muted-foreground)]">
                    Page {p.pageNumber} · {p.kind?.toLowerCase().replace(/_/g, " ")} · {p.model ?? "—"}
                    {p.errorMessage ? ` · ${p.errorMessage}` : ""}
                  </figcaption>
                </figure>
              ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Extracted question (preview)</CardTitle>
            <CardDescription>{e.type.replace(/_/g, " ").toLowerCase()} · {e.options.length} option(s) · {fmt === "RICH_V1" ? "formulas rendered" : "plain text"} · confidence {Math.round((q.confidence ?? 0) * 100)}%</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm" data-testid="q-preview">
            {(e.instructions || e.passage) && <div className="whitespace-pre-line rounded border border-[var(--color-border)] p-2 text-xs">{[e.instructions, e.passage].filter(Boolean).join("\n\n")}</div>}
            <div className="whitespace-pre-line text-base">
              <RichText content={renderText(fmt, e.stem)} />
            </div>
            {e.listI && e.listII && (
              <div className="grid grid-cols-2 gap-2 text-xs">
                <ul>
                  {e.listI.map((x) => (
                    <li key={x.key}>
                      {x.key}. <RichText content={renderText(fmt, x.text)} />
                    </li>
                  ))}
                </ul>
                <ul>
                  {e.listII.map((x) => (
                    <li key={x.key}>
                      {x.key}. <RichText content={renderText(fmt, x.text)} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {stemFigures.length > 0 && <div className="flex flex-col gap-2">{stemFigures.map((f) => <div key={f.id}>{figureImg(f)}</div>)}</div>}
            <ol className="flex flex-col gap-2">
              {e.options.map((o) => (
                <li key={o.label} className={`rounded border p-2 ${q.finalAnswer.includes(o.label) ? "border-[var(--color-success)]" : "border-[var(--color-border)]"}`} data-testid="preview-option">
                  <span className="mr-2 font-semibold">{o.label}.</span>
                  <RichText content={renderText(fmt, o.text)} />
                  {q.figures.filter((f) => f.owner === "OPTION" && f.optionLabel === o.label).map((f) => (
                    <div key={f.id} className="mt-1" data-testid={`option-figure-${o.label}`}>
                      {figureImg(f)}
                    </div>
                  ))}
                  {q.finalAnswer.includes(o.label) && <span className="ml-2 text-xs text-[var(--color-success)]">answer</span>}
                </li>
              ))}
            </ol>
            <div className="text-xs text-[var(--color-muted-foreground)]">
              Official key: {q.officialAnswerRaw ?? "—"}
              {q.officialKeyPage ? ` (key page ${q.officialKeyPage})` : ""} · printed in paper: {q.sourceAnswer.join(", ") || "—"} · AI opinion: {q.aiAnswer.length ? `${q.aiAnswer.join(", ")} (${q.aiAnswerModel})` : "—"}
              {q.answerConfirmedById ? " · answer chosen by an administrator" : ""}
              {keyEntries.length > 1 ? ` · key lists it ${keyEntries.length}×` : ""}
            </div>
            <div className="text-xs">
              <span className={blockerImport ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}>Import: {blockerImport ? `blocked — ${blockerImport}` : q.questionId ? "imported" : "ready"}</span>
              {" · "}
              <span className={blockerPublish ? "text-[var(--color-warning)]" : "text-[var(--color-success)]"}>Publish: {blockerPublish ? `not eligible — ${blockerPublish}` : "eligible"}</span>
            </div>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Checks</CardTitle>
          <CardDescription>Stage 1 source · 2 structure &amp; subject · 3 answer key · 4 final audit. Deterministic checks unless marked AI.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1 text-xs" data-testid="q-checks">
            {q.checks.map((c) => (
              <li key={c.id}>
                <Badge variant={c.passed ? "success" : c.severity === "ERROR" ? "error" : "warning"}>Stage {c.stage}</Badge> <span className="font-medium">{c.name}</span> — {c.detail}
                {c.method !== "DETERMINISTIC" ? ` [${c.method}${c.model ? ` · ${c.model}` : ""}]` : ""}
              </li>
            ))}
          </ul>
          {q.issueCodes.length > 0 && (
            <ul className="mt-3 flex flex-col gap-0.5 text-xs" data-testid="q-issues">
              {q.issueCodes.map((c) => (
                <li key={c} className={ISSUE_DEFS[c]?.blocking ? "text-[var(--color-error)]" : "text-[var(--color-warning)]"}>
                  {ISSUE_DEFS[c]?.label ?? c}: {(q.issues as Record<string, string> | null)?.[c] ?? ""}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {canUse && q.status !== "IMPORTED" && q.status !== "PUBLISHED" && (
        <QuestionReview
          q={{
            id: q.id,
            status: q.status,
            type: e.type,
            contentFormat: fmt,
            stem: e.stem,
            options: e.options.map((o) => ({ label: o.label, text: o.text })),
            finalAnswer: q.finalAnswer,
            subjectId: q.subjectId,
            topicId: q.topicId,
            allowDuplicate: q.allowDuplicate,
            duplicate: q.duplicateKind,
            figures: q.figures.map((f) => ({ id: f.id, owner: f.owner, optionLabel: f.optionLabel, mappingStatus: f.mappingStatus, source: f.source, confirmed: !!f.confirmedById, page: f.pageNumber })),
          }}
          taxonomy={taxonomy.map((s) => ({ id: s.id, name: s.name, topics: s.topics.map((t) => ({ id: t.id, name: t.name })) }))}
        />
      )}
    </div>
  );
}
