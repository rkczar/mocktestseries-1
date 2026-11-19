import Link from "next/link";
import { notFound } from "next/navigation";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { importBlocker } from "@/lib/ai-import/adapter";
import { effective } from "@/lib/ai-import/post";
import { fingerprintOf } from "@/lib/ai-import/paper-verify";
import { verifyState } from "@/lib/ai-import/verify-core";
import { PROBLEM_CODES, classificationOnly, isStored, unresolved } from "@/lib/ai-import/review-filters";
import { suggestCorrections } from "@/lib/ai-import/suggest";
import { issueLabel } from "@/lib/ai-import/config";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import { QuickReviewTable, type QuickRow } from "./quick-review-table";

export const metadata = { title: "Quick review — AI Question Importer" };
export const dynamic = "force-dynamic";

// One review group per question (the most serious first): content and answer problems outrank taxonomy-only ones.
const GROUPS: [string, string[]][] = [
  ["Content / OCR", [...PROBLEM_CODES.text, ...PROBLEM_CODES.options, ...PROBLEM_CODES.structure]],
  ["Answer key", PROBLEM_CODES["answer-key"]],
  ["Verify 2 disagreement", PROBLEM_CODES.rescan],
  ["Formula / image / table", [...PROBLEM_CODES.formula, ...PROBLEM_CODES.images]],
  ["Model failure", PROBLEM_CODES["model-failure"]],
  ["Subject / topic", PROBLEM_CODES.taxonomy],
];

/**
 * Admin → AI Question Importer → one paper → Quick review: every unresolved question of the paper on ONE screen, with
 * the page crop, the answer-key cell, suggested corrections and the subject / topic suggestion. The only batch action is
 * the existing bulk subject / topic correction (same validation and audit); approval / import stay per question.
 */
export default async function QuickReviewPage({ params }: { params: Promise<{ jobId: string }> }) {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="Quick review" />;
  const { jobId } = await params;
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { id: true, title: true } });
  if (!job) notFound();
  const [canUse, settings, loaded, pages, keys] = await Promise.all([
    hasPermission(PERMISSIONS.AI_IMPORTER_USE),
    getImporterSettings(),
    prisma.aiImportQuestion.findMany({ where: { jobId }, orderBy: [{ fileId: "asc" }, { orderIndex: "asc" }], include: { figures: true } }),
    prisma.aiImportPage.findMany({ where: { jobId }, select: { id: true, fileId: true, pageNumber: true, renderWidth: true, renderHeight: true } }),
    prisma.aiImportKeyEntry.findMany({ where: { jobId }, select: { id: true, sourceNumber: true, rawValue: true, matchedQuestionId: true, box: true } }),
  ]);
  // Needs a decision and is not simply awaiting approval (READY rows are approved on the exceptions page as before).
  const open = loaded.filter((r) => r.status !== "READY" && unresolved({ status: r.status, approved: !!r.approvedById, stored: isStored(r), importBlocker: r.questionId ? null : importBlocker(r, settings, { ignoreApproval: true }) }));
  const ids = new Set<string>();
  for (const r of open) {
    const d = r.data as unknown as ExtractedQuestion;
    for (const x of [r, d.paperVerify?.v2?.classification?.found, d.classification]) if (x) for (const k of ["subjectId", "topicId"] as const) if (x[k]) ids.add(x[k]!);
  }
  const [subjects, topics] = await Promise.all([
    prisma.subject.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } }),
    prisma.topic.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } }),
  ]);
  const name = (id: string | null | undefined) => (id ? (subjects.find((s) => s.id === id)?.name ?? topics.find((t) => t.id === id)?.name ?? "?") : null);
  const rows: QuickRow[] = open.map((r) => {
    const e = effective(r);
    const d = r.data as unknown as ExtractedQuestion;
    const pv = d.paperVerify;
    const s = verifyState(r.data, fingerprintOf(r));
    const page = pages.find((p) => p.fileId === r.fileId && p.pageNumber === (r.pages?.[0] ?? e.pages?.[0]));
    const key = keys.find((k) => k.matchedQuestionId === r.id) ?? keys.find((k) => k.sourceNumber !== null && k.sourceNumber === r.sourceNumber);
    // Suggestion: the independent Verify 2 classification, else the stored / classifier record — never applied here.
    const found = pv?.v2?.classification?.found ?? (d.classification?.subjectId ? d.classification : null);
    const sug = found?.subjectId && (found.subjectId !== r.subjectId || (found.topicId ?? null) !== r.topicId) ? { subjectId: found.subjectId, topicId: found.topicId ?? null, label: `${name(found.subjectId)}${found.topicId ? ` › ${name(found.topicId)}` : ""}` } : null;
    const issues = (r.issues ?? {}) as Record<string, string>;
    return {
      id: r.id,
      number: r.sourceLabel || String(r.sourceNumber ?? ""),
      group: GROUPS.find(([, codes]) => r.issueCodes.some((c) => codes.includes(c)))?.[0] ?? "Other",
      taxonomyOnly: classificationOnly({ status: r.status, answerStatus: r.answerStatus, issueCodes: r.issueCodes, v1: s.v1, v2: s.v2 }),
      stem: e.stem,
      options: e.options.map((o) => `${o.label}. ${o.text}`),
      answer: r.finalAnswer.join(", ") || "—",
      answerStatus: r.answerStatus,
      stored: r.subjectId ? `${name(r.subjectId)}${r.topicId ? ` › ${name(r.topicId)}` : ""}` : null,
      suggestion: sug,
      corrections: suggestCorrections(e, pv?.v2?.second ?? null).map((c) => ({ field: c.field, to: c.to, kind: c.kind, reason: c.reason })),
      issues: r.issueCodes.map((c) => `${issueLabel(c)}${issues[c] ? `: ${issues[c].slice(0, 220)}` : ""}`),
      page: page ? { id: page.id, region: e.region ?? null, aspect: page.renderWidth && page.renderHeight ? page.renderHeight / page.renderWidth : 1.414 } : null,
      key: key ? { id: key.id, raw: key.rawValue, hasBox: !!key.box } : null,
    };
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Quick review — {job.title}</h1>
        <Link className="text-sm underline" href={`/admin/ai-importer/jobs/${job.id}`}>Back to the import</Link>
        <Link className="text-sm underline" href={`/admin/ai-importer/exceptions?job=${job.id}`}>Review exceptions</Link>
      </div>
      <p className="text-sm text-[var(--color-muted-foreground)]">
        {rows.length} unresolved question(s), grouped. Keys: j / k move, x selects, o opens the question. Suggested corrections are never applied here; approval, import and publishing stay on the question page.
      </p>
      <QuickReviewTable rows={rows} canUse={canUse} />
    </div>
  );
}
