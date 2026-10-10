import { isNearDuplicate, normalizeForDuplicateCheck, validateCandidate } from "@/lib/ai-variant-validation";
import { correctLabels } from "@/lib/instagram/ai-core";
import { checkText } from "@/lib/instagram/content-safety";
import type { ExamProfile } from "@/lib/instagram/exam-scope";
import { plainText } from "@/lib/instagram/layout";
import { TRAP_LABELS, TRAP_LIMITS, type SourceSnapshot, type TrapVariant } from "@/lib/instagram/types";

/**
 * "How the Examiner Traps You" — an AI variant question for the TRAP slide.
 *
 * Reuses the AI Variant rules (lib/ai-variant-validation.ts: four options,
 * exactly one correct, no duplicate options, near-duplicate detection), plus:
 *  - the most tempting wrong option must be named and differ from the answer;
 *  - originality: must not be a near-duplicate of the source question;
 *  - relevance: must share the source concept's key terms;
 *  - an independent blind re-solve (a second AI call answering without the key)
 *    must agree with the stated answer — a disagreement is flagged for review.
 *
 * The trap is stored on the Instagram post only — never in the Question Bank,
 * and the source question / answer key are never changed. It always starts as
 * "draft" and needs a reviewer's approval before the post can be Ready.
 */

export const TRAP_PROMPT_VERSION = "ig-trap-v1";

export function trapTexts(t: TrapVariant): string[] {
  return [t.question, ...t.options.map((o) => o.text), t.trapExplanation, t.avoidTip].filter(Boolean);
}

/** Structural problems (empty = valid). */
export function checkTrap(t: TrapVariant): string[] {
  const errs: string[] = [];
  if (!t.question) errs.push("The trap question is empty.");
  if (t.question.length > TRAP_LIMITS.question) errs.push(`The trap question is too long (${t.question.length}/${TRAP_LIMITS.question}).`);
  const labels = t.options.map((o) => o.label);
  if (t.options.length !== 4 || TRAP_LABELS.some((l, i) => labels[i] !== l)) errs.push("The trap needs exactly four options labelled A–D.");
  const texts = t.options.map((o) => normalizeForDuplicateCheck(o.text));
  if (texts.some((x) => !x)) errs.push("Every trap option needs text.");
  if (new Set(texts).size !== texts.length) errs.push("Two trap options have the same text.");
  for (const o of t.options) if (o.text.length > TRAP_LIMITS.option) errs.push(`Option ${o.label} is too long (${o.text.length}/${TRAP_LIMITS.option}).`);
  if (!labels.includes(t.correct)) errs.push("The trap's correct answer must be one of A–D.");
  if (!labels.includes(t.tempting) || t.tempting === t.correct) errs.push("Name the most tempting WRONG option (different from the correct answer).");
  if (!t.trapExplanation) errs.push("Explain the trap.");
  if (t.trapExplanation.length > TRAP_LIMITS.trapExplanation) errs.push(`The trap explanation is too long (${t.trapExplanation.length}/${TRAP_LIMITS.trapExplanation}).`);
  if (!t.avoidTip) errs.push("Add how to avoid the trap.");
  if (t.avoidTip.length > TRAP_LIMITS.avoidTip) errs.push(`"How to avoid it" is too long (${t.avoidTip.length}/${TRAP_LIMITS.avoidTip}).`);
  return errs;
}

export function buildTrapPrompt(params: { snapshot: SourceSnapshot; explanation: string; profile: ExamProfile; instruction?: string }): string {
  const s = params.snapshot;
  const answer = correctLabels(s);
  return [
    "You write one examiner-style variant MCQ for a medical exam preparation Instagram carousel (slide: \"How the examiner traps you\").",
    `Exam: ${s.examName} (${params.profile.label}). Exam style: ${params.profile.style} Difficulty: ${params.profile.difficulty}.`,
    `Subject: ${s.subjectName}${s.topicName ? ` / ${s.topicName}` : ""}`,
    "",
    "SOURCE QUESTION (verified, from the official answer key — do not contradict it):",
    plainText(s.text),
    ...s.options.map((o) => `${o.label}. ${plainText(o.text)}`),
    `Correct answer: ${answer.join(", ")}`,
    params.explanation ? `Reviewed explanation: ${params.explanation}` : "",
    "",
    "Write a NEW question that tests the SAME concept from a different angle, the way an examiner would twist it to catch students who memorised the source question superficially.",
    "Rules:",
    "- Exactly four options A, B, C, D; exactly one correct answer that is unambiguous and textbook-standard.",
    "- Include one deliberately tempting wrong option (the trap) — e.g. the source question's answer when it no longer applies, a look-alike drug/organism/structure, or a classic confusion.",
    "- Do not copy the source stem or reorder its options. No images. No patient names. English only. No years, statistics, book titles or page numbers.",
    `- Lengths: question ≤ ${TRAP_LIMITS.question} characters, each option ≤ ${TRAP_LIMITS.option}, trapExplanation ≤ ${TRAP_LIMITS.trapExplanation}, avoidTip ≤ ${TRAP_LIMITS.avoidTip}.`,
    "- If you are not certain the medical facts are correct, set confidence to \"low\" and explain in concerns.",
    params.instruction ? `Admin instruction (follow it, write in English): ${params.instruction.trim().slice(0, 400)}` : "",
    "",
    'Return ONLY one JSON object: {"text": "...", "options": [{"label":"A","text":"...","isCorrect":false}, ...4], "tempting": "<label of the most tempting wrong option>", "trapExplanation": "why students fall for it", "avoidTip": "how to avoid it", "confidence": "high|medium|low", "concerns": ["..."]}',
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export type TrapParse = { ok: true; trap: Omit<TrapVariant, "status" | "checks" | "origin">; confidence: string; concerns: string[] } | { ok: false; error: string };

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseTrap(text: string): TrapParse {
  const data = extractJson(text);
  if (!data) return { ok: false, error: "The AI response was not valid JSON." };
  const v = validateCandidate(data);
  if (!v) return { ok: false, error: "The AI question did not have exactly four distinct options with exactly one correct answer." };
  const correct = v.options.find((o) => o.isCorrect)!.label;
  const tempting = typeof data.tempting === "string" ? data.tempting.trim().toUpperCase().replace(/[^A-D]/g, "") : "";
  const str = (x: unknown) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "");
  const trap = {
    question: v.text.replace(/\s+/g, " "),
    options: v.options.map((o) => ({ label: o.label, text: o.text.replace(/\s+/g, " ") })),
    correct,
    tempting,
    trapExplanation: str(data.trapExplanation),
    avoidTip: str(data.avoidTip),
  };
  const confidence = typeof data.confidence === "string" ? data.confidence.toLowerCase() : "unknown";
  const concerns = (Array.isArray(data.concerns) ? data.concerns : []).map(str).filter(Boolean).slice(0, 4);
  return { ok: true, trap, confidence, concerns };
}

/** Independent check: answer the generated MCQ without seeing the key. */
export function buildSolvePrompt(t: Pick<TrapVariant, "question" | "options">): string {
  return [
    "Answer this medical multiple-choice question. Think carefully; there is exactly one best answer.",
    t.question,
    ...t.options.map((o) => `${o.label}. ${o.text}`),
    'Return ONLY JSON: {"answer": "<A|B|C|D>", "ambiguous": true|false, "reason": "one short sentence"}',
  ].join("\n");
}

export function parseSolve(text: string): { answer: string; ambiguous: boolean; reason: string } | null {
  const d = extractJson(text);
  if (!d || typeof d.answer !== "string") return null;
  const answer = d.answer.trim().toUpperCase().replace(/[^A-D]/g, "").slice(0, 1);
  if (!answer) return null;
  return { answer, ambiguous: d.ambiguous === true, reason: typeof d.reason === "string" ? d.reason.slice(0, 200) : "" };
}

const STOP = new Set(["which", "following", "most", "likely", "the", "of", "in", "a", "an", "is", "are", "and", "or", "to", "for", "with", "by", "on", "at", "from", "this", "that", "patient", "years", "year", "old", "man", "woman", "presents", "case", "true", "false", "not", "except", "all", "none", "above"]);
function terms(text: string): Set<string> {
  return new Set(normalizeForDuplicateCheck(text).split(" ").filter((w) => w.length > 3 && !STOP.has(w)));
}

/** Originality, relevance and safety checks — each one a reviewer-visible note. */
export function trapChecks(
  trap: Omit<TrapVariant, "status" | "checks" | "origin">,
  snapshot: SourceSnapshot,
  explanation: string,
  ai: { confidence: string; concerns: string[] },
  solve: { answer: string; ambiguous: boolean; reason: string } | null
): TrapVariant["checks"] {
  const out: TrapVariant["checks"] = [];
  const source = { text: plainText(snapshot.text), options: snapshot.options.map((o) => ({ text: plainText(o.text), isCorrect: o.isCorrect })) };
  const cand = { text: trap.question, options: trap.options.map((o) => ({ text: o.text, isCorrect: o.label === trap.correct })) };
  const dup = isNearDuplicate(cand, source);
  out.push({ code: "ORIGINAL", ok: !dup, message: dup ? "Too similar to the source question — it should test the concept from a new angle." : "Original (not a near-duplicate of the source question)." });
  const src = new Set([...terms(source.text), ...source.options.flatMap((o) => [...terms(o.text)]), ...terms(explanation), ...terms(`${snapshot.topicName ?? ""} ${snapshot.subjectName}`)]);
  const mine = [...terms(`${trap.question} ${trap.options.map((o) => o.text).join(" ")}`)];
  const shared = mine.filter((w) => src.has(w));
  out.push({ code: "RELEVANT", ok: shared.length >= 1, message: shared.length ? `Related to the source concept (shares: ${shared.slice(0, 4).join(", ")}).` : "Shares no key term with the source question — check it tests the same concept." });
  out.push({
    code: "AI_CONFIDENCE",
    ok: ai.confidence === "high",
    message: ai.confidence === "high" ? "The generating model reported high confidence." : `The generating model reported ${ai.confidence} confidence${ai.concerns.length ? `: ${ai.concerns.join("; ")}` : ""}.`,
  });
  if (solve) {
    const agrees = solve.answer === trap.correct && !solve.ambiguous;
    out.push({
      code: "BLIND_SOLVE",
      ok: agrees,
      message: agrees
        ? `An independent blind re-solve chose ${solve.answer} — matches the stated answer.`
        : solve.ambiguous
          ? `The independent re-solve found the question ambiguous${solve.reason ? ` (${solve.reason})` : ""}.`
          : `The independent re-solve chose ${solve.answer}, not ${trap.correct}${solve.reason ? ` (${solve.reason})` : ""} — verify the answer before approving.`,
    });
  } else out.push({ code: "BLIND_SOLVE", ok: false, message: "The independent re-solve could not be run — verify the answer manually." });
  const safety = checkText(trapTexts({ ...trap, status: "draft", checks: [] }).join("\n"), { paperYear: snapshot.paperYear, correctLabels: [], optionLabels: [] });
  if (safety.length) out.push({ code: "SAFETY", ok: false, message: safety.map((p) => p.message).join(" ") });
  return out;
}
