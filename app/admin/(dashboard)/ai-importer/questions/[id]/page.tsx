import Link from "next/link";
import { notFound } from "next/navigation";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import { renderText } from "@/lib/rich-content";
import { RichText } from "@/components/content/rich-text";
import { QuestionMedia } from "@/components/content/question-media";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ANSWER_STATUS_LABELS, ISSUE_DEFS, QUESTION_STATUS_LABELS } from "@/lib/ai-import/config";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { importBlocker, publishBlocker } from "@/lib/ai-import/adapter";
import { effective, textOnlyConfirmed } from "@/lib/ai-import/post";
import { statusVariant } from "@/lib/ai-import/config";
import { QuestionReview, type RescanCompareView, type VersionView } from "./question-review";
import { PaperMapping } from "@/components/admin/ai-importer/paper-mapping";
import { jobMapping } from "@/lib/ai-import/job-view";
import { compareVersions, snapshotFigures, type FigureSnapshot } from "@/lib/ai-import/versions";
import { planOf } from "@/lib/ai-import/select";
import { formatIst } from "@/lib/ist-time";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import { fingerprintOf } from "@/lib/ai-import/paper-verify";
import { verifyState } from "@/lib/ai-import/verify-core";
import { listReferences } from "@/lib/ai-import/reference";
import { fieldBoard, v2TaxonomyChecks } from "@/lib/ai-import/field-checks";
import { FieldVerification } from "@/components/admin/ai-importer/field-verification";

export const metadata = { title: "Review Question — AI Question Importer" };
export const dynamic = "force-dynamic";

/**
 * One extracted question beside its source page(s): the preview uses the
 * production text renderer (KaTeX / mhchem) and the original figure bytes,
 * laid out like the test player (stem figures above the options, option
 * figures inside their option).
 */
/** The page box of a figure (its stored JSON also carries the crop provenance and the mapping reason). */
function figureBox(v: unknown): { x: number; y: number; w: number; h: number } | null {
  const b = v as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
  return b && [b.x, b.y, b.w, b.h].every((n) => typeof n === "number") ? { x: b.x as number, y: b.y as number, w: b.w as number, h: b.h as number } : null;
}

export default async function ImportQuestionPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="Review Question" />;
  const { id } = await params;
  const q = await prisma.aiImportQuestion.findUnique({ where: { id }, include: { figures: { orderBy: { createdAt: "asc" } }, checks: { orderBy: [{ stage: "asc" }, { createdAt: "asc" }] }, job: true } });
  if (!q) notFound();
  const figurePages = [...new Set(q.figures.map((f) => f.pageNumber))];
  const [canUse, settings, taxonomy, pages, keyEntries, mapping, versions] = await Promise.all([
    hasPermission(PERMISSIONS.AI_IMPORTER_USE),
    getImporterSettings(),
    getExamTaxonomy(prisma, q.job.examId),
    prisma.aiImportPage.findMany({ where: { fileId: q.fileId, pageNumber: { in: [...new Set([...q.pages, ...figurePages])] } }, orderBy: { pageNumber: "asc" }, select: { id: true, pageNumber: true, kind: true, model: true, errorMessage: true, status: true, rawOutput: true } }),
    prisma.aiImportKeyEntry.findMany({ where: { matchedQuestionId: q.id }, select: { rawValue: true, page: true, status: true } }),
    jobMapping(q.jobId),
    prisma.aiImportQuestionVersion.findMany({ where: { questionId: q.id }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const file = await prisma.aiImportFile.findUnique({ where: { id: q.fileId }, select: { originalName: true, detected: true, status: true, storageKey: true, pageCount: true } });
  const actorIds = [...new Set([...versions.map((v) => v.actorId), q.approvedById].filter((x): x is string => !!x))];
  const actors = new Map((await prisma.adminUser.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })).map((a) => [a.id, a.name || a.email]));
  // questionId has no FK (the import record outlives the question): don't link a deleted one.
  const savedExists = q.questionId ? !!(await prisma.question.findUnique({ where: { id: q.questionId }, select: { id: true } })) : false;
  const e = effective(q);
  const kind = (file?.detected as { kind?: string } | null)?.kind;
  const hasPageImages = (kind === "pdf" || kind === "png" || kind === "jpeg") && file?.status !== "PURGED";
  const stemFigures = q.figures.filter((f) => f.owner !== "OPTION");
  const pendingRescan = versions.find((v) => v.kind === "RESCAN" && v.status === "PENDING") ?? null;
  const compare: RescanCompareView | null = pendingRescan
    ? {
        versionId: pendingRescan.id,
        model: pendingRescan.model,
        createdAt: formatIst(pendingRescan.createdAt),
        rows: compareVersions(effective(q), snapshotFigures(q.figures), pendingRescan.data as unknown as ExtractedQuestion, (pendingRescan.figures as unknown as FigureSnapshot[] | null) ?? []),
      }
    : null;
  const history: VersionView[] = versions.map((v) => ({
    id: v.id,
    kind: v.kind,
    status: v.status,
    createdAt: formatIst(v.createdAt),
    model: v.model,
    actor: v.actorId ? actors.get(v.actorId) ?? "an administrator" : null,
    note: v.note,
    changes: Array.isArray(v.changes) ? (v.changes as { field: string; before: string; after: string }[]) : [],
  }));
  const rescanBlocked =
    q.job.status === "CANCELLED"
      ? "This import was cancelled."
      : ["ANALYZING", "QUEUED", "PROCESSING", "IMPORTING"].includes(q.job.status)
        ? "The import is running — re-scan when it has finished."
        : !q.job.confirmedAt
          ? "This import was never processed."
          : kind === "docx" || kind === "xlsx" || kind === "csv"
            ? "Word and spreadsheet files are read exactly, without AI — correct the question by hand."
            : file?.status === "PURGED" || !file?.storageKey
              ? "The original file is no longer stored (retention), so its pages cannot be re-scanned. Correct the question by hand."
              : !settings.aiEnabled
                ? "Paid AI is switched off in Import Settings, so pages cannot be read again. Correct the question by hand."
                : !planOf(q.job.config)?.tasks.extract.model
                  ? "This import's model plan has no page-reading model (use Reconfigure Models on the job)."
                  : null;
  const pageIdOf = new Map(pages.map((p) => [p.pageNumber, p.id]));
  const verification = (q.data as unknown as ExtractedQuestion).verification ?? null;
  const fmt = e.contentFormat;
  // Reference comparison (Verify 1, current or not): the prepared file, the reference's reading and the official key
  // side by side for every difference or unreadable reference — evidence for the administrator, never applied.
  const refEntries = ((q.data as unknown as ExtractedQuestion).paperVerify?.v1?.references ?? []).filter((r) => r.conflicts.length || /unreadable/.test(r.note ?? ""));
  const refPapers = refEntries.length ? await listReferences(q.jobId) : [];
  const refSides = refEntries.map((r) => {
    const paper = refPapers.find((p) => p.refId === r.refId);
    const twin = paper?.questions.find((x) => `${x.section ? `${x.section} ` : ""}Q${x.number ?? "?"}` === r.matched) ?? null;
    return { ...r, twin, ocr: !!paper?.ocr };
  });
  const v1Stale = !!refEntries.length && verifyState(q.data, fingerprintOf(q)).v1 === "stale";
  // Field-by-field verification: only results that still describe this exact question count.
  const vsNow = verifyState(q.data, fingerprintOf(q));
  const taxNames = new Map([...taxonomy.map((s) => [s.id, s.name] as const), ...taxonomy.flatMap((s) => s.topics.map((t) => [t.id, t.name] as const))]);
  const v2Class = vsNow.pv?.v2?.classification;
  const v2ClassCurrent = !!v2Class && v2Class.stored.subjectId === q.subjectId && v2Class.stored.topicId === q.topicId && v2Class.stored.subTopicId === q.subTopicId;
  const board = fieldBoard(
    vsNow.v1 === "passed" || vsNow.v1 === "problems" ? vsNow.pv?.v1?.fieldChecks : null,
    vsNow.v2 === "verified" || vsNow.v2 === "disagree" || vsNow.v2 === "not_found" ? vsNow.pv?.v2?.fieldChecks : null,
    v2ClassCurrent ? v2TaxonomyChecks(v2Class, (x) => (x ? (taxNames.get(x) ?? null) : null)) : null,
  );
  const boardStale = vsNow.v1 === "stale" || vsNow.v2 === "stale" ? `The question changed after ${vsNow.v1 === "stale" && vsNow.v2 === "stale" ? "Verify 1 and Verify 2" : vsNow.v1 === "stale" ? "Verify 1" : "Verify 2"} ran — run it again; out-of-date results are not shown.` : null;
  const blockerImport = importBlocker(q, settings);
  const blockerPublish = q.questionId ? publishBlocker(q, settings) : blockerImport ?? publishBlocker(q, settings);
  // Complete figure at its stored aspect ratio (never cropped to a box), tap to zoom.
  const figureImg = (f: (typeof q.figures)[number]) =>
    f.originalKey ? (
      <div data-testid="preview-figure">
        <QuestionMedia size={f.owner === "OPTION" ? "option" : "question"} assets={[{ role: f.owner === "OPTION" ? "OPTION" : "QUESTION", optionLabel: f.optionLabel, order: 0, url: `/api/admin/ai-importer/figures/${f.id}/image`, alt: f.description ?? "Figure", caption: null, width: f.width, height: f.height, darkBacking: true }]} />
      </div>
    ) : (
      <span className="text-xs text-[var(--color-error)]">Figure missing{f.description ? ` — ${f.description}` : ""}</span>
    );
  return (
    <div className="flex flex-col gap-4">
      {mapping && <PaperMapping m={mapping} compact />}
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
          <p className="text-xs" data-testid="q-verification" data-agree={verification ? String(verification.agree) : "none"}>
            {verification ? (
              <span className={verification.agree ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"}>
                Independent read by {verification.model}: {verification.agree ? "every compared field matched" : verification.detail}
              </span>
            ) : (
              <span className="text-[var(--color-muted-foreground)]">Not independently verified (no second read for this page).</span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={statusVariant(q.status)} data-testid="q-status">
            {QUESTION_STATUS_LABELS[q.status]}
          </Badge>
          <Badge variant={statusVariant(q.answerStatus)} data-testid="q-answer-status">
            {ANSWER_STATUS_LABELS[q.answerStatus]}
          </Badge>
          {q.questionId &&
            (savedExists ? (
              <Link className="text-sm underline" href={`/admin/questions/preview/${q.questionId}`} data-testid="open-saved">
                Open saved question
              </Link>
            ) : (
              <span className="text-sm text-[var(--color-muted-foreground)]" data-testid="saved-deleted">
                Saved question deleted
              </span>
            ))}
        </div>
      </div>
      <Card data-testid="field-verification-card">
        <CardHeader>
          <CardTitle>Field verification</CardTitle>
          <CardDescription>Verify 1, Verify 2 and confirmed paper memory, field by field. Suggestions are never applied automatically.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldVerification questionId={q.id} rows={board} canUse={canUse && !q.questionId} stale={boardStale} />
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Source</CardTitle>
            <CardDescription>{hasPageImages ? "The original page(s) this question was read from." : file?.status === "PURGED" ? "The original file was removed after its retention period." : "Word and spreadsheet files have no page images; the text was read exactly."}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {hasPageImages &&
              pages.filter((p) => q.pages.includes(p.pageNumber)).map((p) => (
                <figure key={p.id} className="flex flex-col gap-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/admin/ai-importer/pages/${p.id}/image`} alt={`Page ${p.pageNumber}`} className="w-full rounded border border-[var(--color-border)] bg-white" loading="lazy" data-testid="source-page" />
                  <figcaption className="text-xs text-[var(--color-muted-foreground)]">
                    Page {p.pageNumber} · {p.kind?.toLowerCase().replace(/_/g, " ")} · {p.model ?? "—"} · {p.status === "PENDING" && (p.rawOutput as { rescan?: unknown } | null)?.rescan ? "re-scan queued" : p.status.toLowerCase()}
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
      {refSides.length > 0 && (
        <Card data-testid="reference-compare">
          <CardHeader>
            <CardTitle>Reference comparison</CardTitle>
            <CardDescription>Evidence only: the reference never changes this question, its answer, subject or images. Decide each difference yourself.{v1Stale ? " (From an earlier Verify 1 — run it again after changes.)" : ""}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {refSides.map((r) => (
              <div key={r.refId} className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3" data-testid="reference-side-by-side">
                <div>
                  <p className="text-xs font-medium text-[var(--color-muted-foreground)]">Prepared file ({file?.originalName})</p>
                  <p className="whitespace-pre-wrap" data-testid="ref-prepared">{e.stem}</p>
                  <ol className="mt-1 text-xs">
                    {e.options.map((o) => (
                      <li key={o.label}>({o.label.toLowerCase()}) {o.text}</li>
                    ))}
                  </ol>
                </div>
                <div>
                  <p className="text-xs font-medium text-[var(--color-muted-foreground)]">Reference “{r.name}”{r.matched ? ` · ${r.matched}` : ""}{r.ocr ? " · OCR" : ""}</p>
                  {r.twin && !r.twin.unreadable ? (
                    <>
                      <p className="whitespace-pre-wrap" data-testid="ref-reference">{r.twin.stem}</p>
                      <ol className="mt-1 text-xs">
                        {r.twin.options.map((t, i) => (
                          <li key={i}>({String.fromCharCode(97 + i)}) {t}</li>
                        ))}
                      </ol>
                      {r.twin.confidence !== undefined && <p className="text-xs text-[var(--color-muted-foreground)]">OCR confidence {Math.round(r.twin.confidence * 100)}%</p>}
                    </>
                  ) : (
                    <p className="text-[var(--color-warning)]" data-testid="ref-unreadable">Reference unreadable{r.twin?.confidence !== undefined ? ` (OCR confidence ${Math.round(r.twin.confidence * 100)}%)` : ""} — not used as evidence.</p>
                  )}
                </div>
                <div>
                  <p className="text-xs font-medium text-[var(--color-muted-foreground)]">Official answer key</p>
                  <p data-testid="ref-key">{q.officialAnswerRaw ?? "—"}{q.officialKeyPage ? ` (key page ${q.officialKeyPage})` : ""}</p>
                  <p className="text-xs">This question&apos;s answer: {q.finalAnswer.join(", ") || "—"} · reference: {r.twin && !r.twin.unreadable && r.twin.answer.length ? r.twin.answer.join(", ") : "—"}</p>
                  {r.conflicts.length > 0 && (
                    <ul className="mt-1 list-disc pl-4 text-xs text-[var(--color-warning)]">
                      {r.conflicts.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
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
            textOnly: (() => {
              const pointer = q.issueCodes.includes("IMAGE_MISSING") || q.issueCodes.includes("IMAGE_REFERENCE_UNCERTAIN");
              const failed = q.figures.some((f) => f.mappingStatus === "MISSING");
              return { confirmed: textOnlyConfirmed(q, e), offer: pointer && !failed && !q.figures.length, refusal: pointer && failed ? "An image of this question failed to extract — restore or crop it (it cannot be confirmed as text-only)." : null };
            })(),
            status: q.status,
            type: e.type,
            contentFormat: fmt,
            number: e.number,
            section: e.section ?? "",
            stem: e.stem,
            options: e.options.map((o) => ({ label: o.label, text: o.text })),
            explanation: e.hints?.explanation ?? "",
            pages: e.pages?.length ? e.pages : q.pages,
            pageCount: file?.pageCount ?? Math.max(1, ...q.pages),
            finalAnswer: q.finalAnswer,
            subjectId: q.subjectId,
            topicId: q.topicId,
            subTopicId: q.subTopicId,
            classification: (() => {
              const rec = (q.data as unknown as ExtractedQuestion).classification;
              const vs = verifyState(q.data, fingerprintOf(q));
              const v1 = vs.v1 === "passed" || vs.v1 === "problems" ? vs.pv?.v1?.classification : null;
              const v2 = vs.v2 !== "stale" && vs.v2 !== "none" ? vs.pv?.v2?.classification : null;
              const KIND: Record<string, string> = { ok: "", uncertain: "Uncertain — not forced", missing_taxonomy: "Missing taxonomy configuration", engine_failure: "Classifier failure (no answer)", text_incomplete: "Text incomplete (extraction problem)", admin: "Set by an administrator" };
              return { source: q.taxonomySource, confidence: q.taxonomyConfidence, kind: rec ? KIND[rec.kind] || null : null, reason: rec?.reason ?? null, v1: v1 ? `${v1.status.replace(/_/g, " ").toLowerCase()} — ${v1.findings.join(" · ")}`.slice(0, 400) : null, v2: v2 ? `${v2.status.replace(/_/g, " ").toLowerCase()} (${v2.method}${v2.comparedWithV1 === "AGREES" ? ", agrees with Verify 1" : v2.comparedWithV1 === "DIFFERS" ? ", differs from Verify 1" : ""}) — ${v2.findings.join(" · ")}`.slice(0, 400) : null };
            })(),
            allowDuplicate: q.allowDuplicate,
            duplicate: q.duplicateKind,
            approved: !!q.approvedById,
            approvedBy: q.approvedById ? actors.get(q.approvedById) ?? "an administrator" : null,
            figures: q.figures.map((f) => ({ id: f.id, owner: f.owner, optionLabel: f.optionLabel, mappingStatus: f.mappingStatus, source: f.source, confirmed: !!f.confirmedById, page: f.pageNumber, pageId: hasPageImages ? pageIdOf.get(f.pageNumber) ?? null : null, width: f.width, height: f.height, description: f.description, box: figureBox(f.box), reason: (f.box as { reason?: string } | null)?.reason ?? null, confidence: f.confidence })),
            pageImages: hasPageImages ? (e.pages?.length ? e.pages : q.pages).filter((n) => pageIdOf.has(n)).map((n) => ({ page: n, pageId: pageIdOf.get(n)! })) : [],
            rescanAllowed: { ok: !rescanBlocked, reason: rescanBlocked },
          }}
          taxonomy={taxonomy.map((s) => ({ id: s.id, name: s.name, topics: s.topics.map((t) => ({ id: t.id, name: t.name, subTopics: t.subTopics.map((st) => ({ id: st.id, name: st.name })) })) }))}
          compare={compare}
          history={history}
        />
      )}
    </div>
  );
}
