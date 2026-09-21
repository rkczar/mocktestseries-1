import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { PAGE_VISIBILITY_DEFAULTS } from "@/lib/page-visibility";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PageVisibilityToggle } from "./page-visibility-toggle";

export const metadata = { title: "Pages & Content — Mock Test Series.in Admin" };

export default async function ContentPage() {
  const [session, rows] = await Promise.all([
    getAdminSession(),
    prisma.pageVisibility.findMany({ where: { key: { in: PAGE_VISIBILITY_DEFAULTS.map((d) => d.key) } } }),
  ]);

  const canManage = session?.user.permissions?.includes(PERMISSIONS.PAGE_VISIBILITY_MANAGE) ?? false;
  const rowByKey = new Map(rows.map((r) => [r.key, r]));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Pages & Content</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Turn public pages on or off. Turning a page off does not delete its content — the page can be
          switched back on later, and it stops being reachable at its URL while off (a 404, not just a
          hidden nav link).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Public Pages</CardTitle>
          <CardDescription>
            {canManage
              ? "You can turn these on or off."
              : "View only — page visibility changes require MASTER_ADMIN."}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-4">Page</th>
                <th className="py-2 pr-4">Route</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Visible</th>
                <th className="py-2 pr-4">Last Updated</th>
                <th className="py-2 pr-4" />
              </tr>
            </thead>
            <tbody>
              {PAGE_VISIBILITY_DEFAULTS.map((def) => {
                const row = rowByKey.get(def.key);
                const isVisible = row?.isVisible ?? true;
                return (
                  <tr key={def.key} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{def.label}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                      <code>{def.route}</code>
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className={isVisible ? "text-[var(--color-success)]" : "text-[var(--color-muted-foreground)]"}>
                        {isVisible ? "ON" : "OFF"}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4">
                      <PageVisibilityToggle pageKey={def.key} isVisible={isVisible} canManage={canManage} />
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                      {row ? new Date(row.updatedAt).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" }) : "—"}
                    </td>
                    <td className="py-2.5 pr-4">
                      {isVisible ? (
                        <Link
                          href={def.route}
                          target="_blank"
                          className="inline-flex items-center gap-1 text-[var(--color-primary)] hover:underline"
                        >
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                          Open
                        </Link>
                      ) : (
                        <span className="text-[var(--color-muted-foreground)]">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Exam Landing Pages</CardTitle>
          <CardDescription>
            Each exam&apos;s public page (on/off, slug, and editorial content) is managed from Admin → Exams,
            not here — an exam can stay active for students while its public marketing page is hidden.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/admin/exams" className="text-sm text-[var(--color-primary)] hover:underline">
            Go to Admin → Exams
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
