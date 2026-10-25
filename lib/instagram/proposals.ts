import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { StudioError, toDto, writeRevisionFor, type PostDto } from "@/lib/instagram/posts";
import { normalizeContent, normalizeDesign, type PostContent } from "@/lib/instagram/types";

/**
 * "Generate with AI" for one section, as a SUGGESTION: the AI result is not
 * saved. The admin sees the old and new text and chooses Accept, Reject or
 * Retry. The suggestion travels to the browser and back as a signed token
 * (HMAC with AUTH_SECRET), so Accept applies exactly what was shown — the
 * client can't inject text marked as AI-reviewed or change the patch — and
 * only on top of the revision it was generated from. Accepting writes one
 * revision (Undo / History restore the original). Generators keep their own
 * guarantees: the answer key is echoed and checked (lib/instagram/ai-core.ts),
 * a trap is a new question with its own checks, nothing touches the
 * Question Bank or provenance (source, paper, printed number).
 */

/** Keys a suggestion may change — never the snapshot, captionVariants, image, review record or design. */
const PATCHABLE = ["hooks", "hookText", "explanation", "memoryTrick", "clinicalPearl", "quickRevision", "pearls", "mistakes", "finalTrick", "caption", "hashtags", "diagram", "trap", "origin", "aiFlags"] as const;
type PatchKey = (typeof PATCHABLE)[number];
type Patch = Partial<Pick<PostContent, PatchKey>>;

/** Keys shown as "old → new" (origin/aiFlags travel with them). */
const VISIBLE: PatchKey[] = ["hooks", "hookText", "explanation", "memoryTrick", "clinicalPearl", "quickRevision", "pearls", "mistakes", "finalTrick", "caption", "hashtags", "diagram", "trap"];

export interface Proposal {
  token: string;
  baseRevision: number;
  label: string;
  diff: { key: PatchKey; before: unknown; after: unknown }[];
  flags: string[];
  summary: string;
}

const MAX_AGE_MS = 6 * 3600_000;

function secret(): string {
  const s = process.env.AUTH_SECRET ?? "";
  if (!s) throw new Error("AUTH_SECRET is required to sign AI suggestions.");
  return s;
}
const sign = (body: string) => crypto.createHmac("sha256", `ig-ai-proposal:${secret()}`).update(body).digest("base64url");

interface Payload {
  v: 1;
  postId: string;
  actorId: string;
  baseRevision: number;
  label: string;
  patch: Patch;
  iat: number;
}

export function makeProposal(params: { postId: string; actorId: string; baseRevision: number; label: string; before: PostContent; after: PostContent; summary: string; allowed: PatchKey[] }): Proposal {
  const patch: Patch = {};
  for (const k of PATCHABLE) {
    if (!params.allowed.includes(k) && k !== "origin" && k !== "aiFlags") continue;
    if (JSON.stringify(params.before[k]) !== JSON.stringify(params.after[k])) (patch as Record<string, unknown>)[k] = params.after[k];
  }
  const diff = VISIBLE.filter((k) => k in patch).map((k) => ({ key: k, before: params.before[k], after: params.after[k] }));
  if (!diff.length) throw new StudioError(`${params.summary} The AI returned no usable change for the ${params.label}.`);
  const payload: Payload = { v: 1, postId: params.postId, actorId: params.actorId, baseRevision: params.baseRevision, label: params.label, patch, iat: Date.now() };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const newFlags = (params.after.aiFlags ?? []).filter((f) => !params.before.aiFlags.includes(f));
  return { token: `${body}.${sign(body)}`, baseRevision: params.baseRevision, label: params.label, diff, flags: newFlags, summary: params.summary };
}

function readToken(token: string): Payload {
  const [body, mac] = typeof token === "string" ? token.split(".") : [];
  if (!body || !mac) throw new StudioError("Invalid AI suggestion.");
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) throw new StudioError("Invalid AI suggestion.");
  const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
  if (p.v !== 1 || Date.now() - p.iat > MAX_AGE_MS) throw new StudioError("This AI suggestion expired. Generate it again.");
  return p;
}

export function allowedKeysFor(kind: "content" | "trap" | "diagram", fields: string[]): PatchKey[] {
  if (kind === "trap") return ["trap"];
  if (kind === "diagram") return ["diagram"];
  const keys = fields.filter((f): f is PatchKey => (PATCHABLE as readonly string[]).includes(f));
  return keys.includes("hooks") ? [...keys, "hookText"] : keys;
}

export async function acceptProposal(params: { postId: string; expectedRevision: number; token: string; actorId: string }): Promise<PostDto> {
  const p = readToken(params.token);
  if (p.postId !== params.postId || p.actorId !== params.actorId) throw new StudioError("Invalid AI suggestion.");
  const post = await prisma.instagramPost.findUnique({ where: { id: params.postId } });
  if (!post) throw new StudioError("This post no longer exists.", "not-found");
  if (post.revision !== params.expectedRevision || post.revision !== p.baseRevision) {
    throw new StudioError("The draft was changed after this suggestion was generated, so it was not applied (your edits are kept). Use Retry to generate a new suggestion.", "conflict");
  }
  const content = normalizeContent({ ...normalizeContent(post.content), ...p.patch });
  const fields = Object.keys(p.patch).filter((k) => k !== "origin" && k !== "aiFlags");
  const updated = await writeRevisionFor(post, { content, design: normalizeDesign(post.design) }, `AI suggestion accepted: ${fields.join(", ")}`, params.actorId);
  await prisma.auditLog.create({ data: { actorId: params.actorId, action: "INSTAGRAM_AI_SUGGESTION_ACCEPTED", entityType: "InstagramPost", entityId: post.id, metadata: { revision: updated.revision, fields, label: p.label } } });
  return toDto(updated);
}
