"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { AiNotConfiguredError } from "@/lib/ai-provider";
import { AiProviderFailure } from "@/lib/ai-gateway";
import { GATEWAY_PROVIDERS, type GatewayProvider } from "@/lib/ai-gateway-config";
import { allowedCaptionDomains, getStudioSettings } from "@/lib/instagram/config";
import { StudioError, applyChange, getPostDto, type PostDto } from "@/lib/instagram/posts";
import { checkContentInput, checkDesignInput } from "@/lib/instagram/validate";
import { generateCaptions, generateDiagram, generateTrap, gatewayGenerator } from "@/lib/instagram/ai-studio";
import { getTrendEvidence, runCompetitorAnalysis, runTrendAnalysis } from "@/lib/instagram/trends";
import { refreshPostMetrics } from "@/lib/instagram/metrics";
import { deletePreset, savePreset, type DesignPreset } from "@/lib/instagram/presets";
import { saveScope } from "@/lib/instagram/scope";
import { selectCandidates, type Candidate } from "@/lib/instagram/selection";
import { advanceQueue, applyDesignToBatch, bulkPreflight, checkItemStatus, confirmQueue, createBatch, getBatchView, retryItem, setQueueStatus, type BatchView, type BulkPreflightItem } from "@/lib/instagram/batch";
import { runPublishJob } from "@/lib/instagram/publish";
import { generateMedicalImage, imageGenerationStatus, importReferenceImage, searchReferenceImages } from "@/lib/instagram/medical-image";
import type { ReferenceImageResult } from "@/lib/instagram/medical-image-core";
import { DIAGRAM_KINDS, TEMPLATE_KEYS, type DiagramKind, type PostContent, type PostDesign, type TemplateKey } from "@/lib/instagram/types";
import { EXCLUDED_TERMS } from "@/lib/instagram/exam-scope";
import { consumeQuote } from "@/lib/ai-engine/quote";
import { postCost } from "@/lib/ai-engine/analytics";
import type { AiFeature } from "@/lib/ai-gateway-config";

/**
 * Admin → Instagram — AI Studio Server Actions (diagram, examiner trap,
 * caption versions, design presets, exam scope, smart selection, Bulk Studio
 * and its attended publishing queue, metrics, Trends & Competitors).
 * Same guard as actions.ts: every action re-checks INSTAGRAM_MANAGE
 * (MASTER_ADMIN only) server-side; queue/publish steps also require the
 * MASTER_ADMIN role itself.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; kind?: StudioError["kind"] };

const ID = /^[a-z0-9-]{10,40}$/i;
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

async function requirePublisher(): Promise<string | null> {
  try {
    const session = await requirePermission(PERMISSIONS.INSTAGRAM_MANAGE);
    return session.user.role === "MASTER_ADMIN" ? (session.user.id ?? null) : null;
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

async function run<T>(actorId: string | null, fn: (actorId: string) => Promise<T>): Promise<Result<T>> {
  if (!actorId) return { ok: false, error: NOT_ALLOWED };
  try {
    return { ok: true, data: await fn(actorId) };
  } catch (error) {
    if (error instanceof StudioError) return { ok: false, error: error.message, kind: error.kind };
    if (error instanceof AiNotConfiguredError) return { ok: false, error: error.message || "AI generation is not configured or is paused (Platform Controls)." };
    if (error instanceof AiProviderFailure) return { ok: false, error: `${error.message} Nothing was changed.` };
    console.error("[instagram-studio]", error instanceof Error ? error.message.slice(0, 200) : "error");
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
function parseProvider(p: unknown): GatewayProvider | null {
  if (p === null || p === undefined || p === "" || p === "default") return null;
  if ((GATEWAY_PROVIDERS as readonly string[]).includes(p as string)) return p as GatewayProvider;
  throw new StudioError("Unknown AI provider.");
}
const instr = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 500) : "");

/**
 * AI Engine: every paid AI action needs the one-time cost quote the admin
 * approved in the AI Cost Preview (consumed atomically — a repeat click is refused).
 */
async function engineCtx(actorId: string, quoteId: unknown, feature: AiFeature, context: Record<string, string | number | null>, instagramPostId: string | null) {
  const q = await consumeQuote({ quoteId, actorId, feature, action: feature, context });
  return { quoteId: q.id, modelOverride: q.model, instagramPostId };
}

function touch() {
  revalidatePath("/admin/instagram", "layout");
}

interface EditorInput {
  postId: string;
  expectedRevision: number;
  content: unknown;
  design: unknown;
  provider?: string | null;
  instruction?: string;
  /** One-time AI cost quote id (AI Cost Preview). */
  quoteId?: string;
}

/** The editor's unsaved state becomes the base for the AI change (validated server-side, like Save). */
async function editorBase(input: EditorInput) {
  const postId = checkId(input.postId);
  const current = await getPostDto(postId);
  const content = checkContentInput(input.content, current.content);
  if (!content.ok) throw new StudioError(content.error);
  const design = checkDesignInput(input.design);
  if (!design.ok) throw new StudioError(design.error);
  return { postId, current, content: content.value, design: design.value, expectedRevision: checkRevision(input.expectedRevision) };
}

async function save(base: Awaited<ReturnType<typeof editorBase>>, content: PostContent, design: PostDesign, note: string, actorId: string): Promise<PostDto> {
  const post = await applyChange({ postId: base.postId, expectedRevision: base.expectedRevision, content, design, note, actorId });
  touch();
  return post;
}

// ---- Diagram / Trap / Captions ------------------------------------------------------------

export async function aiDiagramAction(input: EditorInput & { kind?: string }): Promise<Result<{ post: PostDto; summary: string }>> {
  return run(await requireStudio(), async (actorId) => {
    const base = await editorBase(input);
    const kind = (DIAGRAM_KINDS as readonly string[]).includes(input.kind ?? "") ? (input.kind as DiagramKind) : "auto";
    const ectx = await engineCtx(actorId, input.quoteId, "ig_diagram", { postId: base.postId }, base.postId);
    const r = await generateDiagram({ snapshot: base.current.snapshot, content: base.content, kind, instruction: instr(input.instruction) || undefined, gen: gatewayGenerator({ actorId, provider: parseProvider(input.provider), ...ectx }) });
    return { post: await save(base, r.content, base.design, `AI: diagram (${r.content.diagram?.kind})`, actorId), summary: r.summary };
  });
}

export async function aiTrapAction(input: EditorInput): Promise<Result<{ post: PostDto; summary: string }>> {
  return run(await requireStudio(), async (actorId) => {
    const base = await editorBase(input);
    const ectx = await engineCtx(actorId, input.quoteId, "ig_trap", { postId: base.postId }, base.postId);
    const r = await generateTrap({ snapshot: base.current.snapshot, content: base.content, instruction: instr(input.instruction) || undefined, gen: gatewayGenerator({ actorId, provider: parseProvider(input.provider), ...ectx }) });
    return { post: await save(base, r.content, base.design, "AI: examiner trap question", actorId), summary: r.summary };
  });
}

/** AI cost recorded for this post (read-only): text, image, diagram, regenerations, total. */
export async function postAiCostAction(postId: string): Promise<Result<Awaited<ReturnType<typeof postCost>>>> {
  return run(await requireStudio(), async () => postCost(checkId(postId)));
}

// ---- Optional Medical Image slide ---------------------------------------------------------
// Generate / choose only store a preview candidate (a new revision, so it is cached and never
// regenerated on load). Add to Carousel / Remove / Skip are ordinary editor edits + Save.

export async function medicalImageStatusAction(): Promise<Result<{ available: boolean; model: string | null; message: string }>> {
  return run(await requireStudio(), async () => imageGenerationStatus());
}

export async function aiMedicalImageAction(input: EditorInput): Promise<Result<{ post: PostDto; summary: string }>> {
  return run(await requireStudio(), async (actorId) => {
    const base = await editorBase(input);
    const ectx = await engineCtx(actorId, input.quoteId, "ig_image", { postId: base.postId }, base.postId);
    const r = await generateMedicalImage({ snapshot: base.current.snapshot, content: base.content, instruction: instr(input.instruction).slice(0, 300) || undefined, ctx: { actorId, ...ectx } });
    return { post: await save(base, { ...base.content, imageCandidate: r.image }, base.design, `AI: medical image (${r.image.source.model})`, actorId), summary: r.summary };
  });
}

export async function referenceImageSearchAction(input: { query: string }): Promise<Result<ReferenceImageResult[]>> {
  return run(await requireStudio(), async () => searchReferenceImages(typeof input?.query === "string" ? input.query : ""));
}

export async function referenceImageUseAction(input: EditorInput & { fileTitle: string }): Promise<Result<{ post: PostDto; summary: string }>> {
  return run(await requireStudio(), async (actorId) => {
    const base = await editorBase(input);
    const r = await importReferenceImage({ snapshot: base.current.snapshot, content: base.content, fileTitle: typeof input.fileTitle === "string" ? input.fileTitle : "" });
    return { post: await save(base, { ...base.content, imageCandidate: r.image }, base.design, "Reference image (Wikimedia Commons)", actorId), summary: r.summary };
  });
}

export async function aiCaptionsAction(input: EditorInput): Promise<Result<{ post: PostDto; summary: string }>> {
  return run(await requireStudio(), async (actorId) => {
    const base = await editorBase(input);
    const settings = await getStudioSettings();
    const s = base.current.snapshot;
    const ectx = await engineCtx(actorId, input.quoteId, "ig_caption", { postId: base.postId }, base.postId);
    const evidence = await getTrendEvidence({ examId: s.examId, subjectName: s.subjectName, topicName: s.topicName, limit: 12 });
    const r = await generateCaptions({
      snapshot: s,
      content: base.content,
      evidence,
      allowedDomains: allowedCaptionDomains(settings),
      websiteLabel: settings.websiteLabel,
      instruction: instr(input.instruction) || undefined,
      gen: gatewayGenerator({ actorId, provider: parseProvider(input.provider), ...ectx }),
    });
    return { post: await save(base, r.content, base.design, "AI: three caption versions + keywords", actorId), summary: r.summary };
  });
}

// ---- Design presets + exam scope -------------------------------------------------------------

export async function saveDesignPresetAction(input: { name: string; template: string; overrides?: unknown; questionScale?: number; bodyScale?: number }): Promise<Result<DesignPreset>> {
  return run(await requireStudio(), async (actorId) => {
    let preset: DesignPreset;
    try {
      preset = await savePreset({ name: String(input.name ?? ""), template: String(input.template ?? ""), overrides: input.overrides, questionScale: input.questionScale, bodyScale: input.bodyScale });
    } catch (e) {
      throw new StudioError(e instanceof Error ? e.message : "Could not save the preset.");
    }
    await prisma.auditLog.create({ data: { actorId, action: "INSTAGRAM_PRESET_SAVED", entityType: "Setting", entityId: "instagram.designPresets", metadata: { name: preset.name, template: preset.template } } });
    touch();
    return preset;
  });
}

export async function deleteDesignPresetAction(id: string): Promise<Result<null>> {
  return run(await requireStudio(), async (actorId) => {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new StudioError("Invalid preset.");
    await deletePreset(id);
    await prisma.auditLog.create({ data: { actorId, action: "INSTAGRAM_PRESET_DELETED", entityType: "Setting", entityId: "instagram.designPresets", metadata: { id } } });
    touch();
    return null;
  });
}

export async function saveDefaultTemplateAction(template: string): Promise<Result<null>> {
  return run(await requireStudio(), async (actorId) => {
    const t = TEMPLATE_KEYS.find((k) => k === template);
    if (!t) throw new StudioError("Unknown template.");
    const row = await prisma.setting.findUnique({ where: { key: "instagram.studio" } });
    const value = { ...((row?.value as object | undefined) ?? {}), defaultTemplate: t, updatedAt: new Date().toISOString() };
    await prisma.setting.upsert({ where: { key: "instagram.studio" }, update: { value }, create: { key: "instagram.studio", value } });
    await prisma.auditLog.create({ data: { actorId, action: "INSTAGRAM_DEFAULT_DESIGN_SET", entityType: "Setting", entityId: "instagram.studio", metadata: { template: t } } });
    touch();
    return null;
  });
}

export async function saveScopeAction(input: { mode: "auto" | "custom"; examIds: string[] }): Promise<Result<null>> {
  return run(await requirePublisher(), async (actorId) => {
    const ids = Array.isArray(input.examIds) ? input.examIds.filter((x) => typeof x === "string" && ID.test(x)).slice(0, 200) : [];
    await saveScope(input.mode === "custom" ? ids : null);
    await prisma.auditLog.create({ data: { actorId, action: "INSTAGRAM_SCOPE_SAVED", entityType: "Setting", entityId: "instagram.scope", metadata: { mode: input.mode, examIds: ids } } });
    touch();
    return null;
  });
}

// ---- Smart selection + Bulk Studio -------------------------------------------------------------

export async function selectCandidatesAction(f: { examId: string; subjectId?: string; topicId?: string; year?: number; difficulty?: string; mostMissed?: boolean; published?: string; limit?: number }): Promise<Result<{ candidates: Candidate[]; evidenceCount: number; perfPosts: number }>> {
  return run(await requireStudio(), async () =>
    selectCandidates({
      examId: checkId(f.examId),
      subjectId: f.subjectId && ID.test(f.subjectId) ? f.subjectId : undefined,
      topicId: f.topicId && ID.test(f.topicId) ? f.topicId : undefined,
      year: Number.isInteger(f.year) ? f.year : undefined,
      difficulty: f.difficulty === "EASY" || f.difficulty === "MEDIUM" || f.difficulty === "HARD" ? f.difficulty : undefined,
      mostMissed: f.mostMissed === true,
      published: f.published === "published" || f.published === "any" ? f.published : "unpublished",
      limit: Math.min(100, Math.max(5, Number(f.limit) || 50)),
    })
  );
}

export async function createBatchAction(input: { name: string; examId: string; questionIds: string[]; template: string; perQuestion?: Record<string, string> }): Promise<Result<{ batchId: string; results: { questionId: string; postId: string | null; error?: string; existed?: boolean }[] }>> {
  return run(await requireStudio(), async (actorId) => {
    const ids = (Array.isArray(input.questionIds) ? input.questionIds : []).filter((x) => typeof x === "string" && ID.test(x));
    const template = input.template === "default" ? "default" : (TEMPLATE_KEYS.find((t) => t === input.template) ?? "default");
    const perQuestion: Record<string, TemplateKey> = {};
    for (const [q, t] of Object.entries(input.perQuestion ?? {})) {
      const k = TEMPLATE_KEYS.find((x) => x === t);
      if (k && ID.test(q)) perQuestion[q] = k;
    }
    const r = await createBatch({ name: String(input.name ?? ""), examId: ID.test(input.examId) ? input.examId : null, questionIds: ids, template, perQuestion, actorId });
    touch();
    return r;
  });
}

export async function loadBatchAction(batchId: string): Promise<Result<BatchView>> {
  return run(await requireStudio(), async () => getBatchView(checkId(batchId)));
}

export async function applyDesignToBatchAction(input: { batchId: string; target: string; postIds?: string[] }): Promise<Result<{ changed: number; skipped: string[]; view: BatchView }>> {
  return run(await requireStudio(), async (actorId) => {
    const target = ["handwritten", "professional", "default"].includes(input.target) ? (input.target as "handwritten" | "professional" | "default") : TEMPLATE_KEYS.find((t) => t === input.target);
    if (!target) throw new StudioError("Unknown design.");
    const postIds = Array.isArray(input.postIds) ? input.postIds.filter((x) => typeof x === "string" && ID.test(x)) : undefined;
    const r = await applyDesignToBatch({ batchId: checkId(input.batchId), target, postIds, actorId });
    touch();
    return { ...r, view: await getBatchView(input.batchId) };
  });
}

/** Final review screen of Bulk Studio: re-checks each selected post (read-only). */
export async function bulkPreflightAction(input: { batchId: string; postIds: string[] }): Promise<Result<BulkPreflightItem[]>> {
  return run(await requirePublisher(), async () => {
    const postIds = (Array.isArray(input.postIds) ? input.postIds : []).filter((x) => typeof x === "string" && ID.test(x)).slice(0, 50);
    return bulkPreflight({ batchId: checkId(input.batchId), postIds });
  });
}

/** "Confirm & Publish Selected" — one confirmation for exactly the posts/revisions on the review screen. */
export async function confirmQueueAction(input: { batchId: string; items: { postId: string; revision: number; acknowledged: string[] }[]; confirmed: boolean }): Promise<Result<BatchView>> {
  return run(await requirePublisher(), async (actorId) => {
    if (input.confirmed !== true) throw new StudioError("Publishing needs an explicit confirmation.");
    const items = (Array.isArray(input.items) ? input.items : [])
      .filter((i) => i && typeof i.postId === "string" && ID.test(i.postId))
      .slice(0, 50)
      .map((i) => ({
        postId: i.postId,
        revision: checkRevision(i.revision),
        acknowledged: Array.isArray(i.acknowledged) ? i.acknowledged.filter((x): x is string => typeof x === "string" && x.length <= 120).slice(0, 60) : [],
      }));
    const v = await confirmQueue({ batchId: checkId(input.batchId), items, actorId });
    touch();
    return v;
  });
}

export async function queueControlAction(input: { batchId: string; action: string }): Promise<Result<BatchView>> {
  return run(await requirePublisher(), async (actorId) => {
    if (!["pause", "resume", "stop"].includes(input.action)) throw new StudioError("Invalid action.");
    const v = await setQueueStatus({ batchId: checkId(input.batchId), action: input.action as "pause" | "resume" | "stop", actorId });
    touch();
    return v;
  });
}

/** One step of the attended queue — called by the open queue page while it is RUNNING. */
export async function advanceQueueAction(batchId: string): Promise<Result<BatchView>> {
  return run(await requirePublisher(), async (actorId) => {
    const { view, started } = await advanceQueue({ batchId: checkId(batchId), actorId });
    if (started) {
      after(async () => {
        await runPublishJob(started.postId, started.job.leaseId);
        revalidatePath("/admin/instagram", "layout");
      });
    }
    return view;
  });
}

export async function retryQueueItemAction(input: { batchId: string; itemId: string }): Promise<Result<BatchView>> {
  return run(await requirePublisher(), async (actorId) => retryItem({ batchId: checkId(input.batchId), itemId: checkId(input.itemId), actorId }));
}

export async function checkQueueItemAction(input: { batchId: string; itemId: string }): Promise<Result<BatchView>> {
  return run(await requirePublisher(), async (actorId) => {
    const v = await checkItemStatus({ batchId: checkId(input.batchId), itemId: checkId(input.itemId), actorId });
    touch();
    return v;
  });
}

// ---- Metrics ------------------------------------------------------------------------------------

export async function refreshMetricsAction(postId: string): Promise<Result<null>> {
  return run(await requireStudio(), async (actorId) => {
    await refreshPostMetrics(checkId(postId));
    await prisma.auditLog.create({ data: { actorId, action: "INSTAGRAM_METRICS_REFRESHED", entityType: "InstagramPost", entityId: postId, metadata: {} } });
    touch();
    return null;
  });
}

export async function refreshAllMetricsAction(): Promise<Result<{ refreshed: number; skipped: number; errors: string[] }>> {
  return run(await requireStudio(), async (actorId) => {
    const posts = await prisma.instagramPost.findMany({ where: { status: "PUBLISHED", igMediaId: { not: null } }, select: { id: true, questionCode: true }, orderBy: { publishedAt: "desc" }, take: 50 });
    let refreshed = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const p of posts) {
      try {
        await refreshPostMetrics(p.id);
        refreshed++;
      } catch (e) {
        if (e instanceof StudioError && /10 minutes/.test(e.message)) skipped++;
        else errors.push(`${p.questionCode}: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
      }
    }
    await prisma.auditLog.create({ data: { actorId, action: "INSTAGRAM_METRICS_REFRESHED", entityType: "InstagramPost", entityId: "all", metadata: { refreshed, skipped, errors: errors.length } } });
    touch();
    return { refreshed, skipped, errors: errors.slice(0, 10) };
  });
}

// ---- Trends & Competitors --------------------------------------------------------------------------

const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

export async function addReferenceAction(input: Record<string, unknown>): Promise<Result<null>> {
  return run(await requireStudio(), async (actorId) => {
    const kind = input.kind === "HANDLE" ? "HANDLE" : "POST";
    const handle = String(input.handle ?? "").trim().replace(/^@/, "");
    if (!HANDLE.test(handle)) throw new StudioError("Handle: letters, numbers, dots and underscores (max 30).");
    const s = (k: string, max: number) => {
      const v = typeof input[k] === "string" ? (input[k] as string).trim() : "";
      if (v.length > max) throw new StudioError(`${k} is too long (max ${max}).`);
      return v || null;
    };
    const n = (k: string) => {
      const v = input[k];
      if (v === "" || v === null || v === undefined) return null;
      const x = Number(v);
      if (!Number.isInteger(x) || x < 0 || x > 1_000_000_000) throw new StudioError(`${k} must be a whole number.`);
      return x;
    };
    const url = s("url", 300);
    if (url && !/^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9._/?=&-]+$/.test(url)) throw new StudioError("URL must be an https://www.instagram.com/… link.");
    const topic = s("topic", 120);
    if (topic && EXCLUDED_TERMS.test(topic)) throw new StudioError("NEET UG / school-level topics are out of scope for Instagram Studio.");
    const observed = s("observedAt", 30);
    const observedAt = observed ? new Date(observed) : null;
    if (observedAt && (Number.isNaN(observedAt.getTime()) || observedAt.getTime() > Date.now() + 86_400_000)) throw new StudioError("Observed date is invalid.");
    const list = (k: string, max: number) =>
      (typeof input[k] === "string" ? (input[k] as string).split(",") : Array.isArray(input[k]) ? (input[k] as unknown[]).map(String) : [])
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, max)
        .map((x) => x.slice(0, 40));
    await prisma.instagramReference.create({
      data: {
        kind,
        handle,
        examTags: list("examTags", 6),
        url,
        topic,
        subject: s("subject", 80),
        format: s("format", 40),
        captionStyle: s("captionStyle", 80),
        keywords: list("keywords", 12).filter((k) => !EXCLUDED_TERMS.test(k)),
        likes: n("likes"),
        comments: n("comments"),
        views: n("views"),
        observedAt,
        notes: s("notes", 500),
        source: "MANUAL",
        createdById: actorId,
      },
    });
    await prisma.auditLog.create({ data: { actorId, action: "INSTAGRAM_REFERENCE_ADDED", entityType: "InstagramReference", entityId: handle, metadata: { kind } } });
    touch();
    return null;
  });
}

export async function setReferenceActiveAction(id: string, active: boolean): Promise<Result<null>> {
  return run(await requireStudio(), async (actorId) => {
    await prisma.instagramReference.update({ where: { id: checkId(id) }, data: { active: active === true } });
    await prisma.auditLog.create({ data: { actorId, action: active ? "INSTAGRAM_REFERENCE_ENABLED" : "INSTAGRAM_REFERENCE_DISABLED", entityType: "InstagramReference", entityId: id, metadata: {} } });
    touch();
    return null;
  });
}

export async function deleteReferenceAction(id: string): Promise<Result<null>> {
  return run(await requireStudio(), async (actorId) => {
    await prisma.instagramReference.delete({ where: { id: checkId(id) } });
    await prisma.auditLog.create({ data: { actorId, action: "INSTAGRAM_REFERENCE_DELETED", entityType: "InstagramReference", entityId: id, metadata: {} } });
    touch();
    return null;
  });
}

export async function runTrendAnalysisAction(input: { examId?: string | null; provider?: string | null; quoteId?: string }): Promise<Result<{ id: string }>> {
  return run(await requireStudio(), async (actorId) => {
    const examId = input.examId && ID.test(input.examId) ? input.examId : null;
    const exam = examId ? await prisma.exam.findUnique({ where: { id: examId }, select: { name: true } }) : null;
    const ectx = await engineCtx(actorId, input.quoteId, "ig_trends", { examId }, null);
    const r = await runTrendAnalysis({ actorId, examId, examName: exam?.name ?? null, provider: parseProvider(input.provider), quoteId: ectx.quoteId, modelOverride: ectx.modelOverride });
    touch();
    return { id: r.id };
  });
}

export async function runCompetitorAnalysisAction(input: { provider?: string | null; quoteId?: string }): Promise<Result<{ id: string }>> {
  return run(await requireStudio(), async (actorId) => {
    const ectx = await engineCtx(actorId, input.quoteId, "ig_competitors", {}, null);
    const r = await runCompetitorAnalysis({ actorId, provider: parseProvider(input.provider), quoteId: ectx.quoteId, modelOverride: ectx.modelOverride });
    touch();
    return { id: r.id };
  });
}

export async function listDesignPresetsAction(): Promise<Result<{ presets: DesignPreset[]; defaultTemplate: TemplateKey }>> {
  return run(await requireStudio(), async () => {
    const [{ listPresets }, settings] = await Promise.all([import("@/lib/instagram/presets"), getStudioSettings()]);
    return { presets: await listPresets(), defaultTemplate: settings.defaultTemplate };
  });
}
