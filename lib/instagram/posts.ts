import "server-only";
import { Prisma, type InstagramPost, type InstagramPostSeries } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { allowedCaptionDomains, getStudioSettings, type StudioSettings } from "@/lib/instagram/config";
import { blockingIssues, runQualityGate, warningCodes, REVIEW_CHECKLIST, type QualityIssue } from "@/lib/instagram/quality";
import { unsupportedChars } from "@/lib/instagram/glyphs";
import { buildSnapshot, currentSourceHash } from "@/lib/instagram/snapshot";
import {
  defaultDesign,
  emptyContent,
  normalizeContent,
  normalizeDesign,
  type PostContent,
  type PostDesign,
  type PostStatusLabel,
  type SeriesStats,
  type SourceSnapshot,
} from "@/lib/instagram/types";

/**
 * Instagram post lifecycle (drafts, revisions, review). Every write goes to
 * InstagramPost / InstagramPostRevision / AuditLog only — never to the
 * Question Bank. Concurrency: each change names the revision it was based on
 * and is applied with a conditional update, so two tabs or two admins can
 * never silently overwrite each other; duplicate drafts for one question are
 * impossible because of the partial unique index on current posts.
 */

export class StudioError extends Error {
  constructor(
    message: string,
    readonly kind: "conflict" | "needs-confirm" | "invalid" | "not-found" | "blocked" = "invalid"
  ) {
    super(message);
  }
}

export interface RevisionSummary {
  revision: number;
  baseRevision: number | null;
  note: string;
  createdAt: string;
  createdBy: string;
}

export interface PostDto {
  id: string;
  questionId: string;
  questionCode: string;
  series: InstagramPostSeries;
  version: number;
  status: InstagramPost["status"];
  revision: number;
  content: PostContent;
  design: PostDesign;
  snapshot: SourceSnapshot;
  seriesStats: SeriesStats | null;
  questionNumber: number | null;
  questionNumberVerified: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
  acknowledged: string[];
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  igPermalink: string | null;
  isCurrent: boolean;
  sourceChanged: boolean;
  sourceDeleted: boolean;
  issues: QualityIssue[];
  canUndo: boolean;
  revisions: RevisionSummary[];
}

export interface HistoryEntry {
  id: string;
  version: number;
  status: InstagramPost["status"];
  series: InstagramPostSeries;
  createdAt: string;
  publishedAt: string | null;
  igPermalink: string | null;
  supersededAt: string | null;
}

export interface QuestionPostState {
  questionId: string;
  current: PostDto | null;
  history: HistoryEntry[];
  posted: boolean;
}

async function adminNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map();
  const rows = await prisma.adminUser.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

function followOf(s: StudioSettings) {
  return { instagramHandle: s.instagramHandle, showInstagram: s.showInstagram, telegramUrl: s.telegramUrl, showTelegram: s.showTelegram };
}

export function issuesFor(post: Pick<InstagramPost, "sourceSnapshot" | "content" | "design" | "series" | "seriesStats" | "questionNumber" | "questionNumberVerified" | "sourceHash">, currentHash: string | null, settings: StudioSettings): QualityIssue[] {
  return runQualityGate({
    snapshot: post.sourceSnapshot as unknown as SourceSnapshot,
    content: normalizeContent(post.content),
    design: normalizeDesign(post.design),
    series: post.series,
    seriesStats: (post.seriesStats as SeriesStats | null) ?? null,
    questionNumber: post.questionNumber,
    questionNumberVerified: post.questionNumberVerified,
    currentHash,
    snapshotHash: post.sourceHash,
    follow: followOf(settings),
    allowedDomains: allowedCaptionDomains(settings),
    unsupportedChars,
    settingsTexts: [settings.ctaHeadline, settings.ctaDescription, settings.footerText, settings.telegramName, settings.examBadges[(post.sourceSnapshot as unknown as SourceSnapshot).examId] ?? ""],
  });
}

export async function toDto(post: InstagramPost, settings?: StudioSettings): Promise<PostDto> {
  const [revisions, currentHash, s] = await Promise.all([
    prisma.instagramPostRevision.findMany({ where: { postId: post.id }, orderBy: { revision: "desc" }, take: 40 }),
    currentSourceHash(post.questionId),
    settings ? Promise.resolve(settings) : getStudioSettings(),
  ]);
  const names = await adminNames([...revisions.map((r) => r.createdById), post.reviewedById]);
  const head = revisions.find((r) => r.revision === post.revision);
  const review = (post.review ?? {}) as { acknowledged?: string[] };
  return {
    id: post.id,
    questionId: post.questionId,
    questionCode: post.questionCode,
    series: post.series,
    version: post.version,
    status: post.status,
    revision: post.revision,
    content: normalizeContent(post.content),
    design: normalizeDesign(post.design),
    snapshot: post.sourceSnapshot as unknown as SourceSnapshot,
    seriesStats: (post.seriesStats as SeriesStats | null) ?? null,
    questionNumber: post.questionNumber,
    questionNumberVerified: post.questionNumberVerified,
    reviewedAt: post.reviewedAt?.toISOString() ?? null,
    reviewedBy: post.reviewedById ? (names.get(post.reviewedById) ?? "Admin") : null,
    acknowledged: review.acknowledged ?? [],
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
    publishedAt: post.publishedAt?.toISOString() ?? null,
    igPermalink: post.igPermalink,
    isCurrent: post.supersededAt === null,
    sourceChanged: currentHash !== null && currentHash !== post.sourceHash,
    sourceDeleted: currentHash === null,
    issues: issuesFor(post, currentHash, s),
    canUndo: head?.baseRevision != null,
    revisions: revisions.map((r) => ({
      revision: r.revision,
      baseRevision: r.baseRevision,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      createdBy: names.get(r.createdById) ?? "Admin",
    })),
  };
}

export async function getQuestionPostState(questionId: string): Promise<QuestionPostState> {
  const posts = await prisma.instagramPost.findMany({ where: { questionId }, orderBy: { version: "desc" } });
  const current = posts.find((p) => p.supersededAt === null) ?? null;
  return {
    questionId,
    current: current ? await toDto(current) : null,
    history: posts.map((p) => ({
      id: p.id,
      version: p.version,
      status: p.status,
      series: p.series,
      createdAt: p.createdAt.toISOString(),
      publishedAt: p.publishedAt?.toISOString() ?? null,
      igPermalink: p.igPermalink,
      supersededAt: p.supersededAt?.toISOString() ?? null,
    })),
    posted: posts.some((p) => p.status === "PUBLISHED"),
  };
}

export async function getPostDto(postId: string): Promise<PostDto> {
  const post = await prisma.instagramPost.findUnique({ where: { id: postId } });
  if (!post) throw new StudioError("This post no longer exists.", "not-found");
  return toDto(post);
}

export interface QuestionStatusInfo {
  status: PostStatusLabel;
  postId: string | null;
  posted: boolean;
  publishedAt: string | null;
}

/** One status per question for list views (current post's status; "posted" if any version was published). */
export async function statusesFor(questionIds: string[]): Promise<Map<string, QuestionStatusInfo>> {
  const map = new Map<string, QuestionStatusInfo>();
  if (!questionIds.length) return map;
  const posts = await prisma.instagramPost.findMany({
    where: { questionId: { in: questionIds } },
    select: { id: true, questionId: true, status: true, supersededAt: true, publishedAt: true },
  });
  for (const qid of questionIds) map.set(qid, { status: "NOT_CREATED", postId: null, posted: false, publishedAt: null });
  for (const p of posts) {
    const cur = map.get(p.questionId)!;
    if (p.status === "PUBLISHED") {
      cur.posted = true;
      if (!cur.publishedAt || (p.publishedAt && p.publishedAt.toISOString() > cur.publishedAt)) cur.publishedAt = p.publishedAt?.toISOString() ?? null;
    }
    if (p.supersededAt === null) {
      cur.status = p.status;
      cur.postId = p.id;
    }
  }
  return map;
}

async function audit(actorId: string, action: string, entityId: string, metadata: Record<string, unknown>) {
  await prisma.auditLog.create({ data: { actorId, action, entityType: "InstagramPost", entityId, metadata: metadata as Prisma.InputJsonValue } });
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

export async function createDraft(params: { questionId: string; series: InstagramPostSeries; stats: SeriesStats | null; actorId: string }): Promise<{ post: PostDto; existed: boolean }> {
  const existing = await prisma.instagramPost.findFirst({ where: { questionId: params.questionId, supersededAt: null } });
  if (existing) return { post: await toDto(existing), existed: true };

  const built = await buildSnapshot(params.questionId);
  if (!built) throw new StudioError("This question no longer exists.", "not-found");
  if (params.series === "PYQ" && !built.snapshot.paperId) throw new StudioError("This question is not linked to a previous year paper.");
  if (params.series === "MOST_MISSED" && !params.stats) throw new StudioError("Most Missed numbers are required.");

  const settings = await getStudioSettings();
  const design = defaultDesign(settings.defaultTemplate, settings.defaultSlideCount);
  const content: PostContent = { ...emptyContent(), hashtags: settings.defaultHashtags };
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Serialize creates for this question (double click, two admins): the loser sees the winner's row.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`instagram-post:${params.questionId}`}))`;
      const winner = await tx.instagramPost.findFirst({ where: { questionId: params.questionId, supersededAt: null } });
      if (winner) return { post: winner, existed: true };
      const max = await tx.instagramPost.aggregate({ where: { questionId: params.questionId }, _max: { version: true } });
      const created = await tx.instagramPost.create({
        data: {
          questionId: params.questionId,
          questionCode: built.snapshot.code,
          series: params.series,
          version: (max._max.version ?? 0) + 1,
          content: json(content),
          design: json(design),
          sourceSnapshot: json(built.snapshot),
          sourceHash: built.hash,
          seriesStats: params.stats ? json(params.stats) : Prisma.DbNull,
          createdById: params.actorId,
        },
      });
      await tx.instagramPostRevision.create({
        data: { postId: created.id, revision: 1, baseRevision: null, content: json(content), design: json(design), note: "Draft created", createdById: params.actorId },
      });
      return { post: created, existed: false };
    });
    if (!result.existed) await audit(params.actorId, "INSTAGRAM_DRAFT_CREATED", result.post.id, { questionId: params.questionId, series: params.series });
    return { post: await toDto(result.post, settings), existed: result.existed };
  } catch (e) {
    // Backstop: the partial unique index still refuses a second current post.
    if (!isUniqueViolation(e)) throw e;
    const winner = await prisma.instagramPost.findFirst({ where: { questionId: params.questionId, supersededAt: null } });
    if (!winner) throw e;
    return { post: await toDto(winner, settings), existed: true };
  }
}

/** "Create New Version" of a published question: the published row is kept (superseded), a fresh DRAFT starts from its content. */
export async function createNewVersion(postId: string, actorId: string): Promise<PostDto> {
  const old = await prisma.instagramPost.findUnique({ where: { id: postId } });
  if (!old) throw new StudioError("This post no longer exists.", "not-found");
  if (old.supersededAt) throw new StudioError("A newer version already exists for this question.", "conflict");
  if (old.status !== "PUBLISHED") throw new StudioError("Only a published post gets a new version — keep editing the current draft instead.");
  const built = await buildSnapshot(old.questionId);
  if (!built) throw new StudioError("This question no longer exists.", "not-found");
  const max = await prisma.instagramPost.aggregate({ where: { questionId: old.questionId }, _max: { version: true } });
  try {
    const post = await prisma.$transaction(async (tx) => {
      const res = await tx.instagramPost.updateMany({ where: { id: old.id, supersededAt: null }, data: { supersededAt: new Date() } });
      if (res.count !== 1) throw new StudioError("Someone else already created a new version.", "conflict");
      const content = normalizeContent(old.content);
      const design = normalizeDesign(old.design);
      const created = await tx.instagramPost.create({
        data: {
          questionId: old.questionId,
          questionCode: built.snapshot.code,
          series: old.series,
          version: (max._max.version ?? old.version) + 1,
          content: json({ ...content, aiFlags: [] }),
          design: json(design),
          sourceSnapshot: json(built.snapshot),
          sourceHash: built.hash,
          seriesStats: old.seriesStats === null ? Prisma.DbNull : json(old.seriesStats),
          questionNumber: old.questionNumber,
          questionNumberVerified: old.questionNumberVerified,
          createdById: actorId,
        },
      });
      await tx.instagramPostRevision.create({
        data: { postId: created.id, revision: 1, baseRevision: null, content: json({ ...content, aiFlags: [] }), design: json(design), note: `New version (from published v${old.version})`, createdById: actorId },
      });
      return created;
    });
    await audit(actorId, "INSTAGRAM_NEW_VERSION", post.id, { questionId: old.questionId, fromPostId: old.id, version: post.version });
    return toDto(post);
  } catch (e) {
    if (isUniqueViolation(e)) throw new StudioError("Someone else already created a new version.", "conflict");
    throw e;
  }
}

async function loadEditable(postId: string, expectedRevision: number, confirmReplaceApproved: boolean) {
  const post = await prisma.instagramPost.findUnique({ where: { id: postId } });
  if (!post) throw new StudioError("This post no longer exists.", "not-found");
  if (post.supersededAt) throw new StudioError("This is an older version and can't be edited.");
  if (post.status === "PUBLISHED" || post.status === "PUBLISHING") throw new StudioError("A published post can't be edited. Use Create New Version.");
  if (post.revision !== expectedRevision) throw new StudioError("This draft was changed in another window. Reload it to see the latest version.", "conflict");
  if (post.status === "READY" && !confirmReplaceApproved) {
    throw new StudioError("This post is approved (Ready). Changing it sends it back to Draft and needs a new review.", "needs-confirm");
  }
  return post;
}

/** Writes a new revision (content and/or design) on top of `expectedRevision`. A Ready post goes back to Draft. */
async function writeRevision(
  post: InstagramPost,
  next: { content: PostContent; design: PostDesign },
  note: string,
  actorId: string,
  baseRevision: number | null,
  extra: Prisma.InstagramPostUpdateManyMutationInput = {}
): Promise<InstagramPost> {
  const revision = post.revision + 1;
  const backToDraft = post.status === "READY";
  await prisma.$transaction(async (tx) => {
    const res = await tx.instagramPost.updateMany({
      where: { id: post.id, revision: post.revision, supersededAt: null, status: { in: ["DRAFT", "READY", "FAILED"] } },
      data: {
        content: json(next.content),
        design: json(next.design),
        revision,
        updatedById: actorId,
        ...(backToDraft ? { status: "DRAFT", reviewedAt: null, reviewedById: null, review: Prisma.DbNull } : {}),
        ...extra,
      },
    });
    if (res.count !== 1) throw new StudioError("This draft was changed in another window. Reload it to see the latest version.", "conflict");
    await tx.instagramPostRevision.create({
      data: { postId: post.id, revision, baseRevision, content: json(next.content), design: json(next.design), note, createdById: actorId },
    });
  });
  if (backToDraft) await audit(actorId, "INSTAGRAM_READY_REVOKED", post.id, { reason: note });
  return (await prisma.instagramPost.findUnique({ where: { id: post.id } }))!;
}

export async function applyChange(params: {
  postId: string;
  expectedRevision: number;
  content?: PostContent;
  design?: PostDesign;
  note: string;
  actorId: string;
  confirmReplaceApproved?: boolean;
}): Promise<PostDto> {
  const post = await loadEditable(params.postId, params.expectedRevision, params.confirmReplaceApproved ?? false);
  const next = {
    content: params.content ?? normalizeContent(post.content),
    design: params.design ?? normalizeDesign(post.design),
  };
  const updated = await writeRevision(post, next, params.note.slice(0, 200), params.actorId, post.revision);
  return toDto(updated);
}

export async function undoLast(postId: string, expectedRevision: number, actorId: string, confirmReplaceApproved = false): Promise<PostDto> {
  const post = await loadEditable(postId, expectedRevision, confirmReplaceApproved);
  const head = await prisma.instagramPostRevision.findUnique({ where: { postId_revision: { postId, revision: post.revision } } });
  if (head?.baseRevision == null) throw new StudioError("Nothing to undo.");
  const target = await prisma.instagramPostRevision.findUnique({ where: { postId_revision: { postId, revision: head.baseRevision } } });
  if (!target) throw new StudioError("The previous version is missing.");
  const updated = await writeRevision(
    post,
    { content: normalizeContent(target.content), design: normalizeDesign(target.design) },
    `Undo: back to revision ${target.revision}`,
    actorId,
    target.baseRevision
  );
  return toDto(updated);
}

export async function restoreRevision(postId: string, expectedRevision: number, targetRevision: number, actorId: string, confirmReplaceApproved = false): Promise<PostDto> {
  const post = await loadEditable(postId, expectedRevision, confirmReplaceApproved);
  const target = await prisma.instagramPostRevision.findUnique({ where: { postId_revision: { postId, revision: targetRevision } } });
  if (!target) throw new StudioError("That revision doesn't exist.");
  const updated = await writeRevision(
    post,
    { content: normalizeContent(target.content), design: normalizeDesign(target.design) },
    `Restored revision ${target.revision}`,
    actorId,
    post.revision
  );
  return toDto(updated);
}

/** Printed question number (admin-entered). Bumps the revision so slide previews refresh. */
export async function setQuestionNumber(postId: string, expectedRevision: number, questionNumber: number | null, verified: boolean, actorId: string, confirmReplaceApproved = false): Promise<PostDto> {
  if (questionNumber !== null && (!Number.isInteger(questionNumber) || questionNumber < 1 || questionNumber > 500)) {
    throw new StudioError("Question number must be a whole number between 1 and 500.");
  }
  const post = await loadEditable(postId, expectedRevision, confirmReplaceApproved);
  const updated = await writeRevision(
    post,
    { content: normalizeContent(post.content), design: normalizeDesign(post.design) },
    questionNumber ? `Question number set to ${questionNumber}${verified ? " (verified)" : " (unverified)"}` : "Question number cleared",
    actorId,
    post.revision,
    { questionNumber, questionNumberVerified: questionNumber ? verified : false }
  );
  return toDto(updated);
}

export async function refreshSnapshot(postId: string, expectedRevision: number, actorId: string): Promise<PostDto> {
  const post = await loadEditable(postId, expectedRevision, true);
  const built = await buildSnapshot(post.questionId);
  if (!built) throw new StudioError("This question no longer exists in the Question Bank.", "not-found");
  const updated = await writeRevision(
    post,
    { content: normalizeContent(post.content), design: normalizeDesign(post.design) },
    "Question snapshot refreshed from the Question Bank",
    actorId,
    post.revision,
    { sourceSnapshot: json(built.snapshot), sourceHash: built.hash, questionCode: built.snapshot.code, status: "DRAFT", reviewedAt: null, reviewedById: null, review: Prisma.DbNull }
  );
  await audit(actorId, "INSTAGRAM_SNAPSHOT_REFRESHED", post.id, { questionId: post.questionId });
  return toDto(updated);
}

export interface MarkReadyInput {
  postId: string;
  expectedRevision: number;
  checklist: Record<string, boolean>;
  acknowledged: string[];
  actorId: string;
}

export async function markReady(input: MarkReadyInput): Promise<{ post: PostDto; blocked: QualityIssue[]; missingAcks: string[]; missingChecklist: string[] }> {
  const post = await prisma.instagramPost.findUnique({ where: { id: input.postId } });
  if (!post) throw new StudioError("This post no longer exists.", "not-found");
  if (post.supersededAt) throw new StudioError("This is an older version.");
  if (post.status !== "DRAFT" && post.status !== "FAILED") throw new StudioError(post.status === "READY" ? "Already Ready." : "This post can't be approved in its current state.");
  if (post.revision !== input.expectedRevision) throw new StudioError("This draft was changed in another window. Reload it first.", "conflict");

  const settings = await getStudioSettings();
  const issues = issuesFor(post, await currentSourceHash(post.questionId), settings);
  const blocked = blockingIssues(issues);
  const missingAcks = warningCodes(issues).filter((c) => !input.acknowledged.includes(c));
  const missingChecklist = REVIEW_CHECKLIST.filter((c) => input.checklist[c.key] !== true).map((c) => c.key);
  if (blocked.length || missingAcks.length || missingChecklist.length) {
    return { post: await toDto(post, settings), blocked, missingAcks, missingChecklist };
  }
  const res = await prisma.instagramPost.updateMany({
    where: { id: post.id, revision: post.revision, status: post.status, supersededAt: null },
    data: {
      status: "READY",
      reviewedAt: new Date(),
      reviewedById: input.actorId,
      review: json({ checklist: input.checklist, acknowledged: warningCodes(issues), revision: post.revision, at: new Date().toISOString() }),
      updatedById: input.actorId,
    },
  });
  if (res.count !== 1) throw new StudioError("This draft was changed in another window. Reload it first.", "conflict");
  await audit(input.actorId, "INSTAGRAM_MARKED_READY", post.id, { revision: post.revision, acknowledged: warningCodes(issues) });
  return { post: await getPostDto(post.id), blocked: [], missingAcks: [], missingChecklist: [] };
}

export async function backToDraft(postId: string, actorId: string): Promise<PostDto> {
  const res = await prisma.instagramPost.updateMany({
    where: { id: postId, status: "READY", supersededAt: null },
    data: { status: "DRAFT", reviewedAt: null, reviewedById: null, review: Prisma.DbNull, updatedById: actorId },
  });
  if (res.count !== 1) throw new StudioError("Only a Ready post can go back to Draft.");
  await audit(actorId, "INSTAGRAM_READY_REVOKED", postId, { reason: "Back to Draft" });
  return getPostDto(postId);
}

/** Deletes an unpublished current draft. If it was a new version, the previous published version becomes current again. */
export async function deleteDraft(postId: string, actorId: string): Promise<void> {
  const post = await prisma.instagramPost.findUnique({ where: { id: postId } });
  if (!post) return;
  if (post.status !== "DRAFT" && post.status !== "READY") throw new StudioError("Only Draft or Ready posts can be deleted.");
  if (post.supersededAt) throw new StudioError("Older versions are kept as history.");
  await prisma.$transaction(async (tx) => {
    await tx.instagramPost.delete({ where: { id: post.id } });
    const prev = await tx.instagramPost.findFirst({ where: { questionId: post.questionId }, orderBy: { version: "desc" } });
    if (prev) await tx.instagramPost.update({ where: { id: prev.id }, data: { supersededAt: null } });
  });
  await audit(actorId, "INSTAGRAM_DRAFT_DELETED", postId, { questionId: post.questionId, version: post.version });
}
