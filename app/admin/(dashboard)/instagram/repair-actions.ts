"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { AiNotConfiguredError } from "@/lib/ai-provider";
import { AiProviderFailure } from "@/lib/ai-gateway";
import { GATEWAY_PROVIDERS, type AiFeature, type GatewayProvider } from "@/lib/ai-gateway-config";
import { QuoteError, consumeQuote } from "@/lib/ai-engine/quote";
import { allowedCaptionDomains, getStudioSettings } from "@/lib/instagram/config";
import { generateContent } from "@/lib/instagram/ai";
import { generateDiagram, generateTrap, gatewayGenerator } from "@/lib/instagram/ai-studio";
import { StudioError, type PostDto } from "@/lib/instagram/posts";
import { getAiReference } from "@/lib/instagram/snapshot";
import { applyRepair, previewRepair, recordMedicalReview, type RepairPreview, type RepairResult } from "@/lib/instagram/repair";
import { acceptProposal, allowedKeysFor, makeProposal, type Proposal } from "@/lib/instagram/proposals";
import { CONTENT_FIELDS, CONTENT_FIELD_LABELS, normalizeContent, type ContentField, type SeriesStats, type SourceSnapshot } from "@/lib/instagram/types";

/**
 * Admin → Instagram → Checks tab: Fix This Error / Master Fix (deterministic,
 * no AI), Generate with AI suggestions (Accept / Reject / Retry) and the
 * medical review record. Same guard as actions.ts: every action re-checks
 * INSTAGRAM_MANAGE (MASTER_ADMIN only) server-side. AI calls go through the
 * AI Gateway with the feature's configured routing and the one-time cost
 * quote — provider defaults are never changed here.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; kind?: StudioError["kind"] | "provider" };

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

async function run<T>(actorId: string | null, fn: (actorId: string) => Promise<T>): Promise<Result<T>> {
  if (!actorId) return { ok: false, error: NOT_ALLOWED };
  try {
    return { ok: true, data: await fn(actorId) };
  } catch (error) {
    if (error instanceof StudioError) return { ok: false, error: error.message, kind: error.kind };
    if (error instanceof QuoteError) return { ok: false, error: error.message };
    // Category D: the provider failed or AI is paused — nothing was changed; the admin may retry safely.
    if (error instanceof AiNotConfiguredError) return { ok: false, error: error.message || "AI generation is not configured or is paused (Platform Controls).", kind: "provider" };
    if (error instanceof AiProviderFailure) return { ok: false, error: `${error.message} Nothing was changed.`, kind: "provider" };
    if (error instanceof Error && /^The AI /.test(error.message)) return { ok: false, error: error.message, kind: "provider" };
    console.error("[instagram-repair]", error instanceof Error ? error.message.slice(0, 200) : "error");
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
function checkCodes(v: unknown): string[] | "all" {
  if (v === "all") return "all";
  if (!Array.isArray(v) || !v.length) throw new StudioError("Choose an issue to fix.");
  return v.filter((x): x is string => typeof x === "string" && x.length <= 120).slice(0, 60);
}
function parseProvider(p: unknown): GatewayProvider | null {
  if (p === null || p === undefined || p === "" || p === "default") return null;
  if ((GATEWAY_PROVIDERS as readonly string[]).includes(p as string)) return p as GatewayProvider;
  throw new StudioError("Unknown AI provider.");
}
function touch() {
  revalidatePath("/admin/instagram", "layout");
}

// ---- Fix This Error / Master Fix --------------------------------------------------------

export async function previewFixAction(input: { postId: string; codes: string[] | "all" }): Promise<Result<RepairPreview>> {
  return run(await requireStudio(), async () => previewRepair(checkId(input.postId), checkCodes(input.codes)));
}

export async function applyFixAction(input: { postId: string; expectedRevision: number; planHash: string; codes: string[] | "all" }): Promise<Result<RepairResult>> {
  return run(await requireStudio(), async (actorId) => {
    if (typeof input.planHash !== "string" || !/^[a-f0-9]{32}$/.test(input.planHash)) throw new StudioError("Preview the fixes first.");
    const r = await applyRepair({ postId: checkId(input.postId), expectedRevision: checkRevision(input.expectedRevision), planHash: input.planHash, codes: checkCodes(input.codes), actorId });
    touch();
    return r;
  });
}

// ---- Medical review -------------------------------------------------------------------------

export async function recordMedicalReviewAction(input: { postId: string; expectedRevision: number; fullReview: boolean; attested: boolean; note: string; flags: { flag: string; decision: string; note: string }[] }): Promise<Result<PostDto>> {
  return run(await requireStudio(), async (actorId) => {
    const flags = Array.isArray(input.flags) ? input.flags.slice(0, 10).map((f) => ({ flag: String(f?.flag ?? ""), decision: String(f?.decision ?? ""), note: String(f?.note ?? "") })) : [];
    const r = await recordMedicalReview({
      postId: checkId(input.postId),
      expectedRevision: checkRevision(input.expectedRevision),
      actorId,
      fullReview: input.fullReview === true,
      attested: input.attested === true,
      note: typeof input.note === "string" ? input.note : "",
      flags,
    });
    touch();
    return r;
  });
}

// ---- Generate with AI (suggestions) ---------------------------------------------------------

const FEATURE: Record<"content" | "trap" | "diagram", AiFeature> = { content: "ig_carousel", trap: "ig_trap", diagram: "ig_diagram" };

/**
 * Regenerates ONE section of the SAVED post and returns it as a suggestion
 * (nothing is written). The admin must save or discard edits first, so the
 * suggestion can never be based on — or overwrite — text they haven't saved.
 */
export async function proposeAiAction(input: { postId: string; expectedRevision: number; kind: string; fields?: string[]; instruction?: string; label?: string; provider?: string | null; quoteId?: string }): Promise<Result<Proposal>> {
  return run(await requireStudio(), async (actorId) => {
    const postId = checkId(input.postId);
    const expectedRevision = checkRevision(input.expectedRevision);
    const kind = input.kind === "trap" || input.kind === "diagram" ? input.kind : "content";
    const fields = kind === "content" && Array.isArray(input.fields) ? input.fields.filter((f): f is ContentField => (CONTENT_FIELDS as readonly string[]).includes(f)) : [];
    if (kind === "content" && !fields.length) throw new StudioError("Choose which section to regenerate.");
    const post = await prisma.instagramPost.findUnique({ where: { id: postId } });
    if (!post) throw new StudioError("This post no longer exists.", "not-found");
    if (post.revision !== expectedRevision) throw new StudioError("This draft was changed in another window. Reload it first.", "conflict");
    if (post.status === "PUBLISHED" || post.status === "PUBLISHING" || post.supersededAt) throw new StudioError("A published post can't be edited. Use Create New Version.");
    const snapshot = post.sourceSnapshot as unknown as SourceSnapshot;
    const base = normalizeContent(post.content);
    const instruction = typeof input.instruction === "string" ? input.instruction.trim().slice(0, 500) : "";
    const q = await consumeQuote({ quoteId: input.quoteId, actorId, feature: FEATURE[kind], action: FEATURE[kind], context: { postId } });
    const engine = { quoteId: q.id, modelOverride: q.model, instagramPostId: postId };
    const provider = parseProvider(input.provider);
    let after = base;
    let summary = "";
    if (kind === "content") {
      const settings = await getStudioSettings();
      const outcome = await generateContent({
        snapshot,
        series: post.series,
        stats: (post.seriesStats as SeriesStats | null) ?? null,
        current: base,
        targets: fields,
        instruction: instruction || undefined,
        reference: post.questionId ? await getAiReference(post.questionId) : null,
        allowedDomains: allowedCaptionDomains(settings),
        actorId,
        provider,
        engine,
      });
      if (!outcome.changed.length) {
        throw new StudioError(`${outcome.summary}${outcome.rejected.length ? ` (${outcome.rejected.map((r) => `${CONTENT_FIELD_LABELS[r.field]}: ${r.reason}`).join("; ")})` : ""} Try Retry.`);
      }
      after = outcome.content;
      summary = outcome.summary;
    } else {
      const gen = gatewayGenerator({ actorId, provider, ...engine });
      const r = kind === "trap" ? await generateTrap({ snapshot, content: base, instruction: instruction || undefined, gen }) : await generateDiagram({ snapshot, content: base, kind: "auto", instruction: instruction || undefined, gen });
      after = r.content;
      summary = r.summary;
    }
    const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 60) : kind === "content" ? fields.map((f) => CONTENT_FIELD_LABELS[f]).join(", ") : kind === "trap" ? "Examiner Trap" : "diagram";
    return makeProposal({ postId, actorId, baseRevision: post.revision, label, before: base, after, summary, allowed: allowedKeysFor(kind, fields) });
  });
}

export async function acceptAiProposalAction(input: { postId: string; expectedRevision: number; token: string }): Promise<Result<PostDto>> {
  return run(await requireStudio(), async (actorId) => {
    const r = await acceptProposal({ postId: checkId(input.postId), expectedRevision: checkRevision(input.expectedRevision), token: String(input.token ?? ""), actorId });
    touch();
    return r;
  });
}
