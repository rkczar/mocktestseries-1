import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getPublishedHomepage } from "@/lib/homepage";

/**
 * Payment-launch readiness of the public legal pages, computed from the
 * PUBLISHED admin-managed text (Admin → Website → Homepage → Contact / About
 * / Legal). "Owner reviewed" is a Master Admin acknowledgement bound to a
 * hash of the text it covered — editing the text afterwards puts the page
 * back to "Owner review required". Stored in Setting `legal.review`.
 */

export type LegalDocKey = "terms" | "privacy" | "refund";

export const LEGAL_DOCS: Record<LegalDocKey, { title: string; path: string; bodyKey: string; visibilityKey: string }> = {
  terms: { title: "Terms & Conditions", path: "/terms", bodyKey: "termsBody", visibilityKey: "terms" },
  privacy: { title: "Privacy Policy", path: "/privacy", bodyKey: "privacyBody", visibilityKey: "privacy" },
  refund: { title: "Refund & Cancellation Policy", path: "/refund-policy", bodyKey: "refundBody", visibilityKey: "refund-policy" },
};

const REVIEW_KEY = "legal.review";

interface ReviewRecord {
  hash: string;
  reviewedAt: string;
  reviewedBy: string | null;
}

export interface LegalDocStatus {
  key: LegalDocKey;
  title: string;
  path: string;
  visible: boolean;
  hasContent: boolean;
  /** Null when the text covers payments adequately; otherwise what's missing. */
  contentIssue: string | null;
  hash: string;
  reviewed: boolean;
  reviewedAt: string | null;
}

export interface LegalReadiness {
  docs: LegalDocStatus[];
  footer: { terms: boolean; privacy: boolean; refund: boolean; contact: boolean };
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function contentIssue(key: LegalDocKey, body: string): string | null {
  if (!body.trim()) return "No content published yet.";
  if (key === "terms") {
    if (/does not currently charge/i.test(body)) return "Still says the platform does not charge for access.";
    if (!/razorpay/i.test(body) || !/refund/i.test(body)) return "Needs a payments section naming the processor and linking the refund policy.";
  }
  if (key === "privacy") {
    if (/does not currently process payments/i.test(body)) return "Still says the platform does not process payments.";
    if (!/razorpay/i.test(body)) return "Needs a payment-processor (Razorpay) disclosure.";
  }
  return null;
}

async function readReviews(): Promise<Partial<Record<LegalDocKey, ReviewRecord>>> {
  const row = await prisma.setting.findUnique({ where: { key: REVIEW_KEY } });
  return (row?.value as Partial<Record<LegalDocKey, ReviewRecord>> | null) ?? {};
}

async function publishedLegalContent() {
  const published = await getPublishedHomepage();
  const section = (k: string) => (published?.sections.find((s) => s.key === k)?.content as Record<string, unknown> | undefined) ?? {};
  return { info: section("CONTACT_INFO"), footer: section("FOOTER") };
}

export async function getLegalReadiness(): Promise<LegalReadiness> {
  // Same rule as lib/page-visibility.ts (no row = visible), queried here so this module has no next/navigation dependency.
  const [{ info, footer }, visRows, reviews] = await Promise.all([
    publishedLegalContent(),
    prisma.pageVisibility.findMany({ select: { key: true, isVisible: true } }),
    readReviews(),
  ]);
  const visibility = new Map(visRows.map((r) => [r.key, r.isVisible]));
  const docs = (Object.keys(LEGAL_DOCS) as LegalDocKey[]).map((key) => {
    const d = LEGAL_DOCS[key];
    const body = typeof info[d.bodyKey] === "string" ? (info[d.bodyKey] as string) : "";
    const hash = hashOf(body);
    const review = reviews[key];
    return {
      key,
      title: d.title,
      path: d.path,
      visible: visibility.get(d.visibilityKey) ?? true,
      hasContent: body.trim().length > 0,
      contentIssue: contentIssue(key, body),
      hash,
      reviewed: Boolean(review && review.hash === hash && body.trim()),
      reviewedAt: review && review.hash === hash ? review.reviewedAt : null,
    };
  });
  const links = Array.isArray(footer.links) ? (footer.links as unknown[]).map((l) => (Array.isArray(l) ? String(l[1] ?? "") : "")) : [];
  return {
    docs,
    footer: {
      terms: links.includes("/terms"),
      privacy: links.includes("/privacy"),
      refund: links.includes("/refund-policy"),
      contact: links.includes("/contact"),
    },
  };
}

/** Master Admin acknowledgement: "I reviewed the text currently published for this page." */
export async function markLegalDocReviewed(key: LegalDocKey, actorId: string | undefined): Promise<void> {
  const { info } = await publishedLegalContent();
  const body = typeof info[LEGAL_DOCS[key].bodyKey] === "string" ? (info[LEGAL_DOCS[key].bodyKey] as string) : "";
  if (!body.trim()) throw new Error("Nothing is published for this page yet.");
  const reviews = await readReviews();
  reviews[key] = { hash: hashOf(body), reviewedAt: new Date().toISOString(), reviewedBy: actorId ?? null };
  const value = reviews as unknown as object;
  await prisma.setting.upsert({ where: { key: REVIEW_KEY }, update: { value }, create: { key: REVIEW_KEY, value } });
}
