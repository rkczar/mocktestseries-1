import type { Metadata } from "next";

import { StatusBanner } from "@/components/admin/StatusBanner";
import { TabLinks } from "@/components/admin/TabLinks";
import { prisma } from "@/lib/db";

import { ContentTab } from "./ContentTab";
import { CtaTab } from "./CtaTab";
import { SectionsTab } from "./SectionsTab";

export const metadata: Metadata = { title: "Homepage · Admin" };

const TABS = [
  { key: "content", label: "Content" },
  { key: "sections", label: "Sections" },
  { key: "ctas", label: "CTA buttons" },
];

export default async function AdminHomepagePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; success?: string; error?: string }>;
}) {
  const { tab = "content", success, error } = await searchParams;

  const [content, sections, ctaButtons] = await Promise.all([
    prisma.homepageContent.findFirst(),
    prisma.homepageSection.findMany({ orderBy: { order: "asc" } }),
    prisma.ctaButton.findMany(),
  ]);

  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">Homepage</h1>
      <p className="mt-1.5 max-w-xl text-sm text-text-muted">
        Everything here is read live by the public homepage — no code changes needed to update
        it.
      </p>

      <TabLinks tabs={TABS} active={tab} basePath="/admin/homepage" />
      <StatusBanner success={success} error={error} />

      {tab === "content" && (
        <ContentTab
          content={
            content ?? {
              heroEyebrow: "",
              heroHeading: "",
              heroDescription: "",
              finalCtaHeading: "",
              finalCtaBody: "",
              finalCtaNote: "",
            }
          }
        />
      )}
      {tab === "sections" && <SectionsTab sections={sections} />}
      {tab === "ctas" && (
        <CtaTab
          ctaButtons={Object.fromEntries(ctaButtons.map((c) => [c.slot, c]))}
        />
      )}
    </div>
  );
}
