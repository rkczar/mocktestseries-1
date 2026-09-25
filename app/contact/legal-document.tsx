import type { Metadata } from "next";
import { PublicPageShell, getPublicChrome } from "@/components/homepage/public-page-shell";
import { Card, CardContent, CardHeader, CardDescription } from "@/components/ui/card";
import { str } from "@/components/homepage/content-helpers";
import { BRAND_NAME } from "@/lib/brand";
import { getSiteUrl } from "@/lib/site-url";
import { LegalBody } from "./legal-body";

/**
 * Standalone /privacy and /terms pages. They render the SAME admin-managed
 * text as the Privacy/Terms sections of /contact (Admin → Website → Contact
 * info: privacyBody/termsBody) — one source, no legal copy lives in code.
 */
const DOCS = {
  privacy: { title: "Privacy Policy", path: "/privacy", body: "privacyBody", updated: "privacyLastUpdated" },
  terms: { title: "Terms & Conditions", path: "/terms", body: "termsBody", updated: "termsLastUpdated" },
} as const;

export type LegalDocumentKind = keyof typeof DOCS;

export async function legalDocumentMetadata(kind: LegalDocumentKind): Promise<Metadata> {
  const doc = DOCS[kind];
  const siteUrl = await getSiteUrl();
  return {
    title: `${doc.title} — ${BRAND_NAME}`,
    description: `${doc.title} of ${BRAND_NAME}.`,
    alternates: { canonical: `${siteUrl}${doc.path}` },
  };
}

export async function LegalDocumentPage({ kind }: { kind: LegalDocumentKind }) {
  const doc = DOCS[kind];
  const { contactInfo } = await getPublicChrome();
  const content = (contactInfo?.content as Record<string, unknown>) ?? {};
  const lastUpdated = str(content, doc.updated);

  return (
    <PublicPageShell>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
        <Card>
          <CardHeader>
            <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">{doc.title}</h1>
            {lastUpdated ? <CardDescription>Last Updated: {lastUpdated}</CardDescription> : null}
          </CardHeader>
          <CardContent>
            <LegalBody text={str(content, doc.body)} />
          </CardContent>
        </Card>
      </div>
    </PublicPageShell>
  );
}
