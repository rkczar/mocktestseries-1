"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { HANDLE_PATTERN, TEXT_LIMITS, allowedCaptionDomains, getStudioSettings, saveStudioSettings, type StoredStudioSettings } from "@/lib/instagram/config";
import { generateContent, prefillFromReference } from "@/lib/instagram/ai";
import { parseLayoutInstruction, targetFields } from "@/lib/instagram/instructions";
import { parseMostMissedFilters, statsForQuestion } from "@/lib/instagram/most-missed";
import {
  StudioError,
  applyChange,
  backToDraft,
  createDraft,
  createNewVersion,
  deleteDraft,
  getPostDto,
  getQuestionPostState,
  markReady,
  refreshSnapshot,
  restoreRevision,
  setQuestionNumber,
  undoLast,
  type PostDto,
  type QuestionPostState,
} from "@/lib/instagram/posts";
import type { QualityIssue } from "@/lib/instagram/quality";
import { getAiReference } from "@/lib/instagram/snapshot";
import { checkContentInput, checkDesignInput } from "@/lib/instagram/validate";
import { CONTENT_FIELDS, SLIDE_COUNTS, SLIDE_MODULES, TEMPLATE_KEYS, normalizeHashtags, type ContentField, type SlideModule } from "@/lib/instagram/types";
import { safeTelegramUrl } from "@/lib/telegram-url";
import { AiNotConfiguredError } from "@/lib/ai-provider";
import { CONNECTION_SETTING_KEY, getConnectionConfigView, getLastConnectionResult, runConnectionTest, saveConnectionResult, type ConnectionConfigView, type ConnectionTestResult } from "@/lib/instagram/meta";

/**
 * Admin → Instagram Server Actions. Every action re-checks INSTAGRAM_MANAGE
 * (MASTER_ADMIN only) — a Server Action is callable on its own, so the
 * page-level check is never relied on. Writes go only to InstagramPost /
 * InstagramPostRevision / the `instagram.studio` Setting / AuditLog
 * (lib/instagram/posts.ts), plus the `instagram.connection` Setting for the
 * read-only Meta connection test. Nothing here publishes: publishing is not
 * built in this phase.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; kind?: StudioError["kind"] };

const ID = /^[a-z0-9]{10,40}$/i;
const NOT_ALLOWED = "Only a Master Admin can use the Instagram studio.";

async function requireStudio(): Promise<string | null> {
  try {
    const session = await requirePermission(PERMISSIONS.INSTAGRAM_MANAGE);
    return session.user.id ?? null;
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

/** Runs an action for an already-checked actor (null = not allowed); StudioErrors become friendly results. */
async function run<T>(actorId: string | null, fn: (actorId: string) => Promise<T>): Promise<Result<T>> {
  if (!actorId) return { ok: false, error: NOT_ALLOWED };
  try {
    return { ok: true, data: await fn(actorId) };
  } catch (error) {
    if (error instanceof StudioError) return { ok: false, error: error.message, kind: error.kind };
    if (error instanceof AiNotConfiguredError) return { ok: false, error: error.message || "AI generation is not configured or is paused (Platform Controls)." };
    console.error("[instagram-studio]", error);
    return { ok: false, error: "Something went wrong. Nothing was changed — try again." };
  }
}

function checkId(id: unknown): string {
  if (typeof id !== "string" || !ID.test(id)) throw new StudioError("Invalid id.");
  return id;
}

function checkRevision(n: unknown): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new StudioError("Invalid revision.");
  return n;
}

function touch() {
  revalidatePath("/admin/instagram", "layout");
}

// ---- Loading ------------------------------------------------------------------

export async function loadQuestionPostAction(questionId: string): Promise<Result<QuestionPostState>> {
  return run(await requireStudio(), async () => getQuestionPostState(checkId(questionId)));
}

export async function loadPostAction(postId: string): Promise<Result<PostDto>> {
  return run(await requireStudio(), async () => getPostDto(checkId(postId)));
}

// ---- Create ---------------------------------------------------------------------

export async function createPyqDraftAction(questionId: string): Promise<Result<{ post: PostDto; existed: boolean }>> {
  return run(await requireStudio(), async (actorId) => {
    const r = await createDraft({ questionId: checkId(questionId), series: "PYQ", stats: null, actorId });
    touch();
    return r;
  });
}

/** Most Missed numbers are recomputed here from the page's filters — the client never supplies them. */
export async function createMostMissedDraftAction(questionId: string, filterQuery: string): Promise<Result<{ post: PostDto; existed: boolean }>> {
  return run(await requireStudio(), async (actorId) => {
    const id = checkId(questionId);
    const filters = parseMostMissedFilters(Object.fromEntries(new URLSearchParams(String(filterQuery ?? "").slice(0, 2000))));
    const stats = await statsForQuestion(filters, id);
    if (!stats) throw new StudioError("This question is no longer in the Most Missed list for these filters. Reload the list.");
    const r = await createDraft({ questionId: id, series: "MOST_MISSED", stats, actorId });
    touch();
    return r;
  });
}

export async function createNewVersionAction(postId: string): Promise<Result<PostDto>> {
  return run(await requireStudio(), async (actorId) => {
    const r = await createNewVersion(checkId(postId), actorId);
    touch();
    return r;
  });
}

// ---- Edit -------------------------------------------------------------------------

export async function saveDraftAction(input: { postId: string; expectedRevision: number; content: unknown; design: unknown; confirmReplaceApproved?: boolean }): Promise<Result<PostDto>> {
  return run(await requireStudio(), async (actorId) => {
    const postId = checkId(input.postId);
    const current = await getPostDto(postId);
    const content = checkContentInput(input.content, current.content);
    if (!content.ok) throw new StudioError(content.error);
    const design = checkDesignInput(input.design);
    if (!design.ok) throw new StudioError(design.error);
    const r = await applyChange({
      postId,
      expectedRevision: checkRevision(input.expectedRevision),
      content: content.value,
      design: design.value,
      note: "Edited and saved",
      actorId,
      confirmReplaceApproved: input.confirmReplaceApproved === true,
    });
    touch();
    return r;
  });
}

export interface AiEditResult {
  post: PostDto;
  summary: string;
  kind: "layout" | "content";
  rejected: { field: ContentField; reason: string }[];
}

/**
 * The editor's AI box. Unsaved editor state (content/design) is validated and
 * becomes the base, then:
 *  - a layout instruction (font size, theme) changes the design only — no AI call;
 *  - otherwise only the targeted fields are regenerated (selected slide, or the
 *    fields the instruction names, or explicit `fields`).
 * The result is saved as one new revision, so Undo restores the previous state.
 */
export async function aiEditAction(input: {
  postId: string;
  expectedRevision: number;
  content: unknown;
  design: unknown;
  instruction?: string;
  selectedModule?: string | null;
  fields?: string[];
  confirmReplaceApproved?: boolean;
}): Promise<Result<AiEditResult>> {
  return run(await requireStudio(), async (actorId) => {
    const postId = checkId(input.postId);
    const current = await getPostDto(postId);
    const content = checkContentInput(input.content, current.content);
    if (!content.ok) throw new StudioError(content.error);
    const design = checkDesignInput(input.design);
    if (!design.ok) throw new StudioError(design.error);
    const instruction = typeof input.instruction === "string" ? input.instruction.trim().slice(0, 500) : "";
    const selected = (SLIDE_MODULES as readonly string[]).includes(input.selectedModule ?? "") ? (input.selectedModule as SlideModule) : null;
    const expectedRevision = checkRevision(input.expectedRevision);
    const confirm = input.confirmReplaceApproved === true;

    const layout = instruction ? parseLayoutInstruction(instruction, design.value) : null;
    if (layout) {
      const post = await applyChange({ postId, expectedRevision, content: content.value, design: { ...design.value, ...layout.patch }, note: `Layout: ${layout.summary}`, actorId, confirmReplaceApproved: confirm });
      touch();
      return { post, summary: layout.summary, kind: "layout" as const, rejected: [] };
    }

    const explicit = Array.isArray(input.fields) ? input.fields.filter((f): f is ContentField => (CONTENT_FIELDS as readonly string[]).includes(f)) : [];
    const targets = explicit.length ? explicit : instruction ? targetFields(instruction, selected) : selected ? targetFields("", selected) : [...CONTENT_FIELDS];
    const settings = await getStudioSettings();
    const outcome = await generateContent({
      snapshot: current.snapshot,
      series: current.series,
      stats: current.seriesStats,
      current: content.value,
      targets,
      instruction: instruction || undefined,
      reference: await getAiReference(current.questionId),
      allowedDomains: allowedCaptionDomains(settings),
    });
    if (!outcome.changed.length) {
      return { post: current, summary: outcome.summary + (outcome.rejected.length ? ` (${outcome.rejected.map((r) => `${r.field}: ${r.reason}`).join("; ")})` : ""), kind: "content" as const, rejected: outcome.rejected };
    }
    const note = `AI: ${instruction ? `"${instruction.slice(0, 80)}" → ` : ""}${outcome.changed.join(", ")}`;
    const post = await applyChange({ postId, expectedRevision, content: outcome.content, design: design.value, note, actorId, confirmReplaceApproved: confirm });
    touch();
    return { post, summary: outcome.summary, kind: "content" as const, rejected: outcome.rejected };
  });
}

/** Fill explanation / trick / revision from the question's existing student AI explanation (no new AI call). */
export async function prefillFromExplanationAction(input: { postId: string; expectedRevision: number; content: unknown; design: unknown; confirmReplaceApproved?: boolean }): Promise<Result<{ post: PostDto; summary: string }>> {
  return run(await requireStudio(), async (actorId) => {
    const postId = checkId(input.postId);
    const current = await getPostDto(postId);
    const content = checkContentInput(input.content, current.content);
    if (!content.ok) throw new StudioError(content.error);
    const design = checkDesignInput(input.design);
    if (!design.ok) throw new StudioError(design.error);
    const ref = await getAiReference(current.questionId);
    if (!ref) throw new StudioError("This question has no completed AI explanation to copy from.");
    const filled = prefillFromReference(current.snapshot, content.value, ref);
    if (!filled.used.length) throw new StudioError(`Nothing could be copied${filled.skipped.length ? ` — ${filled.skipped.join(", ")} failed the length or safety checks` : ""}.`);
    const post = await applyChange({
      postId,
      expectedRevision: checkRevision(input.expectedRevision),
      content: filled.content,
      design: design.value,
      note: `Copied from AI explanation: ${filled.used.join(", ")}`,
      actorId,
      confirmReplaceApproved: input.confirmReplaceApproved === true,
    });
    touch();
    return { post, summary: `Copied ${filled.used.join(", ")}${filled.skipped.length ? `; skipped ${filled.skipped.join(", ")}` : ""}.` };
  });
}

export async function undoAction(postId: string, expectedRevision: number, confirmReplaceApproved = false): Promise<Result<PostDto>> {
  return run(await requireStudio(), async (actorId) => {
    const r = await undoLast(checkId(postId), checkRevision(expectedRevision), actorId, confirmReplaceApproved === true);
    touch();
    return r;
  });
}

export async function restoreRevisionAction(postId: string, expectedRevision: number, targetRevision: number, confirmReplaceApproved = false): Promise<Result<PostDto>> {
  return run(await requireStudio(), async (actorId) => {
    const r = await restoreRevision(checkId(postId), checkRevision(expectedRevision), checkRevision(targetRevision), actorId, confirmReplaceApproved === true);
    touch();
    return r;
  });
}

export async function setQuestionNumberAction(postId: string, expectedRevision: number, questionNumber: number | null, verified: boolean, confirmReplaceApproved = false): Promise<Result<PostDto>> {
  return run(await requireStudio(), async (actorId) => {
    const r = await setQuestionNumber(checkId(postId), checkRevision(expectedRevision), questionNumber, verified === true, actorId, confirmReplaceApproved === true);
    touch();
    return r;
  });
}

export async function refreshSnapshotAction(postId: string, expectedRevision: number): Promise<Result<PostDto>> {
  return run(await requireStudio(), async (actorId) => {
    const r = await refreshSnapshot(checkId(postId), checkRevision(expectedRevision), actorId);
    touch();
    return r;
  });
}

// ---- Review -------------------------------------------------------------------------

export async function markReadyAction(input: { postId: string; expectedRevision: number; checklist: Record<string, boolean>; acknowledged: string[] }): Promise<
  Result<{ post: PostDto; blocked: QualityIssue[]; missingAcks: string[]; missingChecklist: string[] }>
> {
  return run(await requireStudio(), async (actorId) => {
    const checklist = Object.fromEntries(Object.entries(input.checklist ?? {}).filter(([k, v]) => typeof k === "string" && typeof v === "boolean").slice(0, 20));
    const acknowledged = Array.isArray(input.acknowledged) ? input.acknowledged.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
    const r = await markReady({ postId: checkId(input.postId), expectedRevision: checkRevision(input.expectedRevision), checklist, acknowledged, actorId });
    touch();
    return r;
  });
}

export async function backToDraftAction(postId: string): Promise<Result<PostDto>> {
  return run(await requireStudio(), async (actorId) => {
    const r = await backToDraft(checkId(postId), actorId);
    touch();
    return r;
  });
}

export async function deleteDraftAction(postId: string): Promise<Result<null>> {
  return run(await requireStudio(), async (actorId) => {
    await deleteDraft(checkId(postId), actorId);
    touch();
    return null;
  });
}

// ---- Settings -----------------------------------------------------------------------------

export async function saveStudioSettingsAction(input: Record<string, unknown>): Promise<Result<null>> {
  return run(await requireStudio(), async (actorId) => {
    const str = (k: string, max: number) => {
      const v = typeof input[k] === "string" ? (input[k] as string).trim() : "";
      if (v.length > max) throw new StudioError(`${k} is too long (max ${max} characters).`);
      return v || undefined;
    };
    const bool = (k: string) => input[k] === true;
    const handle = str("instagramHandle", 31)?.replace(/^@/, "");
    if (handle && !HANDLE_PATTERN.test(handle)) throw new StudioError("Instagram handle: letters, numbers, dots and underscores only (max 30).");
    const telegramRaw = str("telegramUrl", 200);
    const telegramUrl = telegramRaw ? safeTelegramUrl(telegramRaw) : undefined;
    if (telegramRaw && !telegramUrl) throw new StudioError("Telegram link must be an https://t.me/… link.");
    const websiteUrl = str("websiteUrl", 200);
    if (websiteUrl && !/^https:\/\/[a-z0-9.-]+(\/[^\s]*)?$/i.test(websiteUrl)) throw new StudioError("Website URL must start with https://");
    const template = TEMPLATE_KEYS.find((t) => t === input.defaultTemplate);
    const count = SLIDE_COUNTS.find((n) => n === Number(input.defaultSlideCount));
    const badgesIn = (input.examBadges ?? {}) as Record<string, unknown>;
    const examBadges: Record<string, string> = {};
    for (const [examId, v] of Object.entries(badgesIn).slice(0, 100)) {
      if (!ID.test(examId) || typeof v !== "string" || !v.trim()) continue;
      if (v.trim().length > TEXT_LIMITS.examBadge) throw new StudioError(`Exam badge "${v.trim().slice(0, 20)}…" is too long (max ${TEXT_LIMITS.examBadge}).`);
      examBadges[examId] = v.trim();
    }
    const next: StoredStudioSettings = {
      instagramHandle: handle,
      telegramUrl: telegramUrl ?? undefined,
      telegramName: str("telegramName", TEXT_LIMITS.telegramName),
      websiteUrl,
      ctaHeadline: str("ctaHeadline", TEXT_LIMITS.ctaHeadline),
      ctaDescription: str("ctaDescription", TEXT_LIMITS.ctaDescription),
      footerText: str("footerText", TEXT_LIMITS.footerText),
      showInstagram: bool("showInstagram"),
      showTelegram: bool("showTelegram"),
      showWebsite: bool("showWebsite"),
      showSaveShare: bool("showSaveShare"),
      defaultTemplate: template,
      defaultSlideCount: count,
      defaultHashtags: normalizeHashtags(Array.isArray(input.defaultHashtags) ? input.defaultHashtags.filter((x): x is string => typeof x === "string") : []),
      examBadges,
    };
    await saveStudioSettings(next);
    await prisma.auditLog.create({ data: { actorId, action: "INSTAGRAM_SETTINGS_UPDATED", entityType: "Setting", entityId: "instagram.studio", metadata: { keys: Object.keys(next).filter((k) => next[k as keyof StoredStudioSettings] !== undefined) } } });
    touch();
    return null;
  });
}

// ---- Meta connection (read-only) -----------------------------------------------------------

/** Read-only Instagram API test (GET /me + publishing-limit read). Returns no token — only identity and permission status. */
export async function testInstagramConnectionAction(): Promise<Result<{ result: ConnectionTestResult; config: ConnectionConfigView }>> {
  return run(await requireStudio(), async (actorId) => {
    const last = await getLastConnectionResult();
    if (last && Date.now() - Date.parse(last.testedAt) < 5_000) throw new StudioError("A test just ran — wait a few seconds and try again.");
    const result = await runConnectionTest();
    await saveConnectionResult(result, actorId);
    await prisma.auditLog.create({
      data: { actorId, action: "INSTAGRAM_CONNECTION_TESTED", entityType: "Setting", entityId: CONNECTION_SETTING_KEY, metadata: { status: result.status, publishPermission: result.publishPermission, tokenFingerprint: result.tokenFingerprint } },
    });
    touch();
    return { result, config: getConnectionConfigView() };
  });
}
