import Link from "next/link";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { formatIst } from "@/lib/ist-time";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FORMAT_RULES, classifierContext, examPaperRules } from "@/lib/ai-import/taxonomy-memory";
import { PAPER_RULE_KINDS } from "@/lib/ai-import/paper-memory";
import { TaxonomyMemoryEditor } from "./taxonomy-memory-editor";
import { PaperMemoryRules } from "./paper-memory-rules";

export const metadata = { title: "Taxonomy Reference — AI Question Importer" };
export const dynamic = "force-dynamic";

/**
 * Admin → AI Question Importer → Taxonomy Reference: what the importer's free classifier knows about one exam — the
 * exam's own subjects / topics / subtopics (the only valid targets), how much reviewed Question Bank evidence each
 * topic has, administrator-added synonyms and commonly confused subjects, and administrator-confirmed examples.
 * Nothing here creates or changes taxonomy records; AI predictions are never stored as knowledge.
 */
export default async function TaxonomyReferencePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await hasPermission(PERMISSIONS.AI_IMPORTER_VIEW))) return <RestrictedCard title="Taxonomy Reference" />;
  const sp = await searchParams;
  const canEdit = await hasPermission(PERMISSIONS.AI_IMPORTER_MANAGE);
  const exams = await prisma.exam.findMany({ where: { examSubjects: { some: { isActive: true } } }, orderBy: [{ order: "asc" }, { name: "asc" }], select: { id: true, name: true } });
  const exam = exams.find((e) => e.id === sp.exam) ?? null;
  const ctx = exam ? await classifierContext(exam.id) : null;
  const names = new Map(ctx ? ctx.taxonomy.flatMap((s) => [[s.id, s.name] as const, ...s.topics.map((t) => [t.id, `${s.name} › ${t.name}`] as const), ...s.topics.flatMap((t) => t.subTopics.map((u) => [u.id, `${s.name} › ${t.name} › ${u.name}`] as const))]) : []);
  const mem = ctx?.memory ?? null;
  const paperRules = exam ? await examPaperRules(exam.id) : [];
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Taxonomy Reference</h1>
        <p className="max-w-3xl text-sm text-[var(--color-muted-foreground)]">
          The exam-specific reference the importer classifies questions with — free, before any AI. Only the selected exam&apos;s own subjects, topics and subtopics can ever be assigned. Confirmed examples come only from administrator corrections in Review Exceptions (with “Remember” on), never from AI guesses. When the exam&apos;s taxonomy changes, entries whose subject / topic left it are dropped.
        </p>
      </div>
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Exams" data-testid="taxonomy-exams">
        {exams.map((e) => (
          <Link key={e.id} href={`/admin/ai-importer/taxonomy?exam=${e.id}`} className={`rounded border px-2 py-1 ${e.id === exam?.id ? "border-[var(--color-primary)] text-[var(--color-primary)]" : "border-[var(--color-border)] text-[var(--color-muted-foreground)]"}`}>
            {e.name}
          </Link>
        ))}
        {!exams.length && <span className="text-[var(--color-muted-foreground)]">No exam has subjects configured.</span>}
      </nav>
      {exam && ctx && (
        <>
          <Card data-testid="taxonomy-summary">
            <CardHeader>
              <CardTitle>{exam.name}</CardTitle>
              <CardDescription>
                {ctx.taxonomy.length} subject(s), {ctx.taxonomy.reduce((a, s) => a + s.topics.length, 0)} topic(s), {ctx.taxonomy.reduce((a, s) => a + s.topics.reduce((b, t) => b + t.subTopics.length, 0), 0)} subtopic(s) · {ctx.evidenceQuestions} reviewed Question Bank question(s) as topic evidence · {mem?.corrections.length ?? 0} confirmed example(s) · taxonomy fingerprint {ctx.fingerprint}
                {mem?.lastRefresh ? ` · last refresh ${formatIst(new Date(mem.lastRefresh.at))} dropped ${mem.lastRefresh.dropped} entr(ies)` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <details>
                <summary className="cursor-pointer text-sm">Subjects and topics (evidence per topic)</summary>
                <ul className="mt-2 flex flex-col gap-1 text-xs">
                  {ctx.taxonomy.map((s) => (
                    <li key={s.id}>
                      <b>{s.name}</b>
                      {!s.topics.length && <span className="ml-1 text-[var(--color-warning)]">— no topics configured for this exam</span>}
                      <span className="text-[var(--color-muted-foreground)]">
                        {" "}
                        {s.topics.map((t) => `${t.name} (${ctx.index.evidenceCount.get(t.id) ?? 0}${t.subTopics.length ? `, ${t.subTopics.length} subtopic(s)` : ""})`).join(" · ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </CardContent>
          </Card>
          <TaxonomyMemoryEditor
            examId={exam.id}
            canEdit={canEdit}
            subjects={ctx.taxonomy.map((s) => ({ id: s.id, name: s.name, topics: s.topics.map((t) => ({ id: t.id, name: t.name })) }))}
            synonyms={(mem?.synonyms ?? []).map((x) => ({ id: x.id, term: x.term, target: names.get(x.topicId ?? x.subjectId ?? "") ?? "?", at: x.at }))}
            confusions={[...ctx.index.confusions.filter((c) => !(mem?.confusions ?? []).some((m) => (m.a === c.a && m.b === c.b) || (m.a === c.b && m.b === c.a))).map((c) => ({ id: null, a: names.get(c.a) ?? "?", b: names.get(c.b) ?? "?", note: c.note, builtIn: true })), ...(mem?.confusions ?? []).map((c) => ({ id: c.id, a: names.get(c.a) ?? "?", b: names.get(c.b) ?? "?", note: c.note, builtIn: false }))]}
            corrections={[...(mem?.corrections ?? [])].reverse().slice(0, 200).map((c) => ({ id: c.id, text: c.text.slice(0, 200), target: names.get(c.subTopicId ?? c.topicId ?? c.subjectId) ?? "?", source: c.source, at: c.at, jobId: c.jobId }))}
            headingAliases={(mem?.headingAliases ?? []).map((x) => ({ id: x.id, raw: x.raw, target: names.get(x.subjectId) ?? "? (subject no longer part of this exam)", at: x.at, version: x.version, note: x.note }))}
            formatRules={(mem?.formatRules ?? []).map((x) => ({ id: x.id, rule: x.rule, label: FORMAT_RULES[x.rule] ?? x.rule, at: x.at, version: x.version, note: x.note }))}
            ruleOptions={Object.entries(FORMAT_RULES).map(([code, label]) => ({ code, label }))}
            history={[...(mem?.history ?? [])].reverse().slice(0, 50).map((h) => ({ version: h.version, at: h.at, action: h.action, detail: h.detail }))}
            version={mem?.version ?? 0}
          />
          <PaperMemoryRules examId={exam.id} canEdit={canEdit} rules={paperRules} kinds={PAPER_RULE_KINDS} />
        </>
      )}
    </div>
  );
}
