import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { getAdminSession, hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { importBlocker, publishBlocker } from "@/lib/ai-import/adapter";
import { effective } from "@/lib/ai-import/post";
import { ExceptionsTable, type ExceptionRow } from "./exceptions-table";
import { PaperMapping } from "@/components/admin/ai-importer/paper-mapping";
import { jobMapping } from "@/lib/ai-import/job-view";
import { PaperVerifyBar } from "@/components/admin/ai-importer/paper-verify-bar";
import { SourceRereadPanel } from "@/components/admin/ai-importer/source-reread-panel";
import { ReferencePanel } from "@/components/admin/ai-importer/reference-panel";
import { fingerprintOf, paperSummary, scannedPagesOf } from "@/lib/ai-import/paper-verify";
import { chipCounts, dbWhere, isStored, matches, parseFilters, type FilterRow } from "@/lib/ai-import/review-filters";
import { ReviewFilters } from "@/components/admin/ai-importer/review-filters";
import { mergedAnswerIn, statementsOf } from "@/lib/ai-import/local-parse";
import { fieldBoard } from "@/lib/ai-import/field-checks";
import { listReferences } from "@/lib/ai-import/reference";
import { V1_DISPLAY, v2Display, v2Independence, verifyState } from "@/lib/ai-import/verify-core";
import { CHECK_NAMES, CHECK_STATUS_LABELS } from "@/lib/ai-import/checks";
import { DRAFT_IMPORT_STATUSES, approvedReadyCounts } from "@/lib/ai-import/summary";
import { referenceStatusText } from "@/lib/ai-import/reference-status";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import { missingQuestionRows } from "@/lib/ai-import/review";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

export const metadata = { title: "AI Import Review Exceptions — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

const ROW_CAP = 1000;

/**
 * Admin → AI Question Importer → Review Exceptions: only the questions that
 * need a decision (nobody has to review every question). `status=all` lists
 * a whole job, e.g. to publish a selection.
 */
export default async function ExceptionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="Review Exceptions" />;
  const sp = await searchParams;
  const [canUse, canPublish, settings, session] = await Promise.all([hasPermission(PERMISSIONS.AI_IMPORTER_USE), hasPermission(PERMISSIONS.QUESTIONS_MANAGE), getImporterSettings(), getAdminSession()]);
  const canManage = session?.user?.role === "MASTER_ADMIN";
  const canManageImporter = await hasPermission(PERMISSIONS.AI_IMPORTER_MANAGE);
  const jobs = await prisma.aiImportJob.findMany({ orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, title: true, status: true, examId: true } });
  // The paper is looked up by id (not only among the latest 100); an unknown id is an error, never "all papers".
  const job = sp.job ? (jobs.find((j) => j.id === sp.job) ?? (await prisma.aiImportJob.findUnique({ where: { id: sp.job }, select: { id: true, title: true, status: true, examId: true } }))) : null;
  if (sp.job && !job) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-2 py-4 text-sm" role="alert" data-testid="job-not-found">
          <p className="text-[var(--color-error)]">No import paper with id “{sp.job}” was found — it may have been deleted.</p>
          <Link className="underline" href="/admin/ai-importer/exceptions">Choose a paper</Link>
        </CardContent>
      </Card>
    );
  }
  const jobId = job?.id;
  const f = parseFilters(sp);
  const { status, verify, problem, issue } = f;
  const summary = jobId ? await paperSummary(jobId) : null;
  const draft = job ? { count: (await approvedReadyCounts([job.id])).get(job.id) ?? 0, open: DRAFT_IMPORT_STATUSES.includes(job.status) } : null;
  // One paper: load all of its rows and filter in memory (counts and list from the same rows). All papers: coarse
  // database filter, capped, then the same in-memory match.
  const baseWhere: Prisma.AiImportQuestionWhereInput = jobId ? { jobId } : (dbWhere(f) as Prisma.AiImportQuestionWhereInput);
  const [loaded, totalLoaded] = await Promise.all([
    prisma.aiImportQuestion.findMany({ where: baseWhere, orderBy: [{ jobId: "asc" }, { fileId: "asc" }, { orderIndex: "asc" }], ...(jobId ? {} : { take: ROW_CAP }), include: { figures: true } }),
    jobId ? Promise.resolve(0) : prisma.aiImportQuestion.count({ where: baseWhere }),
  ]);
  // Eligibility to publish is the server's own rule (paper-verify.ts eligibleForPublish), for every job shown.
  const eligible = new Set(summary?.eligible ?? []);
  if (verify === "eligible") for (const j of new Set(loaded.map((r) => r.jobId))) if (j !== jobId) for (const id of (await paperSummary(j))?.eligible ?? []) eligible.add(id);
  // Verification filters are judged against each question's current content (an out-of-date result does not count).
  const filterRow = (r: (typeof loaded)[number]): FilterRow => {
    const s = verifyState(r.data, fingerprintOf(r));
    const checks = [...(s.v1 === "passed" || s.v1 === "problems" ? (s.pv?.v1?.fieldChecks ?? []) : []), ...(s.v2 === "verified" || s.v2 === "disagree" || s.v2 === "not_found" ? (s.pv?.v2?.fieldChecks ?? []) : [])];
    return {
      status: r.status,
      answerStatus: r.answerStatus,
      issueCodes: r.issueCodes,
      approved: !!r.approvedById,
      stored: isStored(r),
      importBlocker: r.questionId ? null : importBlocker(r, settings, { ignoreApproval: true }),
      v1: s.v1,
      v2: s.v2,
      eligible: eligible.has(r.id),
      fieldProblem: checks.some((c) => c.status === "PROBLEM"),
      memoryProblem: checks.some((c) => c.status === "PROBLEM" && c.by === "MEMORY"),
    };
  };
  const judged = loaded.map((r) => ({ r, fr: filterRow(r) }));
  // Counts: only for one paper, over ALL of its rows, each chip on its own.
  const counts = jobId ? chipCounts(judged.map((x) => x.fr)) : null;
  const rows = judged.filter((x) => matches(x.fr, f)).map((x) => x.r);
  const capped = !jobId && totalLoaded > ROW_CAP;
  const taxonomy = job ? (await getExamTaxonomy(prisma, job.examId)).map((s) => ({ id: s.id, name: s.name, topics: s.topics.map((t) => ({ id: t.id, name: t.name, subTopics: t.subTopics.map((u) => ({ id: u.id, name: u.name })) })) })) : [];
  const references = jobId ? (await listReferences(jobId)).map((r) => ({ refId: r.refId, name: r.name, questions: r.questions.length, key: r.key.length, note: r.note, ocrAvailable: !r.ocr && scannedPagesOf(r) > 0, status: (() => { const s = summary?.references.find((x) => x.refId === r.refId)?.status; return s ? referenceStatusText(s) : null; })() })) : [];
  // Names of every subject / topic / subtopic shown: the stored ones and what Verify 1 / Verify 2 found.
  const taxIds = (pick: (x: { subjectId: string | null; topicId: string | null; subTopicId: string | null }) => string | null) => {
    const out = new Set<string>();
    for (const r of rows) {
      const pv = (r.data as unknown as ExtractedQuestion).paperVerify;
      const alts = ((r.data as unknown as ExtractedQuestion).classification?.alternatives ?? []).map((a) => ({ ...a, subTopicId: null }));
      for (const x of [r, pv?.v1?.classification?.found, pv?.v2?.classification?.found, ...alts]) if (x && pick(x)) out.add(pick(x)!);
    }
    return [...out];
  };
  const subjects = await prisma.subject.findMany({ where: { id: { in: taxIds((x) => x.subjectId) } }, select: { id: true, name: true } });
  const topics = await prisma.topic.findMany({ where: { id: { in: taxIds((x) => x.topicId) } }, select: { id: true, name: true } });
  const subTopics = await prisma.subTopic.findMany({ where: { id: { in: taxIds((x) => x.subTopicId) } }, select: { id: true, name: true } });
  const nameOf = (x: { subjectId: string | null; topicId: string | null; subTopicId: string | null } | null | undefined) =>
    x?.subjectId ? `${subjects.find((s) => s.id === x.subjectId)?.name ?? "?"}${x.topicId ? ` › ${topics.find((t) => t.id === x.topicId)?.name ?? "?"}` : ""}${x.subTopicId ? ` › ${subTopics.find((t) => t.id === x.subTopicId)?.name ?? "?"}` : ""}` : null;
  const KIND_LABEL: Record<string, string> = { ok: "", uncertain: "Uncertain — not forced", missing_taxonomy: "Missing taxonomy configuration", engine_failure: "Classifier failure (no answer)", text_incomplete: "Text incomplete (extraction problem)", admin: "Set by an administrator" };
  // questionId has no FK (the import record outlives the question): only link saved questions that still exist.
  const saved = new Set(
    (await prisma.question.findMany({ where: { id: { in: rows.map((r) => r.questionId).filter((x): x is string => !!x) } }, select: { id: true } })).map((x) => x.id),
  );
  const pendingRescan = new Set((await prisma.aiImportQuestionVersion.findMany({ where: { questionId: { in: rows.map((r) => r.id) }, kind: "RESCAN", status: "PENDING" }, select: { questionId: true } })).map((v) => v.questionId));
  const jobV2 = job ? ((await prisma.aiImportJob.findUnique({ where: { id: job.id }, select: { config: true } }))?.config as { verify2?: { status: string } } | null)?.verify2 ?? null : null;
  const checks = await prisma.aiImportCheck.findMany({ where: { questionId: { in: rows.map((r) => r.id) }, name: "Classification evidence" }, select: { questionId: true, detail: true } });
  const taxEvidence = new Map(checks.map((c) => [c.questionId, c.detail]));
  const view: ExceptionRow[] = rows.map((r) => {
    const e = effective(r);
    const vs = verifyState(r.data, fingerprintOf(r));
    const contaminated = mergedAnswerIn(e);
    const rec = (r.data as unknown as ExtractedQuestion).classification ?? null;
    const v1c = vs.v1 === "passed" || vs.v1 === "problems" ? (vs.pv?.v1?.classification ?? null) : null;
    const v2c = vs.v2 !== "stale" && vs.v2 !== "none" ? (vs.pv?.v2?.classification ?? null) : null;
    const agreement = !v1c && !v2c ? "Not checked yet" : v1c?.status === "DISAGREEMENT" || v2c?.status === "DISAGREEMENT" ? "Disagreement" : v2c?.status === "VERIFICATION_FAILED" ? "Verify 2 check failed — not agreement" : v1c?.status === "AGREED" && v2c?.status === "AGREED" ? "Both checks agree" : v1c?.status === "AGREED" && !v2c ? "Verify 1 agrees; Verify 2 not run" : "Not confirmed";
    const mismatch = v1c?.status === "DISAGREEMENT" || v2c?.status === "DISAGREEMENT" || r.issueCodes.includes("SUBJECT_MISMATCH");
    return {
      id: r.id,
      jobId: r.jobId,
      fileId: r.fileId,
      number: e.number ?? null,
      label: r.sourceLabel,
      section: e.section,
      stem: e.stem.slice(0, 220),
      status: r.status,
      answerStatus: r.answerStatus,
      issues: r.issueCodes,
      issueText: (r.issues as Record<string, string> | null) ?? {},
      subject: subjects.find((s) => s.id === r.subjectId)?.name ?? null,
      topic: topics.find((t) => t.id === r.topicId)?.name ?? null,
      finalAnswer: r.finalAnswer,
      figures: r.figures.length,
      importBlocker: importBlocker(r, settings),
      publishBlocker: r.questionId ? publishBlocker(r, settings) : importBlocker(r, settings) ?? publishBlocker(r, settings),
      questionId: r.questionId,
      savedDeleted: !!r.questionId && !saved.has(r.questionId),
      approved: !!r.approvedById,
      rescanPending: pendingRescan.has(r.id),
      v1: vs.v1,
      v2: vs.v2,
      v2Model: vs.pv?.v2?.model ?? null,
      v1Label: V1_DISPLAY[vs.v1],
      // A Verify 2 that re-read the same Word / sheet text is never shown as an independent pass.
      v2Label: vs.v2 === "verified" && vs.pv?.v2 && v2Independence(vs.pv.v2) === "SAME_TEXT" ? "Same text only (not independent)" : v2Display(vs.v2, jobV2),
      checks: (() => {
        const c = (r.data as unknown as ExtractedQuestion).checks;
        return c ? (["content", "answer", "taxonomy", "independent"] as const).map((k) => ({ key: k, name: CHECK_NAMES[k], status: c[k].status, label: CHECK_STATUS_LABELS[c[k].status], required: c[k].required, detail: c[k].detail.slice(0, 300) })) : null;
      })(),
      formatting: (() => {
        const f = (r.data as unknown as ExtractedQuestion).formatting;
        return f ? { rules: f.rules.map((x) => (x === "FIELD_LABEL" ? "“Question:” label removed" : "statements put on their own lines")), original: f.original.slice(0, 1500) } : null;
      })(),
      v1Findings: vs.v1 === "problems" || vs.v1 === "passed" ? (vs.pv?.v1?.problems ?? []).map((p) => `${p.code}: ${p.detail}`).slice(0, 6) : [],
      v1Fixes: vs.v1 !== "stale" ? (vs.pv?.v1?.fixes ?? []).map((f) => `${f.field} (${f.evidence})`).slice(0, 4) : [],
      v2Detail: vs.pv?.v2 && vs.v2 !== "stale" ? `${vs.pv.v2.part ? `${vs.pv.v2.part}: ` : ""}${vs.pv.v2.error ? `${vs.pv.v2.error.message}` : vs.pv.v2.detail}`.slice(0, 400) : vs.v2 === "stale" ? "the question changed after Verify 2 ran" : null,
      v2Fields: vs.v2 === "disagree" || vs.v2 === "not_found" ? (vs.pv?.v2?.fields ?? []) : [],
      // Field-by-field problems of the CURRENT Verify 1 / Verify 2 results (and confirmed paper memory).
      fieldProblems: fieldBoard(vs.v1 === "passed" || vs.v1 === "problems" ? vs.pv?.v1?.fieldChecks : null, vs.v2 === "verified" || vs.v2 === "disagree" || vs.v2 === "not_found" ? vs.pv?.v2?.fieldChecks : null)
        .filter((f) => f.status === "PROBLEM")
        .map((f) => ({ field: f.field, notes: f.notes.filter((n) => n.status === "PROBLEM").map((n) => ({ by: n.by, problem: (n.problem ?? "").slice(0, 300), suggestion: n.suggestion ? n.suggestion.slice(0, 160) : null })).slice(0, 3) })),
      references: (vs.v1 !== "stale" ? (vs.pv?.v1?.references ?? []) : []).map((x) => ({ name: x.name, compared: x.compared, matched: x.matched, similarity: x.similarity, conflicts: x.conflicts.slice(0, 3), note: x.note ?? null })),
      fullStem: [e.instructions, e.passage, e.stem].filter(Boolean).join("\n").slice(0, 1500),
      options: e.options.map((o) => ({ label: o.label, text: o.text.slice(0, 200), contaminated: contaminated?.where === `option ${o.label}` })),
      statements: statementsOf(e.stem).length,
      stemContaminated: contaminated?.where === "question text",
      answerLine: contaminated?.raw ?? e.printedAnswerRaw ?? null,
      taxonomySource: r.taxonomySource,
      taxonomyEvidence: taxEvidence.get(r.id) ?? null,
      tax: {
        subTopic: subTopics.find((t) => t.id === r.subTopicId)?.name ?? null,
        confidence: r.taxonomyConfidence,
        kind: mismatch ? "Mismatch — the checks point elsewhere" : rec ? (KIND_LABEL[rec.kind] ?? rec.kind) || null : null,
        reason: rec?.reason ?? null,
        localSuggestion: rec?.local && rec.local.subjectId && (rec.local.subjectId !== r.subjectId || rec.local.topicId !== r.topicId) ? `${nameOf(rec.local)} (subject ${Math.round(rec.local.subjectConfidence * 100)}%${rec.local.topicId ? `, topic ${Math.round(rec.local.topicConfidence * 100)}%` : ""})` : null,
        ai: rec?.ai ? `${rec.ai.model ?? "AI"}: ${rec.ai.status.replace(/_/g, " ").toLowerCase()} — ${rec.ai.detail}`.slice(0, 300) : null,
        v1: v1c ? { status: v1c.status, found: nameOf(v1c.found), findings: v1c.findings.slice(0, 3) } : null,
        v2: v2c ? { status: v2c.status, found: nameOf(v2c.found), findings: v2c.findings.slice(0, 3), model: v2c.method, vsV1: v2c.comparedWithV1 } : null,
        agreement,
        alternatives: (rec?.alternatives ?? []).map((a) => `${nameOf({ subjectId: a.subjectId, topicId: a.topicId, subTopicId: null }) ?? "?"} — ${a.source}: ${a.reason}`.slice(0, 240)),
      },
      eligible: eligible.has(r.id),
    };
  });
  const mapping = jobId ? await jobMapping(jobId) : null;
  // Missing-question rows (placeholders with Re-scan): one job, unfiltered exception / full lists only.
  const missing = jobId && !issue && !problem && !verify && (status === "exceptions" || status === null) ? await missingQuestionRows(jobId) : null;
  const link = (patch: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ job: jobId, status: sp.status === "all" || (status && status !== "exceptions") ? sp.status : undefined, issue, verify, problem: issue ? undefined : problem, ...patch })) if (v) u.set(k, v);
    return `/admin/ai-importer/exceptions?${u}`;
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Review Exceptions</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">
          Questions that need a decision are listed first. Nothing enters the Question Bank until it is approved: approve clean questions in bulk, fix or decide the rest, then add the approved ones from the import page.
        </p>
      </div>
      {jobId && summary && job && (
        <PaperVerifyBar jobId={jobId} jobStatus={job.status} summary={summary} canUse={canUse} canPublish={canPublish && canUse} canManage={canManage} hrefs={{ verified: link({ status: "all", verify: "verified" }), v1Problems: link({ status: "all", verify: "v1-problems" }), v2Disagree: link({ status: "all", verify: "v2-disagree" }), v2NoResult: link({ status: "all", verify: "v2-noresult" }), structure: link({ status: "all", problem: "structure", issue: undefined }), taxonomy: link({ status: "all", problem: "taxonomy", issue: undefined }), answers: link({ status: "all", problem: "answer", issue: undefined }) }} />
      )}
      {jobId && job && (
        <SourceRereadPanel jobId={jobId} canUse={canUse} canLearn={canManageImporter} finished={["NEEDS_REVIEW", "COMPLETED", "COMPLETED_WITH_ISSUES"].includes(job.status)} />
      )}
      {jobId && (
        <Card>
          <CardContent className="py-3">
            <ReferencePanel jobId={jobId} refs={references} canUse={canUse} />
          </CardContent>
        </Card>
      )}
      {mapping && <PaperMapping m={mapping} compact />}
      <Card>
        <CardContent className="flex flex-col gap-3 py-3 text-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center" data-testid="job-scope">
            <span className="font-medium">Paper: {job ? job.title : "All papers"}</span>
            {!job && <span className="text-xs text-[var(--color-warning)]" data-testid="choose-paper">Choose a paper to see counts — without one, the list mixes every paper.</span>}
            {job && <span className="text-xs text-[var(--color-muted-foreground)]">Counts are for this paper only.</span>}
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="text-[var(--color-muted-foreground)]">Papers:</span>
            <Link className={!jobId ? "font-semibold underline" : "underline"} href={link({ job: undefined })}>
              All
            </Link>
            {jobs.map((j) => (
              <Link key={j.id} className={jobId === j.id ? "font-semibold underline" : "underline"} href={link({ job: j.id })}>
                {j.title}
              </Link>
            ))}
          </div>
          <ReviewFilters f={f} counts={counts} link={link} issueCodes={[...new Set(rows.flatMap((r) => r.issueCodes))]} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{rows.length} question(s){job ? " in this paper" : " across all papers"}</CardTitle>
          {capped && (
            <p className="text-sm text-[var(--color-warning)]" role="status" data-testid="row-cap">
              Only the first {ROW_CAP} of {totalLoaded} matching records were loaded — choose a paper to see all of them.
            </p>
          )}
          <CardDescription>Open a question to see its source page beside the extracted question, fix it, set the answer or topic, or confirm its figures.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <ExceptionsTable rows={view} canUse={canUse} canPublish={canPublish && canUse} jobId={jobId ?? null} taxonomy={taxonomy} draft={draft} missing={missing} />
        </CardContent>
      </Card>
    </div>
  );
}
