/**
 * Subject / topic consensus (pure). Sources are independent classifications of ONE question against this exam's own
 * taxonomy ids: the free local classifier (taxonomy memory + reviewed Question Bank evidence), the primary AI classifier and
 * Verify 2's independent classifier. A subject is set only when two DIFFERENT sources name it and no confident source names
 * another subject; a topic only when two sources name the same topic under that subject. Anything less stays unresolved
 * (blocked, grouped for one-screen review) — never guessed, never filled in to complete the field.
 */
export interface TaxonomySource {
  by: string;
  subjectId: string | null;
  topicId: string | null;
  confidence: number;
}

/** A dissenting source at or above this confidence blocks a two-source subject consensus. */
export const STRONG_DISSENT = 0.85;

export interface TaxonomyConsensus {
  subjectId: string | null;
  topicId: string | null;
  /** Who agreed (subject / topic), or why nothing was decided. */
  detail: string;
}

export function resolveTaxonomy(sources: TaxonomySource[]): TaxonomyConsensus {
  const usable = sources.filter((s) => s.subjectId);
  const bySubject = new Map<string, TaxonomySource[]>();
  for (const s of usable) bySubject.set(s.subjectId!, [...(bySubject.get(s.subjectId!) ?? []), s]);
  const [subjectId, agree] = [...bySubject].map(([id, list]) => [id, list] as const).filter(([, list]) => new Set(list.map((x) => x.by)).size >= 2).sort((a, b) => b[1].length - a[1].length)[0] ?? [null, []];
  if (!subjectId) return { subjectId: null, topicId: null, detail: usable.length ? `no two sources name the same subject (${usable.map((s) => `${s.by}: ${s.subjectId}`).join("; ")})` : "no source named a subject" };
  const dissent = usable.find((s) => s.subjectId !== subjectId && s.confidence >= STRONG_DISSENT);
  if (dissent) return { subjectId: null, topicId: null, detail: `${agree.map((x) => x.by).join(" + ")} agree, but ${dissent.by} names another subject at ${Math.round(dissent.confidence * 100)}%` };
  const byTopic = new Map<string, Set<string>>();
  for (const s of agree) if (s.topicId) byTopic.set(s.topicId, new Set([...(byTopic.get(s.topicId) ?? []), s.by]));
  const topic = [...byTopic].filter(([, who]) => who.size >= 2).sort((a, b) => b[1].size - a[1].size)[0];
  return { subjectId, topicId: topic?.[0] ?? null, detail: `subject: ${agree.map((x) => x.by).join(" + ")}${topic ? `; topic: ${[...topic[1]].join(" + ")}` : "; topic: no two sources agree (left open)"}` };
}
