import "server-only";
import { randomBytes } from "node:crypto";
import { AiImportQuestionStatus, Prisma, type AiImportFigure, type AiImportQuestion } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ImportJobError, logEvent } from "@/lib/ai-import/jobs";
import { effective } from "@/lib/ai-import/post";
import { statementsOf } from "@/lib/ai-import/local-parse";
import { fingerprintsOf, verifyState } from "@/lib/ai-import/verify-core";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

/**
 * Reusable paper-format profiles of the AI Question Importer (Admin → AI Question Importer → Format Profiles).
 *
 * A profile records how a paper of one exam and source format is laid out — option labels, numbered-statement
 * style, where the answer is printed and the words before it, questions spanning pages, figure positions, known
 * OCR errors. It is built ONLY from questions that passed Verify 1 and were independently verified (Verify 2) or
 * approved by an administrator — never from guessed answers or unconfirmed classifications — and it never changes a
 * question: Verify 1 checks each new paper of the same exam / format against it and reports deviations as
 * findings. Master Admin can inspect, edit and disable profiles; every change is a new version with history.
 *
 * Stored in one Setting row (no schema change), like the importer's other settings.
 */

export const FORMAT_PROFILES_KEY = "ai.importer.formatProfiles";

export interface FormatRules {
  /** How options are printed: "(a)", "A.", "(A)", "a)" … (the shape of the first label). */
  optionLabels: string | null;
  /** Numbered statements in stems, when the format uses them. */
  statementNumbering: "roman" | "arabic" | "letter" | null;
  /** Where the answer is printed: beneath every question, only in a separate key, or nowhere. */
  answerPlacement: "below-question" | "answer-key" | "none";
  /** The words printed before the answer label ("► Official Answer: Option"), when they are always the same. */
  answerLinePrefix: string | null;
  /** Explanations are printed after the answer. */
  explanations: boolean;
  /** Questions may continue on the next page. */
  spansPages: boolean;
  /** Where figures sit. */
  figures: "none" | "stem" | "options" | "both";
  /** Known OCR / conversion errors of this format: reported where they occur, never replaced automatically. */
  ocrErrors: { wrong: string; right: string }[];
  notes: string;
}

export interface FormatProfile {
  id: string;
  name: string;
  examId: string;
  /** Source format of the question paper: docx, pdf, png, jpeg, xlsx, csv. */
  sourceKind: string;
  version: number;
  enabled: boolean;
  rules: FormatRules;
  /** What the rules were learned from (verified questions of one import). */
  evidence: { jobId: string; jobTitle: string; verifiedQuestions: number; at: string };
  createdById: string;
  createdAt: string;
  updatedById: string;
  updatedAt: string;
  history: { version: number; at: string; byId: string; enabled: boolean; rules: FormatRules; note: string }[];
}

type QRow = AiImportQuestion & { figures: AiImportFigure[] };

export async function listFormatProfiles(): Promise<FormatProfile[]> {
  const row = await prisma.setting.findUnique({ where: { key: FORMAT_PROFILES_KEY } });
  const v = (row?.value ?? {}) as { profiles?: FormatProfile[] };
  return Array.isArray(v.profiles) ? v.profiles : [];
}

async function saveProfiles(profiles: FormatProfile[], actorId: string, action: string, entityId: string): Promise<void> {
  const value = JSON.stringify({ profiles });
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES (${FORMAT_PROFILES_KEY}, ${value}::jsonb, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = ${value}::jsonb, "updatedAt" = now()`);
  await prisma.auditLog.create({ data: { actorId, action, entityType: "AiImportFormatProfile", entityId } });
}

const fpOf = (q: QRow) => fingerprintsOf({ e: effective(q), finalAnswer: q.finalAnswer, subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, figures: q.figures });

/** Verified = Verify 1 passed (current) and either Verify 2 agreed (current) or an administrator approved / stored it. */
export function isVerifiedForProfile(q: QRow): boolean {
  if (q.status === AiImportQuestionStatus.REJECTED) return false;
  const s = verifyState(q.data, fpOf(q));
  return s.v1 === "passed" && (s.v2 === "verified" || !!q.approvedById || !!q.questionId);
}

const labelShape = (printed: string) => printed.replace(/[a-e]/, "a").replace(/[A-E]/, "A").replace(/[1-5]/, "1").trim();
const mode = <T,>(xs: T[]): { value: T | null; share: number } => {
  const n = new Map<string, { v: T; c: number }>();
  for (const x of xs) {
    const k = JSON.stringify(x);
    n.set(k, { v: x, c: (n.get(k)?.c ?? 0) + 1 });
  }
  const best = [...n.values()].sort((a, b) => b.c - a.c)[0];
  return best ? { value: best.v, share: best.c / xs.length } : { value: null, share: 0 };
};

/** The rules shown by verified questions only (pure; exported for the regression suite). */
export function deriveRules(qs: ExtractedQuestion[]): FormatRules {
  const labels = mode(qs.filter((q) => q.options[0]?.printed).map((q) => labelShape(q.options[0].printed)));
  const fam = (q: ExtractedQuestion) => {
    const st = statementsOf(q.stem);
    if (!st.length) return null;
    return /^\d$/.test(st[0].key) ? "arabic" : /^[IVX]+$/.test(st[0].key) ? "roman" : "letter";
  };
  const fams = qs.map(fam).filter((x): x is "roman" | "arabic" | "letter" => !!x);
  const families = mode(fams);
  const printed = qs.filter((q) => q.printedAnswerRaw);
  // The words before the label: "► Official Answer: Option (c) — III and IV" → "► Official Answer: Option".
  // The label is "(c)" or a lone "C" / "3" (never a letter inside a word such as the "c" of "Official").
  const prefixes = printed.map((q) => q.printedAnswerRaw!.split(/\(\s*[A-Da-d1-4]\s*\)|(?<![\p{L}\p{N}])[A-Da-d1-4](?![\p{L}\p{N}])/u)[0].trim()).filter(Boolean);
  const prefix = mode(prefixes);
  const withFig = (q: ExtractedQuestion) => q.figures.map((f) => f.owner);
  const owners = new Set(qs.flatMap(withFig));
  return {
    optionLabels: labels.share >= 0.8 ? labels.value : null,
    statementNumbering: families.value && fams.length >= 2 && families.share >= 0.8 ? families.value : null,
    answerPlacement: qs.length && printed.length / qs.length >= 0.8 ? "below-question" : printed.length === 0 ? "answer-key" : "none",
    answerLinePrefix: prefix.value && prefix.share >= 0.8 && prefixes.length >= Math.max(3, printed.length * 0.8) ? prefix.value : null,
    explanations: qs.length > 0 && qs.filter((q) => q.hints?.explanation).length / qs.length >= 0.5,
    spansPages: qs.some((q) => q.pages.length > 1),
    figures: owners.has("OPTION") && owners.has("STEM") ? "both" : owners.has("OPTION") ? "options" : owners.has("STEM") ? "stem" : "none",
    ocrErrors: [],
    notes: "",
  };
}

/** Deviations of one question from a profile (pure). Reported as Verify 1 findings, never applied as changes. */
export function profileDeviations(rules: FormatRules, q: ExtractedQuestion, hasOfficialKey: boolean): string[] {
  const out: string[] = [];
  const texts = [q.stem, ...q.options.map((o) => o.text)];
  if (rules.optionLabels && q.options.length && q.options[0].printed && labelShape(q.options[0].printed) !== rules.optionLabels) out.push(`options are printed as “${q.options[0].printed}” here; this format prints “${rules.optionLabels}” — check the option boundaries`);
  if (rules.answerPlacement === "below-question" && !q.printedAnswerRaw && !hasOfficialKey) out.push("this format prints the answer beneath every question, but none was found here — check that the answer line was not merged into an option or the next question");
  if (rules.answerLinePrefix) {
    const p = rules.answerLinePrefix.toLowerCase();
    const inOption = q.options.find((o) => o.text.toLowerCase().includes(p));
    if (inOption) out.push(`option ${inOption.label} contains this format's answer line (“${rules.answerLinePrefix}”) — answer text inside an option`);
    else if (q.stem.toLowerCase().includes(p)) out.push(`the question text contains this format's answer line (“${rules.answerLinePrefix}”)`);
  }
  if (rules.statementNumbering && statementsOf(q.stem).length === 0 && /\b(statements?|following)\b[\s\S]*\b(code|correct)\b/i.test(q.stem) && /(?:^|[^\n])\b(?:I{1,3}|IV|[1-4])\.\s/.test(q.stem)) out.push(`the numbered statements are not on separate lines (this format numbers them ${rules.statementNumbering === "roman" ? "I, II, III" : rules.statementNumbering === "arabic" ? "1, 2, 3" : "A, B, C"})`);
  for (const e of rules.ocrErrors) if (e.wrong && texts.some((t) => t.includes(e.wrong))) out.push(`contains “${e.wrong}”, a known reading error of this format (usually “${e.right}”) — compare with the source`);
  return out;
}

async function jobFormat(jobId: string): Promise<{ examId: string; title: string; kind: string | null } | null> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { examId: true, title: true } });
  if (!job) return null;
  const file = await prisma.aiImportFile.findFirst({ where: { jobId, role: "PAPER" }, orderBy: { createdAt: "asc" }, select: { detected: true } });
  return { examId: job.examId, title: job.title, kind: (file?.detected as { kind?: string } | null)?.kind ?? null };
}

/** Verify 1: the enabled profile for this job's exam + format, checked against every open question. */
export async function applyFormatProfile(jobId: string): Promise<{ profile: FormatProfile; findings: Map<string, { id: string; version: number; findings: string[] }>; summary: string } | null> {
  const fmt = await jobFormat(jobId);
  if (!fmt?.kind) return null;
  const profile = (await listFormatProfiles()).find((p) => p.enabled && p.examId === fmt.examId && p.sourceKind === fmt.kind);
  if (!profile) return null;
  const qs = await prisma.aiImportQuestion.findMany({ where: { jobId, status: { notIn: [AiImportQuestionStatus.IMPORTED, AiImportQuestionStatus.PUBLISHED, AiImportQuestionStatus.REJECTED] } } });
  const findings = new Map<string, { id: string; version: number; findings: string[] }>();
  for (const q of qs) {
    const f = profileDeviations(profile.rules, effective(q), q.answerStatus === "OFFICIAL_MATCHED" || q.answerStatus === "KEY_MISMATCH");
    if (f.length) findings.set(q.id, { id: profile.id, version: profile.version, findings: f });
  }
  const summary = `format profile “${profile.name}” v${profile.version} checked: ${findings.size} question(s) deviate from it`;
  await logEvent(jobId, "FORMAT_PROFILE_APPLIED", `Format profile “${profile.name}” (version ${profile.version}) checked against this paper: ${findings.size} of ${qs.length} question(s) deviate from it (reported as Verify 1 findings; nothing was changed).`, { profileId: profile.id, version: profile.version, deviations: findings.size });
  return { profile, findings, summary };
}

/** Master Admin: a new profile (or a new version of this exam + format's profile) from an import's verified questions. */
export async function saveProfileFromJob(input: { jobId: string; actorId: string; name: string }): Promise<FormatProfile> {
  const fmt = await jobFormat(input.jobId);
  if (!fmt) throw new ImportJobError("Import job not found.", 404);
  if (!fmt.kind) throw new ImportJobError("This import has no question paper.");
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId: input.jobId }, include: { figures: true } });
  const verified = rows.filter(isVerifiedForProfile);
  if (verified.length < 5) throw new ImportJobError(`A format profile is learned only from verified questions (Verify 1 passed and Verify 2 agreed, or approved by an administrator). This import has ${verified.length}; at least 5 are needed. Nothing was saved.`);
  const rules = deriveRules(verified.map((q) => effective(q)));
  const profiles = await listFormatProfiles();
  const now = new Date().toISOString();
  const evidence = { jobId: input.jobId, jobTitle: fmt.title, verifiedQuestions: verified.length, at: now };
  const existing = profiles.find((p) => p.examId === fmt.examId && p.sourceKind === fmt.kind);
  let profile: FormatProfile;
  if (existing) {
    profile = { ...existing, name: input.name.trim().slice(0, 120) || existing.name, version: existing.version + 1, rules: { ...rules, ocrErrors: existing.rules.ocrErrors, notes: existing.rules.notes }, evidence, updatedById: input.actorId, updatedAt: now, history: [...existing.history, { version: existing.version, at: existing.updatedAt, byId: existing.updatedById, enabled: existing.enabled, rules: existing.rules, note: "replaced by rules learned again from verified questions" }].slice(-50) };
  } else {
    profile = { id: `fp_${randomBytes(6).toString("hex")}`, name: input.name.trim().slice(0, 120) || `${fmt.title} format`, examId: fmt.examId, sourceKind: fmt.kind, version: 1, enabled: true, rules, evidence, createdById: input.actorId, createdAt: now, updatedById: input.actorId, updatedAt: now, history: [] };
  }
  await saveProfiles([...profiles.filter((p) => p.id !== profile.id), profile], input.actorId, "AI_IMPORT_FORMAT_PROFILE_SAVED", profile.id);
  await logEvent(input.jobId, "FORMAT_PROFILE_SAVED", `Format profile “${profile.name}” version ${profile.version} learned from ${verified.length} verified question(s) of this import.`, { profileId: profile.id, version: profile.version, rules: profile.rules as unknown as Prisma.InputJsonValue }, input.actorId);
  return profile;
}

const PLACEMENTS = ["below-question", "answer-key", "none"] as const;
const FAMILIES = ["roman", "arabic", "letter"] as const;
const FIGS = ["none", "stem", "options", "both"] as const;

/** Master Admin: edit a profile's name / rules / enabled switch (a new version; the previous one stays in the history). */
export async function updateFormatProfile(input: { id: string; actorId: string; name?: string; enabled?: boolean; rules?: Partial<FormatRules>; note?: string }): Promise<FormatProfile> {
  const profiles = await listFormatProfiles();
  const p = profiles.find((x) => x.id === input.id);
  if (!p) throw new ImportJobError("Format profile not found.", 404);
  const r = input.rules ?? {};
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) || null : null);
  const rules: FormatRules = {
    optionLabels: r.optionLabels !== undefined ? str(r.optionLabels, 12) : p.rules.optionLabels,
    statementNumbering: r.statementNumbering !== undefined ? (FAMILIES.includes(r.statementNumbering as never) ? r.statementNumbering! : null) : p.rules.statementNumbering,
    answerPlacement: r.answerPlacement !== undefined ? (PLACEMENTS.includes(r.answerPlacement as never) ? r.answerPlacement! : "none") : p.rules.answerPlacement,
    answerLinePrefix: r.answerLinePrefix !== undefined ? str(r.answerLinePrefix, 80) : p.rules.answerLinePrefix,
    explanations: r.explanations !== undefined ? !!r.explanations : p.rules.explanations,
    spansPages: r.spansPages !== undefined ? !!r.spansPages : p.rules.spansPages,
    figures: r.figures !== undefined ? (FIGS.includes(r.figures as never) ? r.figures! : "none") : p.rules.figures,
    ocrErrors: r.ocrErrors !== undefined ? (Array.isArray(r.ocrErrors) ? r.ocrErrors : []).map((e) => ({ wrong: String(e?.wrong ?? "").slice(0, 40), right: String(e?.right ?? "").slice(0, 40) })).filter((e) => e.wrong && e.wrong !== e.right).slice(0, 50) : p.rules.ocrErrors,
    notes: r.notes !== undefined ? String(r.notes ?? "").slice(0, 1000) : p.rules.notes,
  };
  const now = new Date().toISOString();
  const next: FormatProfile = { ...p, name: input.name !== undefined ? input.name.trim().slice(0, 120) || p.name : p.name, enabled: input.enabled ?? p.enabled, rules, version: p.version + 1, updatedById: input.actorId, updatedAt: now, history: [...p.history, { version: p.version, at: p.updatedAt, byId: p.updatedById, enabled: p.enabled, rules: p.rules, note: (input.note ?? "edited by Master Admin").slice(0, 200) }].slice(-50) };
  await saveProfiles(profiles.map((x) => (x.id === p.id ? next : x)), input.actorId, input.enabled === false ? "AI_IMPORT_FORMAT_PROFILE_DISABLED" : "AI_IMPORT_FORMAT_PROFILE_UPDATED", p.id);
  return next;
}
