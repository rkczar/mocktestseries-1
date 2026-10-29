import "server-only";
import crypto from "node:crypto";
import sharp from "sharp";
import { Prisma, type InstagramPost } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getStudioSettings } from "@/lib/instagram/config";
import { normalizeForSlides } from "@/lib/instagram/glyphs";
import { adviseIssue, planFixes, type FixChange, type FixContext, type IssueAdvice } from "@/lib/instagram/fixes";
import { StudioError, issuesFor, questionEditHref, sourceHashNow, toDto, writeRevisionFor, type PostDto } from "@/lib/instagram/posts";
import { medicalTextHash, type QualityIssue } from "@/lib/instagram/quality";
import { renderSlideJpeg } from "@/lib/instagram/render";
import { slideSequence } from "@/lib/instagram/layout";
import { FLAG_DECISIONS, SLIDE_HEIGHT, SLIDE_WIDTH, normalizeContent, normalizeDesign, type FlagDecision, type MedicalReview, type PostContent, type PostDesign, type SourceSnapshot } from "@/lib/instagram/types";

/**
 * Server side of "Fix This Error" / "Master Fix" and "Record medical review".
 *
 *  preview → nothing is written; returns the exact changes, a plan hash and
 *            the quality checks as they would be after the fix.
 *  apply   → recomputes the plan on the CURRENT saved post and refuses when
 *            the revision moved (someone edited) or the plan differs from the
 *            one previewed (hash) — so a fix can never overwrite an edit the
 *            admin hasn't seen. One new revision of the post's OWN content and
 *            design (Undo restores the previous state). The Question Bank is
 *            never written; its only access here is the read-only source hash
 *            the quality gate already uses.
 *            Affected slides are re-rendered and checked (1080 × 1350, no
 *            undrawable characters) before the result is reported.
 */

export interface RepairPreview {
  postId: string;
  baseRevision: number;
  planHash: string;
  changes: FixChange[];
  before: { errors: number; warnings: number };
  after: { errors: number; warnings: number; issues: QualityIssue[] };
  /** Issues the fix can't address, with their advice (admin / medical). */
  remaining: { issue: QualityIssue; advice: IssueAdvice }[];
}

export interface RepairResult {
  post: PostDto;
  changes: FixChange[];
  before: { errors: number; warnings: number };
  after: { errors: number; warnings: number };
  rendered: { slide: number; width: number; height: number }[];
}


async function loadPost(postId: string): Promise<InstagramPost> {
  const post = await prisma.instagramPost.findUnique({ where: { id: postId } });
  if (!post) throw new StudioError("This post no longer exists.", "not-found");
  return post;
}

async function contextFor(post: InstagramPost): Promise<{ ctx: FixContext; issues: QualityIssue[]; currentHash: string | null; settings: Awaited<ReturnType<typeof getStudioSettings>> }> {
  const [settings, currentHash] = await Promise.all([getStudioSettings(), sourceHashNow(post)]);
  const ctx: FixContext = {
    snapshot: post.sourceSnapshot as unknown as SourceSnapshot,
    content: normalizeContent(post.content),
    design: normalizeDesign(post.design),
    series: post.series,
    normalize: normalizeForSlides,
    questionEditHref: questionEditHref(post.questionId),
  };
  return { ctx, issues: issuesFor(post, currentHash, settings), currentHash, settings };
}

function counts(issues: QualityIssue[]) {
  return { errors: issues.filter((i) => i.severity === "error").length, warnings: issues.filter((i) => i.severity === "warning").length };
}

function hashPlan(revision: number, plan: { content: PostContent; design: PostDesign; changes: FixChange[] }): string {
  return crypto.createHash("sha256").update(JSON.stringify([revision, plan.content, plan.design, plan.changes])).digest("hex").slice(0, 32);
}

async function buildPlan(post: InstagramPost, codes: string[] | "all") {
  const { ctx, issues, currentHash, settings } = await contextFor(post);
  const plan = planFixes(issues, ctx, codes);
  const afterIssues = issuesFor({ ...post, content: plan.content as unknown as Prisma.JsonValue, design: plan.design as unknown as Prisma.JsonValue, }, currentHash, settings);
  return { ctx, issues, plan, afterIssues, currentHash, settings };
}

export async function previewRepair(postId: string, codes: string[] | "all"): Promise<RepairPreview> {
  const post = await loadPost(postId);
  const { ctx, issues, plan, afterIssues } = await buildPlan(post, codes);
  return {
    postId,
    baseRevision: post.revision,
    planHash: hashPlan(post.revision, plan),
    changes: plan.changes,
    before: counts(issues),
    after: { ...counts(afterIssues), issues: afterIssues },
    remaining: afterIssues.map((issue) => ({ issue, advice: adviseIssue(issue, { ...ctx, content: plan.content, design: plan.design }) })).filter((r) => r.advice.category !== "auto"),
  };
}

export async function applyRepair(params: { postId: string; expectedRevision: number; planHash: string; codes: string[] | "all"; actorId: string }): Promise<RepairResult> {
  const post = await loadPost(params.postId);
  if (post.revision !== params.expectedRevision) throw new StudioError("This draft was changed in another window after the preview. Nothing was changed — review the fixes again.", "conflict");
  if (post.status === "PUBLISHED" || post.status === "PUBLISHING" || post.supersededAt) throw new StudioError("A published post can't be edited. Use Create New Version.");
  const built = await buildPlan(post, params.codes);
  if (hashPlan(post.revision, built.plan) !== params.planHash) throw new StudioError("The proposed fixes changed since the preview (the question or settings were updated). Nothing was changed — review the fixes again.", "conflict");
  if (!built.plan.changes.length) throw new StudioError("Nothing to fix automatically.");

  const note = `Fix: ${[...new Set(built.plan.changes.map((c) => c.group.replace(/ \(.*\)$/, "")))].join(", ")}`.slice(0, 200);
  const updated = await writeRevisionFor(post, { content: built.plan.content, design: built.plan.design }, note, params.actorId);
  await prisma.auditLog.create({
    data: { actorId: params.actorId, action: "INSTAGRAM_FIX_APPLIED", entityType: "InstagramPost", entityId: post.id, metadata: { revision: updated.revision, codes: params.codes, changes: built.plan.changes as unknown as Prisma.InputJsonValue } },
  });

  // Re-render every slide the changes touch (all, when the text size changed) and verify the exported image.
  const dto = await toDto(updated, built.settings);
  const sequence = slideSequence(dto.content, dto.design);
  const touched = new Set<number>();
  const fieldModules: Record<string, string[]> = {
    Hook: ["HOOK", "QUESTION"],
    Explanation: ["ANSWER", "EXPLANATION", "EXPLANATION_TRICK"],
    "Memory Trick": ["MEMORY_TRICK", "EXPLANATION_TRICK"],
    "Clinical Pearl": ["MEMORY_TRICK", "PEARL_REVISION"],
    "Quick Revision": ["PEARL_REVISION"],
    "High-Yield Pearls": ["PEARLS"],
    "Common Mistakes": ["MISTAKES"],
    Diagram: ["DIAGRAM"],
    "Final trick": ["FOLLOW"],
    "Medical image": ["MEDICAL_IMAGE"],
    "Examiner Trap": ["TRAP"],
  };
  for (const c of built.plan.changes) {
    if (c.kind === "text-size") sequence.forEach((_, i) => touched.add(i));
    const mods = fieldModules[c.target];
    if (mods) sequence.forEach((r, i) => mods.includes(r.module) && touched.add(i));
  }
  const rendered: RepairResult["rendered"] = [];
  for (const i of [...touched].sort((a, b) => a - b)) {
    const jpeg = await renderSlideJpeg({ snapshot: dto.snapshot, content: dto.content, design: dto.design, series: dto.series, seriesStats: dto.seriesStats, questionNumber: dto.questionNumber, questionNumberVerified: dto.questionNumberVerified, settings: built.settings }, i);
    const meta = await sharp(jpeg).metadata();
    if (meta.width !== SLIDE_WIDTH || meta.height !== SLIDE_HEIGHT) throw new Error(`Slide ${i + 1} rendered at ${meta.width}×${meta.height}`);
    rendered.push({ slide: i + 1, width: meta.width, height: meta.height });
  }
  return { post: dto, changes: built.plan.changes, before: counts(built.issues), after: counts(dto.issues), rendered };
}

// ---- Medical review ------------------------------------------------------------------------

/**
 * Records what a reviewer actually checked, for exactly the current text
 * (hash). `fullReview` = every medical statement on the slides was checked;
 * per-note decisions resolve only those AI notes. Any later edit or
 * regeneration voids the record (the gate compares the hash), so a review is
 * never carried over to text nobody reviewed.
 */
export async function recordMedicalReview(params: {
  postId: string;
  expectedRevision: number;
  actorId: string;
  fullReview: boolean;
  attested: boolean;
  note: string;
  flags: { flag: string; decision: string; note: string }[];
}): Promise<PostDto> {
  if (!params.attested) throw new StudioError("Confirm that you checked the statements against a standard medical reference.");
  const post = await loadPost(params.postId);
  if (post.revision !== params.expectedRevision) throw new StudioError("This draft was changed in another window. Reload it to see the latest version.", "conflict");
  const content = normalizeContent(post.content);
  const flags: MedicalReview["flags"] = [];
  for (const f of params.flags) {
    if (!content.aiFlags.includes(f.flag)) throw new StudioError("An AI note changed since you opened the review. Reload and review again.", "conflict");
    if (!(FLAG_DECISIONS as readonly string[]).includes(f.decision)) throw new StudioError("Choose a decision for each AI note.");
    const note = (f.note ?? "").trim().slice(0, 500);
    if (f.decision === "context" && !note) throw new StudioError("Explain the exam context for a note marked \"correct in this exam context\".");
    flags.push({ flag: f.flag, decision: f.decision as FlagDecision, note });
  }
  if (!params.fullReview && !flags.length) throw new StudioError("Nothing to record — review the content or decide on at least one AI note.");
  // Earlier decisions on notes that still exist are kept when a later review adds more.
  const previous = content.medicalReview && content.medicalReview.contentHash === medicalTextHash(content) ? content.medicalReview : null;
  const merged = [...(previous?.flags ?? []).filter((p) => !flags.some((f) => f.flag === p.flag)), ...flags];
  const admin = await prisma.adminUser.findUnique({ where: { id: params.actorId }, select: { name: true } });
  const review: MedicalReview = {
    contentHash: medicalTextHash(content),
    reviewerId: params.actorId,
    reviewerName: admin?.name ?? "Admin",
    at: new Date().toISOString(),
    note: params.note.trim().slice(0, 1000),
    fullReview: params.fullReview || Boolean(previous?.fullReview),
    flags: merged,
  };
  const updated = await writeRevisionFor(post, { content: { ...content, medicalReview: review }, design: normalizeDesign(post.design) }, params.fullReview ? "Medical review recorded" : `Medical review: ${flags.length} AI note(s) decided`, params.actorId);
  await prisma.auditLog.create({
    data: { actorId: params.actorId, action: "INSTAGRAM_MEDICAL_REVIEW", entityType: "InstagramPost", entityId: post.id, metadata: { revision: updated.revision, fullReview: review.fullReview, flags: review.flags, contentHash: review.contentHash } as unknown as Prisma.InputJsonValue },
  });
  return toDto(updated);
}
