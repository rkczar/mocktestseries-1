import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getSeoSettings, applyTitleTemplate } from "@/lib/seo-settings";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SeoSettingsForm } from "./seo-settings-form";

export const metadata = { title: "SEO — Mock Test Series.in Admin" };

export default async function SeoAdminPage() {
  const [session, settings, exams] = await Promise.all([
    getAdminSession(),
    getSeoSettings(),
    prisma.exam.findMany({
      where: { isActive: true },
      orderBy: [{ order: "asc" }, { name: "asc" }],
      select: { id: true, name: true, publicPageEnabled: true, publicSlug: true, seoTitle: true, seoDescription: true },
    }),
  ]);

  const canManage = session?.user.permissions?.includes(PERMISSIONS.SEO_MANAGE) ?? false;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">SEO</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Site-wide defaults for public page metadata, canonical URLs, and the sitemap. Per-exam SEO (title, description, public
          URL slug, FAQ) is edited on each exam in Admin → Exams — not duplicated here.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Site Defaults</CardTitle>
          <CardDescription>
            {canManage ? "Applies to any public page that doesn't set its own title/description." : "View only — SEO settings require MASTER_ADMIN."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SeoSettingsForm settings={settings} canManage={canManage} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preview</CardTitle>
          <CardDescription>How the homepage title resolves with the current template.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
            <p className="truncate text-base text-[#1a0dab]">{applyTitleTemplate(settings.titleTemplate, "Exams")}</p>
            <p className="truncate text-sm text-[#006621]">{settings.canonicalBase}/exams</p>
            <p className="mt-1 line-clamp-2 text-sm text-[var(--color-muted-foreground)]">{settings.defaultMetaDescription}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Exam Public Pages</CardTitle>
          <CardDescription>
            Edit each exam&apos;s public page toggle, slug, and SEO title/description from{" "}
            <Link href="/admin/exams" className="text-[var(--color-primary)] hover:underline">
              Admin → Exams
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-4">Exam</th>
                <th className="py-2 pr-4">Public Page</th>
                <th className="py-2 pr-4">SEO Title</th>
                <th className="py-2 pr-4" />
              </tr>
            </thead>
            <tbody>
              {exams.map((exam) => (
                <tr key={exam.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{exam.name}</td>
                  <td className="py-2.5 pr-4">
                    {exam.publicPageEnabled && exam.publicSlug ? <Badge variant="success">Live</Badge> : <Badge variant="neutral">Off</Badge>}
                  </td>
                  <td className="max-w-xs truncate py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                    {exam.seoTitle || applyTitleTemplate(settings.titleTemplate, exam.name)}
                  </td>
                  <td className="py-2.5 pr-4">
                    {exam.publicPageEnabled && exam.publicSlug ? (
                      <Link
                        href={`/exams/${exam.publicSlug}`}
                        target="_blank"
                        className="inline-flex items-center gap-1 text-[var(--color-primary)] hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden /> View
                      </Link>
                    ) : (
                      <span className="text-[var(--color-muted-foreground)]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
