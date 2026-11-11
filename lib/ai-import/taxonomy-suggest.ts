/**
 * The subject / topic suggestion shown on a question's review page (pure; no I/O). Built only from evidence the importer
 * already stored — Verify 2's and Verify 1's independent classification checks, the AI classifier's choice and the free
 * local classifier (exam syllabus + administrator-approved examples only; proposed examples and unconfirmed paper rules
 * never take part). A suggestion is never applied by itself: only "Use suggestion" (the validated taxonomy edit) changes
 * the question. Ids outside the exam's own Subject → Topic → Subtopic hierarchy are never suggested.
 */
import type { ClassificationRecord, TaxonomyVerification } from "@/lib/ai-import/types";

export interface TaxIds {
  subjectId: string | null;
  topicId: string | null;
  subTopicId: string | null;
}
export interface TaxonomyTree {
  id: string;
  name: string;
  topics: { id: string; name: string; subTopics: { id: string; name: string }[] }[];
}
export interface TaxSuggestion extends TaxIds {
  subject: string;
  topic: string | null;
  subTopic: string | null;
  confidence: number | null;
  /** Verify 2 · Verify 1 · AI classifier (model) · local classifier. */
  source: string;
  reason: string;
  evidence: string[];
}

/** Only this exam's hierarchy: a topic outside the subject (or a subtopic outside the topic) is dropped, never kept. */
function inTree(ids: TaxIds, tree: TaxonomyTree[]): (TaxIds & { subject: string; topic: string | null; subTopic: string | null }) | null {
  const s = tree.find((x) => x.id === ids.subjectId);
  if (!s) return null;
  const t = ids.topicId ? s.topics.find((x) => x.id === ids.topicId) ?? null : null;
  const st = t && ids.subTopicId ? t.subTopics.find((x) => x.id === ids.subTopicId) ?? null : null;
  return { subjectId: s.id, topicId: t?.id ?? null, subTopicId: st?.id ?? null, subject: s.name, topic: t?.name ?? null, subTopic: st?.name ?? null };
}

/** A suggestion is only worth showing when it changes the subject, or names a topic different from the current one. */
function differs(s: TaxIds, cur: TaxIds): boolean {
  return s.subjectId !== cur.subjectId || (!!s.topicId && s.topicId !== cur.topicId);
}

export function classificationSuggestion(input: {
  current: TaxIds;
  /** The administrator chose (or kept) the classification: nothing is suggested over that decision. */
  adminDecided: boolean;
  record: ClassificationRecord | null | undefined;
  /** Verify 1 / Verify 2 checks that still describe the CURRENT ids (stale checks are not passed in). */
  v1: TaxonomyVerification | null | undefined;
  v2: TaxonomyVerification | null | undefined;
  tree: TaxonomyTree[];
  name: (id: string | null | undefined) => string | null;
}): TaxSuggestion | null {
  if (input.adminDecided) return null;
  const cur = input.current;
  const curName = cur.subjectId ? `${input.name(cur.subjectId) ?? "?"}${cur.topicId ? ` › ${input.name(cur.topicId) ?? "?"}` : " (no topic)"}` : "no subject";
  const candidates: { ids: TaxIds; confidence: number | null; source: string; reason: string; evidence: string[] }[] = [];
  for (const [label, c] of [["Verify 2", input.v2], ["Verify 1", input.v1]] as const) {
    if (c?.status === "DISAGREEMENT" && c.found) candidates.push({ ids: c.found, confidence: c.confidence, source: `${label} (${c.method})`, reason: `${label}'s independent classification does not support ${curName}.`, evidence: c.findings.slice(0, 4) });
  }
  const ai = input.record?.ai;
  if (ai?.status === "USED" && ai.subjectId) candidates.push({ ids: { subjectId: ai.subjectId, topicId: ai.topicId ?? null, subTopicId: ai.subTopicId ?? null }, confidence: ai.confidence ?? null, source: `AI classifier (${ai.model ?? "model"})`, reason: `The AI classifier files this question elsewhere than ${curName}.`, evidence: [ai.detail] });
  const loc = input.record?.local;
  if (loc && (loc.status === "CLASSIFIED" || loc.status === "SUBJECT_ONLY") && loc.subjectId) {
    candidates.push({ ids: { subjectId: loc.subjectId, topicId: loc.topicId, subTopicId: loc.subTopicId }, confidence: loc.topicId ? loc.topicConfidence : loc.subjectConfidence, source: "local classifier (exam syllabus + approved examples)", reason: `The question's terms match another part of the syllabus than ${curName}.`, evidence: [loc.reason] });
  }
  for (const c of candidates) {
    const ok = inTree(c.ids, input.tree);
    if (!ok || !differs(ok, cur)) continue;
    // Other sources that agree with this suggestion strengthen it (shown as evidence, never averaged into one number).
    const agreeing = candidates.filter((o) => o !== c && o.ids.subjectId === ok.subjectId && (!ok.topicId || !o.ids.topicId || o.ids.topicId === ok.topicId)).map((o) => `${o.source} agrees`);
    return { ...ok, confidence: c.confidence, source: c.source, reason: c.reason, evidence: [...c.evidence.filter(Boolean).map((x) => x.slice(0, 300)), ...agreeing] };
  }
  return null;
}
