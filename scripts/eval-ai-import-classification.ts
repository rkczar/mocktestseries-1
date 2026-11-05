/**
 * Subject / topic / subtopic accuracy of the importer's free local classifier (lib/ai-import/taxonomy-classify.ts),
 * exactly as production runs it (buildTaxonomyIndex + classifyPaper, topic floor = Import Settings 0.7) — pure, no
 * database, no AI, nothing written.
 *
 *   CLF_EXAM_<name>=<export JSON {examId, taxonomy, evidence}>   one per exam (read-only export of the exam's syllabus
 *                                                                taxonomy and its reviewed Question Bank evidence)
 *   CLF_TRUTH_DIR=<dir with gt-ruhs2016.json, gt-cms2025.json>   labelled test papers
 *   npx tsx scripts/eval-ai-import-classification.ts [out.json]
 *
 * Leakage control (leave-one-paper-out): the test paper's own questions, every other question of the same previous-year
 * paper and any question with the same opening text are removed from the evidence; administrator-confirmed examples of
 * the taxonomy memory are not used. A question left without a subject counts as wrong (accuracy is over all questions);
 * coverage and precision are reported separately. Confidence is never reported as accuracy.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildTaxonomyIndex, classifyPaper } from "@/lib/ai-import/taxonomy-classify";
import { evidenceUsable } from "@/lib/ai-import/taxonomy-memory";
import type { ExamTaxonomySubject } from "@/lib/exam-taxonomy";

type Export = { examId: string; taxonomy: ExamTaxonomySubject[]; evidence: { id: string; topicId: string; subjectId: string; paper: string | null; reviewRequired: boolean; reviewReason: string | null; text: string }[] };
type Truth = { id: string; n: number; stem: string; options: ({ text: string } | string)[]; subjectId: string; topicId: string | null; subTopicId?: string | null; job?: string };

const TOPIC_MIN = 0.7;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);

function evaluate(name: string, ex: Export, truth: Truth[]) {
  const ids = new Set(truth.map((t) => t.id));
  const papers = new Set(ex.evidence.filter((e) => ids.has(e.id) && e.paper).map((e) => e.paper!));
  const openings = new Set(truth.map((t) => norm(t.stem)));
  const evidence = ex.evidence.filter((e) => !ids.has(e.id) && !(e.paper && papers.has(e.paper)) && !openings.has(norm(e.text)) && evidenceUsable(e));
  const index = buildTaxonomyIndex(ex.taxonomy, evidence.map((e) => ({ topicId: e.topicId, text: e.text })), null);
  const qs = truth.map((t) => ({ stem: t.stem, options: t.options.map((o, i) => ({ label: "ABCD"[i], printed: "ABCD"[i], text: typeof o === "string" ? o : o.text })) }));
  const { results } = classifyPaper(index, qs as never, { topicMin: TOPIC_MIN });
  const subjectName = new Map(ex.taxonomy.map((s) => [s.id, s.name]));
  const topicName = new Map(ex.taxonomy.flatMap((s) => s.topics.map((t) => [t.id, `${s.name} › ${t.name}`] as const)));
  let sAssigned = 0, sCorrect = 0, tAssigned = 0, tCorrect = 0, tTruth = 0, sTop3 = 0, tTop3 = 0;
  const confusions = new Map<string, number>();
  const rows = truth.map((t, i) => {
    const r = results[i];
    if (r.subjectId) sAssigned++;
    if (r.subjectId === t.subjectId) sCorrect++;
    else if (r.subjectId) confusions.set(`${subjectName.get(t.subjectId)} → ${subjectName.get(r.subjectId)}`, (confusions.get(`${subjectName.get(t.subjectId)} → ${subjectName.get(r.subjectId)}`) ?? 0) + 1);
    if (t.topicId) tTruth++;
    if (r.topicId) tAssigned++;
    if (t.topicId && r.topicId === t.topicId) tCorrect++;
    const cands = r.candidates.slice(0, 3);
    if (cands.some((c) => c.subjectId === t.subjectId)) sTop3++;
    if (t.topicId && cands.some((c) => c.topicId === t.topicId)) tTop3++;
    return { n: t.n, truth: topicName.get(t.topicId ?? "") ?? subjectName.get(t.subjectId), got: r.topicId ? topicName.get(r.topicId) : r.subjectId ? `${subjectName.get(r.subjectId)} › —` : "—", status: r.status, subjectOk: r.subjectId === t.subjectId, topicOk: !!t.topicId && r.topicId === t.topicId };
  });
  const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : null);
  return {
    name,
    questions: truth.length,
    evidenceUsed: evidence.length,
    evidenceExcluded: ex.evidence.length - evidence.length,
    subject: { accuracy: pct(sCorrect, truth.length), coverage: pct(sAssigned, truth.length), precision: pct(sCorrect, sAssigned), correct: sCorrect, assigned: sAssigned, inTop3Candidates: pct(sTop3, truth.length) },
    topic: { accuracy: pct(tCorrect, tTruth), coverage: pct(tAssigned, truth.length), precision: pct(tCorrect, tAssigned), correct: tCorrect, assigned: tAssigned, labelled: tTruth, inTop3Candidates: pct(tTop3, tTruth) },
    subTopic: { accuracy: null, note: `not applicable — the exam syllabus has ${ex.taxonomy.reduce((a, s) => a + s.topics.reduce((b, t) => b + t.subTopics.length, 0), 0)} SubTopic records (no SubTopic is ever assigned)` },
    topConfusions: [...confusions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    rows,
  };
}

function main() {
  const dir = process.env.CLF_TRUTH_DIR ?? "";
  const ruhs = JSON.parse(readFileSync(process.env.CLF_EXAM_RUHS ?? "", "utf8")) as Export;
  const cms = JSON.parse(readFileSync(process.env.CLF_EXAM_CMS ?? "", "utf8")) as Export;
  const gtR = JSON.parse(readFileSync(path.join(dir, "gt-ruhs2016.json"), "utf8")) as Truth[];
  const gtC = JSON.parse(readFileSync(path.join(dir, "gt-cms2025.json"), "utf8")) as Truth[];
  const jobs = [...new Set(gtC.map((q) => q.job))];
  const out = [evaluate("RUHS MO 2016 (labels verified)", ruhs, gtR.filter((q) => q.subjectId)), ...jobs.map((j, k) => evaluate(`CMS 2025 Paper ${k ? "II" : "I"} (admin-approved labels)`, cms, gtC.filter((q) => q.job === j && q.subjectId)))];
  for (const r of out) console.log(`${r.name}: ${r.questions} questions, evidence ${r.evidenceUsed} (${r.evidenceExcluded} excluded) | SUBJECT accuracy ${r.subject.accuracy}% (coverage ${r.subject.coverage}%, precision ${r.subject.precision}%, truth in top-3 ${r.subject.inTop3Candidates}%) | TOPIC accuracy ${r.topic.accuracy}% (coverage ${r.topic.coverage}%, precision ${r.topic.precision}%, top-3 ${r.topic.inTop3Candidates}%) | SUBTOPIC ${r.subTopic.note}\n   confusions: ${r.topConfusions.map(([k, v]) => `${k} ×${v}`).join("; ")}`);
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
}
main();
