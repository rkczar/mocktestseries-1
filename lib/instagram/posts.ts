import "server-only";
import { Prisma, type InstagramPost, type InstagramPostSeries } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isExamInScope } from "@/lib/instagram/scope";
import { allowedCaptionDomains, getStudioSettings, type StudioSettings } from "@/lib/instagram/config";
import { runQualityGate, type QualityIssue } from "@/lib/instagram/quality";
import { normalizeForSlides, unsupportedChars } from "@/lib/instagram/glyphs";
import { adviseIssue, type IssueAdvice } from "@/lib/instagram/fixes";
import { buildSnapshot, currentSourceHash } from "@/lib/instagram/snapshot";
import { buildTopicSnapshot, validateTopicInput, type TopicInput } from "@/lib/instagram/topic";
import { publishView, type PublishView } from "@/lib/instagram/publish-view";
import {
  defaultDesign,
  emptyContent,
  TOPIC_DEFAULT_MODULES,
  normalizeContent,
  normalizeDesign,
  studioStatus,
  type PostContent,
  type PostDesign,
  type PostStatusLabel,
  type SeriesStats,
  type SourceSnapshot,
  type StudioPostStatus,
} from "@/lib/instagram/types";

/**
 * Instagram post lifecycle (drafts, revisions). Every write goes to
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
  /** null for TOPIC posts. */
  questionId: string | null;
  /** TOPIC posts only. */
  topicKey: string | null;
  questionCode: string;
  series: InstagramPostSeries;
  version: number;
  /** Legacy READY rows are reported as DRAFT (see studioStatus). */
  status: StudioPostStatus;
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
  igMediaId: string | null;
  publish: PublishView;
  isCurrent: boolean;
  sourceChanged: boolean;
  sourceDeleted: boolean;
  issues: QualityIssue[];
  /** One entry per issue: category (auto / admin / medical) and the next action (lib/instagram/fixes.ts). */
  advice: IssueAdvice[];
  canUndo: boolean;
  revisions: RevisionSummary[];
}

export interface HistoryEntry {
  id: string;
  version: number;
  status: StudioPostStatus;
  series: InstagramPostSeries;
  createdAt: string;
  publishedAt: string | null;
  igPermalink: string | null;
  supersededAt: string | null;
}

export interface QuestionPostState {
  /** null when the state is a topic's (getTopicPostState). */
  questionId: string | null;
  topicKey?: string;
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

/**
 * Hash of the post's source as it is NOW (null = the source question was deleted). A TOPIC post's source
 * is its own frozen topic snapshot, so it can never change or disappear.
 */
export function sourceHashNow(post: Pick<InstagramPost, "questionId" | "sourceHash">): Promise<string | null> {
  return post.questionId === null ? Promise.resolve(post.sourceHash) : currentSourceHash(post.questionId);
}

/** Where "fix it in the Question Bank" advice points (topic posts have no question). */
export function questionEditHref(questionId: string | null): string {
  return questionId ? `/admin/questions?tab=add&id=${questionId}` : "";
}

export async function toDto(post: InstagramPost, settings?: StudioSettings): Promise<PostDto> {
  const [revisions, currentHash, s] = await Promise.all([
    prisma.instagramPostRevision.findMany({ where: { postId: post.id }, orderBy: { revision: "desc" }, take: 40 }),
    sourceHashNow(post),
    settings ? Promise.resolve(settings) : getStudioSettings(),
  ]);
  const issues = issuesFor(post, currentHash, s);
  const fixCtx = {
    snapshot: post.sourceSnapshot as unknown as SourceSnapshot,
    content: normalizeContent(post.content),
    design: normalizeDesign(post.design),
    series: post.series,
    normalize: normalizeForSlides,
    questionEditHref: questionEditHref(post.questionId),
  };
  const names = await adminNames([...revisions.map((r) => r.createdById), post.reviewedById]);
  const head = revisions.find((r) => r.revision === post.revision);
  const review = (post.review ?? {}) as { acknowledged?: string[] };
  return {
    id: post.id,
    questionId: post.questionId,
    topicKey: post.topicKey,
    questionCode: post.questionCode,
    series: post.series,
    version: post.version,
    status: studioStatus(post.status),
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
    igMediaId: post.igMediaId,
    publish: publishView(post),
    isCurrent: post.supersededAt === null,
    sourceChanged: currentHash !== null && currentHash !== post.sourceHash,
    sourceDeleted: currentHash === null,
    issues,
    advice: issues.map((i) => adviseIssue(i, fixCtx)),
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
  return postState(posts, { questionId });
}

/** The same state for a TOPIC post (the editor opens topics exactly like questions). */
export async function getTopicPostState(topicKey: string): Promise<QuestionPostState> {
  const posts = await prisma.instagramPost.findMany({ where: { topicKey }, orderBy: { version: "desc" } });
  return postState(posts, { questionId: null, topicKey });
}

async function postState(posts: InstagramPost[], key: { questionId: string | null; topicKey?: string }): Promise<QuestionPostState> {
  const current = posts.find((p) => p.supersededAt === null) ?? null;
  return {
    ...key,
    current: current ? await toDto(current) : null,
    history: posts.map((p) => ({
      id: p.id,
      version: p.version,
      status: studioStatus(p.status),
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
    const cur = map.get(p.questionId!)!;
    if (p.status === "PUBLISHED") {
      cur.posted = true;
      if (!cur.publishedAt || (p.publishedAt && p.publishedAt.toISOString() > cur.publishedAt)) cur.publishedAt = p.publishedAt?.toISOString() ?? null;
    }
    if (p.supersededAt === null) {
      cur.status = studioStatus(p.status);
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

export async function createDraft(params: {
  questionId: string;
  series: InstagramPostSeries;
  stats: SeriesStats | null;
  actorId: string;
  /** Bulk Studio: start this draft with a chosen design instead of the Settings default. */
  design?: PostDesign;
}): Promise<{ post: PostDto; existed: boolean }> {
  const existing = await prisma.instagramPost.findFirst({ where: { questionId: params.questionId, supersededAt: null } });
  if (existing) return { post: await toDto(existing), existed: true };

  const built = await buildSnapshot(params.questionId);
  if (!built) throw new StudioError("This question no longer exists.", "not-found");
  if (params.series === "PYQ" && !built.snapshot.paperId) throw new StudioError("This question is not linked to a previous year paper.");
  if (params.series === "MOST_MISSED" && !params.stats) throw new StudioError("Most Missed numbers are required.");
  if (!(await isExamInScope(built.snapshot.examId))) {
    throw new StudioError(`${built.snapshot.examName} is not in Instagram Studio's exam scope (MBBS-level and post-MBBS exams only; NEET UG is excluded). A Master Admin can change the scope in Instagram → Settings.`);
  }

  const settings = await getStudioSettings();
  const design = params.design ?? defaultDesign(settings.defaultTemplate, settings.defaultSlideCount);
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

/**
 * TOPIC draft: same lifecycle as a question draft, keyed by the topic instead of a question. Typing a topic
 * that already has a current post opens that post (existed: true) — the partial unique index on current
 * topic posts is the backstop for double clicks and two admins.
 */
export async function createTopicDraft(params: TopicInput & { actorId: string; design?: PostDesign }): Promise<{ post: PostDto; existed: boolean }> {
  const invalid = validateTopicInput(params);
  if (invalid) throw new StudioError(invalid);
  const built = await buildTopicSnapshot(params);
  if (!built) throw new StudioError("That exam no longer exists.", "not-found");
  if (!(await isExamInScope(built.snapshot.examId))) {
    throw new StudioError(`${built.snapshot.examName} is not in Instagram Studio's exam scope (MBBS-level and post-MBBS exams only; NEET UG is excluded). A Master Admin can change the scope in Instagram → Settings.`);
  }
  const { topicKey } = built;
  const existing = await prisma.instagramPost.findFirst({ where: { topicKey, supersededAt: null } });
  if (existing) return { post: await toDto(existing), existed: true };

  const settings = await getStudioSettings();
  const base = params.design ?? defaultDesign(settings.defaultTemplate, settings.defaultSlideCount);
  const design: PostDesign = { ...base, modules: [...TOPIC_DEFAULT_MODULES], slideCount: TOPIC_DEFAULT_MODULES.length };
  const content: PostContent = { ...emptyContent(), hookText: built.snapshot.text, hashtags: settings.defaultHashtags };
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`instagram-topic:${topicKey}`}))`;
      const winner = await tx.instagramPost.findFirst({ where: { topicKey, supersededAt: null } });
      if (winner) return { post: winner, existed: true };
      const max = await tx.instagramPost.aggregate({ where: { topicKey }, _max: { version: true } });
      const created = await tx.instagramPost.create({
        data: {
          questionId: null,
          topicKey,
          questionCode: built.snapshot.code,
          series: "TOPIC",
          version: (max._max.version ?? 0) + 1,
          content: json(content),
          design: json(design),
          sourceSnapshot: json(built.snapshot),
          sourceHash: built.hash,
          seriesStats: Prisma.DbNull,
          createdById: params.actorId,
        },
      });
      await tx.instagramPostRevision.create({
        data: { postId: created.id, revision: 1, baseRevision: null, content: json(content), design: json(design), note: "Topic draft created", createdById: params.actorId },
      });
      return { post: created, existed: false };
    });
    if (!result.existed) await audit(params.actorId, "INSTAGRAM_TOPIC_DRAFT_CREATED", result.post.id, { topicKey, title: built.snapshot.text, examId: built.snapshot.examId });
    return { post: await toDto(result.post, settings), existed: result.existed };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const winner = await prisma.instagramPost.findFirst({ where: { topicKey, supersededAt: null } });
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
  // A topic keeps its frozen topic snapshot; a question post re-reads the question.
  const built = old.questionId === null ? { snapshot: old.sourceSnapshot as unknown as SourceSnapshot, hash: old.sourceHash } : await buildSnapshot(old.questionId);
  if (!built) throw new StudioError("This question no longer exists.", "not-found");
  const sameSource = old.questionId === null ? { topicKey: old.topicKey } : { questionId: old.questionId };
  const max = await prisma.instagramPost.aggregate({ where: sameSource, _max: { version: true } });
  try {
    const post = await prisma.$transaction(async (tx) => {
      const res = await tx.instagramPost.updateMany({ where: { id: old.id, supersededAt: null }, data: { supersededAt: new Date() } });
      if (res.count !== 1) throw new StudioError("Someone else already created a new version.", "conflict");
      const content = normalizeContent(old.content);
      const design = normalizeDesign(old.design);
      const created = await tx.instagramPost.create({
        data: {
          questionId: old.questionId,
          topicKey: old.topicKey,
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
    await audit(actorId, "INSTAGRAM_NEW_VERSION", post.id, { questionId: old.questionId, topicKey: old.topicKey, fromPostId: old.id, version: post.version });
    return toDto(post);
  } catch (e) {
    if (isUniqueViolation(e)) throw new StudioError("Someone else already created a new version.", "conflict");
    throw e;
  }
}

async function loadEditable(postId: string, expectedRevision: number) {
  const post = await prisma.instagramPost.findUnique({ where: { id: postId } });
  if (!post) throw new StudioError("This post no longer exists.", "not-found");
  if (post.supersededAt) throw new StudioError("This is an older version and can't be edited.");
  if (post.status === "PUBLISHED" || post.status === "PUBLISHING") throw new StudioError("A published post can't be edited. Use Create New Version.");
  if (post.revision !== expectedRevision) throw new StudioError("This draft was changed in another window. Reload it to see the latest version.", "conflict");
  return post;
}

/**
 * Writes a new revision (content and/or design) on top of `expectedRevision`.
 * A failed (or legacy Ready) post becomes a Draft again, and any publish
 * confirmation on record (e.g. a confirmed Bulk Studio queue item) is cleared:
 * a confirmation covers one exact revision only.
 */
async function writeRevision(
  post: InstagramPost,
  next: { content: PostContent; design: PostDesign },
  note: string,
  actorId: string,
  baseRevision: number | null,
  extra: Prisma.InstagramPostUpdateManyMutationInput = {}
): Promise<InstagramPost> {
  const revision = post.revision + 1;
  const hadConfirmation = post.reviewedAt !== null;
  await prisma.$transaction(async (tx) => {
    const res = await tx.instagramPost.updateMany({
      where: { id: post.id, revision: post.revision, supersededAt: null, status: { in: ["DRAFT", "READY", "FAILED"] } },
      data: {
        content: json(next.content),
        design: json(next.design),
        revision,
        updatedById: actorId,
        status: "DRAFT",
        reviewedAt: null,
        reviewedById: null,
        review: Prisma.DbNull,
        ...extra,
      },
    });
    if (res.count !== 1) throw new StudioError("This draft was changed in another window. Reload it to see the latest version.", "conflict");
    await tx.instagramPostRevision.create({
      data: { postId: post.id, revision, baseRevision, content: json(next.content), design: json(next.design), note, createdById: actorId },
    });
  });
  if (hadConfirmation) await audit(actorId, "INSTAGRAM_CONFIRMATION_CLEARED", post.id, { reason: note, revision: post.revision });
  return (await prisma.instagramPost.findUnique({ where: { id: post.id } }))!;
}

/** writeRevision on top of the post's current revision (lib/instagram/repair.ts, proposals). Same conflict guard. */
export function writeRevisionFor(post: InstagramPost, next: { content: PostContent; design: PostDesign }, note: string, actorId: string, extra: Prisma.InstagramPostUpdateManyMutationInput = {}): Promise<InstagramPost> {
  return writeRevision(post, next, note.slice(0, 200), actorId, post.revision, extra);
}

export async function applyChange(params: {
  postId: string;
  expectedRevision: number;
  content?: PostContent;
  design?: PostDesign;
  note: string;
  actorId: string;
}): Promise<PostDto> {
  const post = await loadEditable(params.postId, params.expectedRevision);
  const next = {
    content: params.content ?? normalizeContent(post.content),
    design: params.design ?? normalizeDesign(post.design),
  };
  const updated = await writeRevision(post, next, params.note.slice(0, 200), params.actorId, post.revision);
  return toDto(updated);
}

export async function undoLast(postId: string, expectedRevision: number, actorId: string): Promise<PostDto> {
  const post = await loadEditable(postId, expectedRevision);
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

export async function restoreRevision(postId: string, expectedRevision: number, targetRevision: number, actorId: string): Promise<PostDto> {
  const post = await loadEditable(postId, expectedRevision);
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
export async function setQuestionNumber(postId: string, expectedRevision: number, questionNumber: number | null, verified: boolean, actorId: string): Promise<PostDto> {
  if (questionNumber !== null && (!Number.isInteger(questionNumber) || questionNumber < 1 || questionNumber > 500)) {
    throw new StudioError("Question number must be a whole number between 1 and 500.");
  }
  const post = await loadEditable(postId, expectedRevision);
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
  const post = await loadEditable(postId, expectedRevision);
  if (post.questionId === null) throw new StudioError("A topic post has no Question Bank source to refresh.");
  const built = await buildSnapshot(post.questionId);
  if (!built) throw new StudioError("This question no longer exists in the Question Bank.", "not-found");
  const updated = await writeRevision(
    post,
    { content: normalizeContent(post.content), design: normalizeDesign(post.design) },
    "Question snapshot refreshed from the Question Bank",
    actorId,
    post.revision,
    { sourceSnapshot: json(built.snapshot), sourceHash: built.hash, questionCode: built.snapshot.code }
  );
  await audit(actorId, "INSTAGRAM_SNAPSHOT_REFRESHED", post.id, { questionId: post.questionId });
  return toDto(updated);
}

/** Deletes an unpublished current draft. If it was a new version, the previous published version becomes current again. */
export async function deleteDraft(postId: string, actorId: string): Promise<void> {
  const post = await prisma.instagramPost.findUnique({ where: { id: postId } });
  if (!post) return;
  if (post.status !== "DRAFT" && post.status !== "READY") throw new StudioError("Only Draft posts can be deleted.");
  if (post.supersededAt) throw new StudioError("Older versions are kept as history.");
  await prisma.$transaction(async (tx) => {
    await tx.instagramPost.delete({ where: { id: post.id } });
    const prev = await tx.instagramPost.findFirst({ where: post.questionId === null ? { topicKey: post.topicKey } : { questionId: post.questionId }, orderBy: { version: "desc" } });
    if (prev) await tx.instagramPost.update({ where: { id: prev.id }, data: { supersededAt: null } });
  });
  await audit(actorId, "INSTAGRAM_DRAFT_DELETED", postId, { questionId: post.questionId, topicKey: post.topicKey, version: post.version });
}
