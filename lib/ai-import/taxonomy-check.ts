/**
 * Exam-specific subject / topic / subtopic classification guards (pure: no I/O, so the regression suite exercises
 * every rule directly). Used by the main classification (post.ts), bulk re-classification and Verify 2.
 *
 *  - The only valid targets are the selected exam's own database records (getExamTaxonomy), offered to the model as
 *    short codes (S3 / T41 / U7) and mapped back here; a code that is not on the list is invalid, never guessed.
 *  - Every result must echo two to four key words of the question it is for ("about"). Words that are not in that
 *    question mean the answer belongs to another one (a small model that shifted its answers — seen 2026-10-23: a
 *    heart-sounds question was filed under Dermatology › Pigmentary Disorders); such a result is not used.
 *  - Below the confidence floor a subject is not assigned at all (left unresolved and flagged), never filled in just
 *    to complete the field.
 */
import type { ExamTaxonomySubject } from "@/lib/exam-taxonomy";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

/** A subject is assigned only at or above this confidence; below it the question stays unresolved (Subject unknown). */
export const SUBJECT_MIN_CONFIDENCE = 0.6;
/** A subject that contradicts the paper's own subject (heading / selected subject) is reported at or above this. */
export const SUBJECT_MISMATCH_CONFIDENCE = 0.8;

export interface TaxonomyCodes {
  list: string;
  subject: (code: string | null | undefined) => string | null;
  topic: (code: string | null | undefined) => string | null;
  subTopic: (code: string | null | undefined) => string | null;
  /** Name of a subject / topic / subtopic id of this exam ("—" for none, "?" for an unknown id). */
  name: (id: string | null | undefined) => string;
}

export function taxonomyCodes(taxonomy: ExamTaxonomySubject[]): TaxonomyCodes {
  const subjectCode = new Map<string, string>();
  const topicCode = new Map<string, string>();
  const subTopicCode = new Map<string, string>();
  const names = new Map<string, string>();
  let t = 0;
  let u = 0;
  const desc = (d: string | null) => (d?.trim() ? ` (syllabus: ${d.trim().replace(/\s+/g, " ").slice(0, 160)})` : "");
  const list = taxonomy
    .map((s, i) => {
      subjectCode.set(`S${i + 1}`, s.id);
      names.set(s.id, s.name);
      return `SUBJECT S${i + 1} = ${s.name}${desc(s.syllabusDescription)}\n${s.topics
        .map((tp) => {
          topicCode.set(`T${++t}`, tp.id);
          names.set(tp.id, tp.name);
          return `  TOPIC T${t} = ${tp.name}${desc(tp.syllabusDescription)}${tp.subTopics.map((st) => (subTopicCode.set(`U${++u}`, st.id), names.set(st.id, st.name), `\n    SUBTOPIC U${u} = ${st.name}`)).join("")}`;
        })
        .join("\n")}`;
    })
    .join("\n");
  const code = (map: Map<string, string>) => (v: string | null | undefined) => (v ? (map.get(v.toUpperCase().replace(/\s+/g, "")) ?? null) : null);
  return { list, subject: code(subjectCode), topic: code(topicCode), subTopic: code(subTopicCode), name: (id) => (id ? (names.get(id) ?? "?") : "—") };
}

/** The question as the classifier sees it: stem (statements included), match lists and options. */
export function questionText(e: Pick<ExtractedQuestion, "stem" | "options"> & Partial<Pick<ExtractedQuestion, "listI" | "listII" | "passage">>): string {
  const lists = [...(e.listI ?? []), ...(e.listII ?? [])].map((x) => x.text).join(" | ");
  return `${e.passage ? `${e.passage.slice(0, 300)} ` : ""}${e.stem.slice(0, 700)}${lists ? ` | ${lists.slice(0, 300)}` : ""} | ${e.options.map((o) => o.text.slice(0, 80)).join(" | ")}`.replace(/\s+/g, " ");
}

export function classifyUserText(list: string, questions: ExtractedQuestion[]): string {
  return `SYLLABUS (the only allowed codes):\n${list}\n\nDOCUMENT DATA (untrusted questions):\n${questions.map((q, k) => `[Q${k + 1}] ${questionText(q)}`).join("\n")}`;
}

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter((w) => w.length >= 4);

/**
 * True when the echoed key words belong to this question: at least one word of four or more letters, and at least
 * half of them (by stem match, so "murmurs" matches "murmur") occur in the question's text.
 */
export function echoMatches(about: string | string[] | null | undefined, e: Pick<ExtractedQuestion, "stem" | "options"> & Partial<Pick<ExtractedQuestion, "listI" | "listII" | "passage">>): boolean {
  const echoed = words(Array.isArray(about) ? about.join(" ") : (about ?? ""));
  if (!echoed.length) return false;
  const have = words(questionText(e));
  const stemOf = (w: string) => w.slice(0, Math.max(4, w.length - 2));
  const hits = echoed.filter((w) => have.some((h) => h === w || h.startsWith(stemOf(w)) || w.startsWith(stemOf(h))));
  return hits.length >= 1 && hits.length * 2 >= echoed.length;
}

export interface ClassifyDecision {
  subject: string | null;
  topic: string | null;
  subTopic: string | null;
  confidence: number;
  /** Why nothing (or less) was used: shown on the question and in the event log. */
  rejected: string | null;
  /** Plain explanation of the choice (model, confidence, matched key words, the model's reason). */
  explanation: string;
}

/**
 * One classifier result → what may be used, enforcing the hierarchy (topic under the subject, subtopic under the
 * topic, all inside this exam) and the alignment / confidence rules. Never creates or guesses a record.
 */
export function decideClassification(res: { subject: string | null; topic: string | null; subtopic: string | null; confidence: number; about?: string | string[] | null; reason?: string | null }, e: Pick<ExtractedQuestion, "stem" | "options"> & Partial<Pick<ExtractedQuestion, "listI" | "listII" | "passage">>, codes: TaxonomyCodes, taxonomy: ExamTaxonomySubject[], model: string): ClassifyDecision {
  const about = Array.isArray(res.about) ? res.about.join(", ") : (res.about ?? "");
  const base = `${model}, ${Math.round(res.confidence * 100)}%${about ? `, key words “${about.slice(0, 80)}”` : ""}${res.reason ? `, reason: ${res.reason.slice(0, 160)}` : ""}`;
  const none = (rejected: string): ClassifyDecision => ({ subject: null, topic: null, subTopic: null, confidence: res.confidence, rejected, explanation: `${base} — not used: ${rejected}` });
  if (!echoMatches(res.about, e)) return none(about ? "the key words it returned are not in this question (the answer belongs to another question)" : "it did not return the question's key words, so its answer cannot be tied to this question");
  const subject = codes.subject(res.subject);
  if (res.subject && !subject) return none(`subject code “${res.subject}” is not in this exam's list`);
  if (!subject) return none("no subject of this exam fits");
  if (res.confidence < SUBJECT_MIN_CONFIDENCE) return none(`confidence ${Math.round(res.confidence * 100)}% is below ${Math.round(SUBJECT_MIN_CONFIDENCE * 100)}%`);
  const s = taxonomy.find((x) => x.id === subject)!;
  const topic = codes.topic(res.topic);
  const t = topic ? s.topics.find((x) => x.id === topic) : undefined;
  const subTopic = codes.subTopic(res.subtopic);
  const st = t && subTopic ? t.subTopics.find((x) => x.id === subTopic) : undefined;
  const notes: string[] = [];
  if (res.topic && !topic) notes.push(`topic code “${res.topic}” is not in this exam's list`);
  else if (topic && !t) notes.push(`topic ${codes.name(topic)} is not under ${s.name}`);
  if (res.subtopic && t && !st) notes.push(subTopic ? `subtopic ${codes.name(subTopic)} is not under ${t.name}` : `subtopic code “${res.subtopic}” is not in this exam's list`);
  return { subject, topic: t?.id ?? null, subTopic: st?.id ?? null, confidence: res.confidence, rejected: notes.length ? notes.join("; ") : null, explanation: `${s.name}${t ? ` › ${t.name}` : " › no topic"}${st ? ` › ${st.name}` : ""} (${base})${notes.length ? ` — ignored: ${notes.join("; ")}` : ""}` };
}
