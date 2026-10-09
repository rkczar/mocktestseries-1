import { checkText, type SafetyContext } from "@/lib/instagram/content-safety";
import { plainText } from "@/lib/instagram/layout";
import {
  HOOK_STYLES,
  LIMITS,
  normalizeHashtags,
  type ContentField,
  type HookOption,
  type HookStyle,
  type PostContent,
  type SeriesStats,
  type SourceSnapshot,
} from "@/lib/instagram/types";

/**
 * Pure prompt builder + response validator for the Instagram AI generator
 * (no provider calls here — lib/instagram/ai.ts does that through the
 * existing lib/ai-provider.ts). The model only ever writes the derived
 * content fields; the stem, options and answer key are inputs, never outputs,
 * and the response must echo the stored answer label or it is discarded.
 */

export const IG_PROMPT_VERSION = "ig-studio-v1";

export interface PromptInput {
  snapshot: SourceSnapshot;
  series: "PYQ" | "MOST_MISSED";
  stats: SeriesStats | null;
  targets: ContentField[];
  current: PostContent;
  /** Optional admin instruction (Hindi or English). */
  instruction?: string;
  /** Unreviewed reference from the student AI explanation, if one exists. */
  reference?: { concept?: string; memoryTrick?: string; pointsToRemember?: string[] } | null;
}

const FIELD_SPEC: Record<ContentField, string> = {
  hooks: `"hooks": exactly 3 objects {"style","text"} with styles "curiosity", "challenge", "memory"; each text at most ${LIMITS.hook} characters, a short headline that makes a medical exam aspirant want to try the question (e.g. "Can You Solve This RUHS MO PYQ?", "One Question Every MO Aspirant Should Revise", "Remember This Concept in 10 Seconds")`,
  explanation: `"explanation": why the correct option is right and the key reason the others are wrong, plain English, at most ${LIMITS.explanation} characters`,
  memoryTrick: `"memoryTrick": one short mnemonic or memory aid for this exact fact, at most ${LIMITS.memoryTrick} characters`,
  clinicalPearl: `"clinicalPearl": one high-yield, textbook-standard clinical/exam pearl directly related to this question, at most ${LIMITS.clinicalPearl} characters`,
  quickRevision: `"quickRevision": 2 to ${LIMITS.quickRevisionItems} one-line revision points, each at most ${LIMITS.quickRevisionItem} characters`,
  finalTrick: `"finalTrick": one closing quick-revision line for the last slide, at most ${LIMITS.finalTrick} characters`,
  caption: `"caption": the Instagram caption, 3 to 6 short lines, at most ${LIMITS.caption} characters, no hashtags inside it; end by inviting people to comment their answer and save the post`,
  hashtags: `"hashtags": 8 to ${LIMITS.hashtags} relevant hashtags (strings starting with #), no spaces inside a tag`,
};

function optionLines(s: SourceSnapshot): string {
  return s.options.map((o) => `${o.label}. ${plainText(o.text)}`).join("\n");
}

export function correctLabels(s: SourceSnapshot): string[] {
  return s.options.filter((o) => o.isCorrect).map((o) => o.label);
}

export function buildPrompt(input: PromptInput): string {
  const { snapshot: s } = input;
  const answer = correctLabels(s);
  const attribution = s.paperYear
    ? `${s.examName} — Previous Year Paper ${s.paperYear}${s.paperSharesYear && s.paperTitle ? ` (${s.paperTitle})` : ""}`
    : `${s.examName} (practice question; NOT a previous year paper question — never call it a PYQ)`;
  const lines: string[] = [
    "You write Instagram carousel content for MockTestSeries.in, a medical exam preparation website.",
    "The question, its options and the correct answer below are FIXED. Never rewrite, correct, reorder or second-guess them in your output.",
    "",
    `Attribution (use exactly as given, never add another exam, year or source): ${attribution}`,
    `Subject: ${s.subjectName}${s.topicName ? ` / ${s.topicName}` : ""}`,
    "",
    `Question: ${plainText(s.text)}`,
    optionLines(s),
    `Correct answer (from the official key): ${answer.join(", ")}`,
  ];
  if (input.series === "MOST_MISSED") {
    lines.push("", "Series: Most Missed MCQ of the period. The template adds the real wrong-answer percentage itself — do NOT write any percentage, count or statistic about students.");
  }
  if (input.reference && (input.reference.concept || input.reference.memoryTrick)) {
    lines.push(
      "",
      "Unreviewed reference notes (may contain mistakes — use only what is medically standard):",
      input.reference.concept ? `- ${input.reference.concept}` : "",
      input.reference.memoryTrick ? `- Trick: ${input.reference.memoryTrick}` : "",
      ...(input.reference.pointsToRemember ?? []).slice(0, 4).map((p) => `- ${p}`)
    );
  }
  const current = input.current;
  const hasCurrent = input.targets.some((t) => {
    const v = current[t as keyof PostContent];
    return Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim() !== "";
  });
  if (input.instruction && hasCurrent) {
    lines.push("", "Current content to revise:");
    for (const t of input.targets) {
      const v = t === "hooks" ? current.hooks.map((h) => `${h.style}: ${h.text}`).join(" | ") : current[t as keyof PostContent];
      lines.push(`- ${t}: ${Array.isArray(v) ? v.join(" | ") : String(v ?? "")}`);
    }
  }
  if (input.instruction) {
    lines.push("", `Admin instruction (may be written in Hindi or English — follow it, but always WRITE the output in English): ${input.instruction.trim().slice(0, 500)}`);
  }
  lines.push(
    "",
    "Hard rules:",
    "- English only. No Hindi/Devanagari script.",
    "- Never say a question or topic is repeated, frequently/commonly asked, asked every year, guaranteed or 'sure-shot'.",
    "- Never invent statistics, percentages about students, pass rates or exam facts.",
    `- Never mention any year other than ${s.paperYear ?? "(none — do not mention years)"} in hooks or the caption.`,
    "- No book titles, page numbers, editions or references. No links except mocktestseries.in.",
    "- Only state medically standard, textbook-level facts. If the stored answer looks doubtful or the question is ambiguous, still explain the stored answer but set confidence to \"low\" and describe the problem in concerns.",
    "",
    "Return ONLY one JSON object, no markdown, with these keys:",
    `"answerLabel": the correct option label exactly as given above (${answer.join(", ")})`,
    ...input.targets.map((t) => FIELD_SPEC[t]),
    `"confidence": "high", "medium" or "low" — how sure you are that everything you wrote is medically accurate`,
    `"concerns": array of short strings (empty if none) — anything a medical reviewer should double-check`
  );
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export interface ParsedAiResult {
  patch: Partial<PostContent>;
  flags: string[];
  rejected: { field: ContentField; reason: string }[];
  fatal?: string;
}

function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function capCheck(value: string, max: number): string | null {
  if (!value) return "empty";
  if (value.length > max) return `too long (${value.length}/${max} characters)`;
  return null;
}

export function parseAiResponse(text: string, snapshot: SourceSnapshot, targets: ContentField[], allowedDomains: string[]): ParsedAiResult {
  const out: ParsedAiResult = { patch: {}, flags: [], rejected: [] };
  const data = extractJson(text) as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return { ...out, fatal: "The AI response was not valid JSON. Nothing was changed." };

  const labels = correctLabels(snapshot);
  const echoed = typeof data.answerLabel === "string" ? data.answerLabel.trim().toUpperCase().replace(/[^A-Z,]/g, "") : "";
  if (!echoed) return { ...out, fatal: "The AI did not confirm the stored correct answer. Nothing was changed." };
  if (echoed.split(",").filter(Boolean).sort().join(",") !== [...labels].sort().join(",")) {
    return { ...out, fatal: `The AI disagreed with the stored answer key (it said ${echoed}, the key is ${labels.join(", ")}). Nothing was changed — review this question manually.` };
  }

  const ctx: SafetyContext = { paperYear: snapshot.paperYear, correctLabels: labels, optionLabels: snapshot.options.map((o) => o.label) };
  const safety = (field: ContentField, value: string) => {
    const strict = field === "hooks" || field === "caption";
    const problems = checkText(value, ctx, { strictYears: strict, allowedDomains: field === "caption" ? allowedDomains : undefined });
    return problems.length ? problems.map((p) => p.message).join(" ") : null;
  };
  const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+\n/g, "\n").trim() : "");

  for (const field of targets) {
    const raw = data[field];
    if (field === "hooks") {
      const list = Array.isArray(raw) ? raw : [];
      const hooks: HookOption[] = [];
      const reasons: string[] = [];
      for (const style of HOOK_STYLES) {
        const item = list.find((h) => (h as { style?: string })?.style === style) as { text?: unknown } | undefined;
        const t = str(item?.text).replace(/\s+/g, " ");
        const bad = capCheck(t, LIMITS.hook) ?? safety("hooks", t);
        if (bad) reasons.push(`${style}: ${bad}`);
        else hooks.push({ style: style as HookStyle, text: t });
      }
      if (hooks.length) out.patch.hooks = hooks;
      if (reasons.length) out.rejected.push({ field, reason: reasons.join("; ") });
      continue;
    }
    if (field === "quickRevision") {
      const items = (Array.isArray(raw) ? raw : []).map(str).filter(Boolean);
      const bad =
        items.length === 0
          ? "empty"
          : items.length > LIMITS.quickRevisionItems
            ? `too many points (${items.length}/${LIMITS.quickRevisionItems})`
            : items.map((i) => capCheck(i, LIMITS.quickRevisionItem) ?? safety(field, i)).find(Boolean) ?? null;
      if (bad) out.rejected.push({ field, reason: bad });
      else out.patch.quickRevision = items;
      continue;
    }
    if (field === "hashtags") {
      const tags = normalizeHashtags((Array.isArray(raw) ? raw : []).map(str));
      const bad = tags.length === 0 ? "empty" : safety(field, tags.join(" "));
      if (bad) out.rejected.push({ field, reason: bad });
      else out.patch.hashtags = tags;
      continue;
    }
    const max = { explanation: LIMITS.explanation, memoryTrick: LIMITS.memoryTrick, clinicalPearl: LIMITS.clinicalPearl, finalTrick: LIMITS.finalTrick, caption: LIMITS.caption }[field];
    const value = str(raw);
    const bad = capCheck(value, max) ?? safety(field, value);
    if (bad) out.rejected.push({ field, reason: bad });
    else (out.patch as Record<string, string>)[field] = value;
  }

  const confidence = typeof data.confidence === "string" ? data.confidence.toLowerCase() : "unknown";
  const concerns = (Array.isArray(data.concerns) ? data.concerns : []).map(str).filter(Boolean).slice(0, 5);
  if (confidence !== "high") out.flags.push(`AI confidence is ${confidence}${concerns.length ? `: ${concerns.join("; ")}` : ""}`);
  else for (const c of concerns) out.flags.push(c);
  return out;
}
