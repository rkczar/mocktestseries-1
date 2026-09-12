import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getOrCreateDraft } from "@/lib/homepage";
import { SECTION_META } from "@/lib/homepage-sections";
import { getHomepageStatistics } from "@/lib/homepage-statistics";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HomepageBuilder } from "./homepage-builder";
import { PublishButton } from "./publish-button";
import { VersionHistory } from "./version-history";
import { SeoForm } from "./seo-form";
import type { SectionCardData } from "./section-card";
import type { HomepageSectionKey } from "@prisma/client";

export const metadata = { title: "Homepage — Mock Test Series.in Admin" };

export default async function HomepageBuilderPage() {
  const draft = await getOrCreateDraft();

  const [exams, papers, seriesList, otherVersions, liveStats] = await Promise.all([
    prisma.exam.findMany({ orderBy: { name: "asc" } }),
    prisma.previousYearPaper.findMany({ orderBy: { year: "desc" } }),
    prisma.testSeries.findMany({ orderBy: { name: "asc" } }),
    prisma.homepageConfig.findMany({
      where: { id: { not: draft.id } },
      orderBy: { version: "desc" },
      select: { id: true, version: true, status: true, publishedAt: true },
    }),
    getHomepageStatistics(),
  ]);

  const sections: SectionCardData[] = draft.sections.map((s) => ({
    id: s.id,
    meta: SECTION_META[s.key as HomepageSectionKey],
    isEnabled: s.isEnabled,
    content: s.content as Record<string, unknown>,
    references: (s.references as Record<string, unknown>) ?? {},
  }));

  const seo = (draft.seo as Record<string, string>) ?? {};

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Homepage</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Editing Draft — Version {draft.version}. Toggle, reorder, and edit sections below; changes save to the
            draft immediately. Nothing goes live until you click Publish.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href="/admin/website/homepage/preview" target="_blank">
              <ExternalLink className="h-4 w-4" aria-hidden />
              Preview
            </Link>
          </Button>
          <PublishButton />
        </div>
      </div>

      <HomepageBuilder
        initialSections={sections}
        examOptions={exams.map((e) => ({ id: e.id, name: e.name }))}
        paperOptions={papers.map((p) => ({ id: p.id, name: `${p.title} (${p.year})` }))}
        seriesOptions={seriesList.map((s) => ({ id: s.id, name: s.name }))}
        liveStats={liveStats}
      />

      <Card>
        <CardHeader>
          <CardTitle>SEO</CardTitle>
          <CardDescription>Section 41 — sanitized plain text only, no HTML/script injection.</CardDescription>
        </CardHeader>
        <CardContent>
          <SeoForm seo={seo} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Version History</CardTitle>
          <CardDescription>Publishing never deletes a previous version.</CardDescription>
        </CardHeader>
        <CardContent>
          {otherVersions.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No previous versions yet.</p>
          ) : (
            <VersionHistory
              versions={otherVersions.map((v) => ({
                id: v.id,
                version: v.version,
                status: v.status,
                publishedAt: v.publishedAt?.toISOString() ?? null,
              }))}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
