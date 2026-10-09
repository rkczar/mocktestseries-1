import { answerKeyIssue } from "@/lib/question-insights-format";
import { checkText, type SafetyContext } from "@/lib/instagram/content-safety";
import { planSlides, plainText } from "@/lib/instagram/layout";
import { MODULE_LABELS, type PostContent, type PostDesign, type SeriesStats, type SourceSnapshot } from "@/lib/instagram/types";

/**
 * The Ready gate. Pure: the server re-runs it inside markReady (never trusts
 * the client's view) and the modal shows the same list live.
 *
 *  - error   → blocks Ready. Fix the post, or fix the question in the
 *              Question Bank and refresh the snapshot.
 *  - warning → the admin must tick "I checked this" for each one.
 *
 * Nothing here corrects text: a damaged PYQ stem is reported, never repaired.
 */

export type IssueSeverity = "error" | "warning";

export interface QualityIssue {
  /** Stable id — acknowledgements are stored against it. */
  code: string;
  severity: IssueSeverity;
  message: string;
  slide?: number;
}

export interface QualityInput {
  snapshot: SourceSnapshot;
  content: PostContent;
  design: PostDesign;
  series: "PYQ" | "MOST_MISSED";
  seriesStats: SeriesStats | null;
  questionNumber: number | null;
  questionNumberVerified: boolean;
  /** Hash of the question as it is in the Question Bank NOW (null = question no longer exists). */
  currentHash: string | null;
  snapshotHash: string;
  follow: { instagramHandle: string; showInstagram: boolean; telegramUrl: string; showTelegram: boolean };
  allowedDomains: string[];
  /** Characters no slide font can draw (lib/instagram/glyphs.ts, server-side). Omitted → not checked. */
  unsupportedChars?: (text: string) => string[];
  /** Follow-slide texts from Settings, checked for drawable characters too. */
  settingsTexts?: string[];
}

export const REVIEW_CHECKLIST = [
  { key: "textMatchesPaper", label: "Question text and every option match the original paper word for word" },
  { key: "answerVerified", label: "The correct answer is verified against the official answer key" },
  { key: "attributionVerified", label: "Exam name, year and paper shown on the slides are correct" },
  { key: "medicalReviewed", label: "Explanation, memory trick, pearl and revision points are medically accurate" },
] as const;
export type ChecklistKey = (typeof REVIEW_CHECKLIST)[number]["key"];

/** Common correct-lowercase stem openings (units, gene/drug names) that are not OCR damage. */
const LOWERCASE_OK = /^(pH|pO2|pCO2|mRNA|tRNA|rRNA|miRNA|dNTP|cAMP|cGMP|iNOS|eNOS|mTOR|p53|e\.g\.|i\.e\.|vs\.?)\b/;

export function stemLooksTruncated(text: string): boolean {
  const t = plainText(text);
  if (!t) return false;
  if (LOWERCASE_OK.test(t)) return false;
  // ASCII lowercase start = a lost capital (OCR). Greek (β-lactam, α-blocker) and other letters are legitimate openings.
  return /^[a-z]/.test(t) || /^[^\p{L}\p{N}("'‘“\[]/u.test(t);
}

const MATH = /\$[^$]+\$|\\ce\{|\\frac|\\sqrt/;

export function runQualityGate(input: QualityInput): QualityIssue[] {
  const { snapshot: s, content: c, design: d } = input;
  const issues: QualityIssue[] = [];
  const err = (code: string, message: string, slide?: number) => issues.push({ code, severity: "error", message, slide });
  const warn = (code: string, message: string, slide?: number) => issues.push({ code, severity: "warning", message, slide });

  // --- Source integrity ------------------------------------------------------
  if (input.currentHash === null) err("SOURCE_DELETED", "This question no longer exists in the Question Bank.");
  else if (input.currentHash !== input.snapshotHash) {
    err("SOURCE_CHANGED", "The question was edited in the Question Bank after this draft was created. Refresh the snapshot, then review again.");
  }

  // --- Question completeness -------------------------------------------------
  const stem = plainText(s.text);
  if (!stem) err("STEM_EMPTY", "The question text is empty.");
  else if (stemLooksTruncated(s.text)) {
    warn("STEM_TRUNCATED", `The question text starts with "${stem.slice(0, 24)}…" — it may be cut off (scan/OCR damage). Compare with the original paper; fix it in the Question Bank if damaged.`);
  }
  if (stem && stem.length < 12) warn("STEM_SHORT", "The question text is very short — check it is complete.");
  if (s.options.length < 2) err("OPTIONS_FEW", "The question has fewer than two options.");
  const emptyOpt = s.options.filter((o) => !plainText(o.text));
  if (emptyOpt.length) err("OPTION_EMPTY", `Option ${emptyOpt.map((o) => o.label).join(", ")} has no text.`);
  const seen = new Map<string, string>();
  for (const o of s.options) {
    const k = plainText(o.text).toLowerCase();
    if (!k) continue;
    if (seen.has(k)) err("OPTION_DUPLICATE", `Options ${seen.get(k)} and ${o.label} have the same text.`);
    seen.set(k, o.label);
  }
  const keyIssue = answerKeyIssue(s.options, s.questionType);
  if (keyIssue === "NO_CORRECT_OPTION") err("ANSWER_KEY", "No option is marked correct in the Question Bank.");
  else if (keyIssue) err("ANSWER_KEY", "The answer key is invalid for this question type (check the correct options in the Question Bank).");
  if (s.questionType === "MATCH_THE_FOLLOWING") err("TYPE_UNSUPPORTED", "Match the Following questions can't be laid out on slides yet.");
  if (s.hasImages) err("IMAGES_UNSUPPORTED", "This question has images — slides can't show question or option images yet.");
  if (s.contentFormat === "RICH_V1" && (MATH.test(s.text) || s.options.some((o) => MATH.test(o.text)))) {
    err("EQUATIONS_UNSUPPORTED", "This question uses equations/chemistry markup, which the slide renderer can't draw yet.");
  }

  // --- Attribution --------------------------------------------------------------
  if (input.series === "PYQ") {
    if (!s.paperId || !s.paperYear) err("NOT_PYQ", "This question is not linked to a previous year paper.");
    if (!input.questionNumber) warn("QUESTION_NUMBER_MISSING", "No printed question number entered — the slides will not show a question number.");
    else if (!input.questionNumberVerified) warn("QUESTION_NUMBER_UNVERIFIED", `Question number ${input.questionNumber} is not marked verified — it will not be shown on the slides.`);
  }
  if (s.status !== "PUBLISHED") warn("QB_NOT_PUBLISHED", `The question is ${s.status.toLowerCase()} in the Question Bank.`);
  if (s.reviewRequired) warn("QB_REVIEW_REQUIRED", `The Question Bank flags this question for review${s.reviewReason ? `: ${s.reviewReason}` : "."}`);

  if (input.series === "MOST_MISSED") {
    if (!input.seriesStats) err("STATS_MISSING", "Most Missed numbers were not captured for this draft.");
    else if (input.seriesStats.attempts < 20) warn("STATS_SMALL_SAMPLE", `Only ${input.seriesStats.attempts} answered attempts — the percentage may not be meaningful.`);
  }

  // --- Slides ---------------------------------------------------------------------
  const plans = planSlides(s, c, d, input.series === "MOST_MISSED" ? 2 : 1);
  plans.forEach((p, i) => {
    if (p.missing.length) err(`SLIDE_MISSING:${i}`, `Slide ${i + 1} (${MODULE_LABELS[p.module]}) is missing: ${p.missing.join(", ")}.`, i);
    if (p.overflow) err(`SLIDE_OVERFLOW:${i}`, `Slide ${i + 1} (${MODULE_LABELS[p.module]}) has too much text to stay readable. Shorten it or reduce the font scale.`, i);
  });
  if (input.follow.showInstagram && !input.follow.instagramHandle) err("FOLLOW_NO_INSTAGRAM", "No Instagram handle is configured (Instagram → Settings).");
  if (input.follow.showTelegram && !input.follow.telegramUrl) err("FOLLOW_NO_TELEGRAM", "Telegram is shown on the Follow slide but no Telegram URL is configured.");

  // --- Content safety (AI and manual text alike) --------------------------------------
  const ctx: SafetyContext = {
    paperYear: s.paperYear,
    correctLabels: s.options.filter((o) => o.isCorrect).map((o) => o.label),
    optionLabels: s.options.map((o) => o.label),
  };
  const fields: { name: string; text: string; strict: boolean }[] = [
    { name: "Hook", text: c.hookText, strict: true },
    { name: "Explanation", text: c.explanation, strict: false },
    { name: "Memory Trick", text: c.memoryTrick, strict: false },
    { name: "Clinical Pearl", text: c.clinicalPearl, strict: false },
    { name: "Quick Revision", text: c.quickRevision.join("\n"), strict: false },
    { name: "Final trick", text: c.showFinalTrick ? c.finalTrick : "", strict: false },
    { name: "Caption", text: c.caption, strict: true },
  ];
  for (const f of fields) {
    for (const p of checkText(f.text, ctx, { strictYears: f.strict, allowedDomains: f.name === "Caption" ? input.allowedDomains : undefined })) {
      err(`SAFETY:${f.name}:${p.rule}`, `${f.name}: ${p.message}`);
    }
  }
  if (input.unsupportedChars) {
    // The caption is not drawn on a slide (Instagram shows emoji there natively), so it is not checked.
    const drawn: { name: string; text: string }[] = [
      { name: "Question", text: s.text },
      ...s.options.map((o) => ({ name: `Option ${o.label}`, text: o.text })),
      ...fields.filter((f) => f.name !== "Caption"),
      { name: "Follow slide settings", text: (input.settingsTexts ?? []).join(" ") },
    ];
    for (const f of drawn) {
      const bad = input.unsupportedChars(f.text);
      if (bad.length) {
        err(
          `GLYPHS:${f.name}`,
          `${f.name} contains ${bad.map((ch) => `"${ch}"`).join(", ")}, which the slide fonts can't draw (shown as □). ${f.name.startsWith("Question") || f.name.startsWith("Option") ? "Fix it in the Question Bank and refresh the snapshot." : "Remove or replace it."}`
        );
      }
    }
  }
  if (!c.caption.trim()) err("CAPTION_EMPTY", "The caption is empty.");
  if (c.origin.kind === "ai" || c.origin.kind === "existing-explanation") {
    warn("AI_CONTENT", "Explanation, trick and pearl were written by AI — check every medical statement.");
  }
  if (s.aiExplanation?.isStale && c.origin.kind === "existing-explanation") warn("AI_STALE", "The source AI explanation is marked stale (the question changed after it was generated).");
  c.aiFlags.forEach((f, i) => warn(`AI_FLAG:${i}`, `AI note: ${f}`));
  return issues;
}

export function blockingIssues(issues: QualityIssue[]): QualityIssue[] {
  return issues.filter((i) => i.severity === "error");
}

export function warningCodes(issues: QualityIssue[]): string[] {
  return issues.filter((i) => i.severity === "warning").map((i) => i.code);
}
