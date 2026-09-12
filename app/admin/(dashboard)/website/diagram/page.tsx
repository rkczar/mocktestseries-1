import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckButton } from "./check-button";
import type { BadgeProps } from "@/components/ui/badge";

export const metadata = { title: "Website Diagram — Mock Test Series.in Admin" };

const STATUS_VARIANT: Record<string, BadgeProps["variant"]> = {
  CONNECTED: "success",
  WARNING: "warning",
  BROKEN: "error",
  ORPHAN: "error",
  UNAUTHORIZED: "error",
  DRAFT: "neutral",
};

export default async function WebsiteDiagramPage() {
  const entries = await prisma.routeRegistryEntry.findMany({ orderBy: [{ module: "asc" }, { route: "asc" }] });

  const byModule = entries.reduce<Record<string, typeof entries>>((acc, entry) => {
    (acc[entry.module] ??= []).push(entry);
    return acc;
  }, {});

  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Website Diagram</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Live registry of every page — route, module, parent, user type, auth requirement, and connection
            status. Sourced from <code className="text-xs">lib/routes.ts</code>, seeded into the database.
          </p>
        </div>
        <CheckButton />
      </div>

      <div className="flex flex-wrap gap-2">
        {Object.entries(counts).map(([status, count]) => (
          <Badge key={status} variant={STATUS_VARIANT[status]}>{status}: {count}</Badge>
        ))}
      </div>

      {Object.entries(byModule).map(([module, moduleEntries]) => (
        <Card key={module}>
          <CardHeader>
            <CardTitle>{module}</CardTitle>
            <CardDescription>{moduleEntries.length} page{moduleEntries.length === 1 ? "" : "s"}</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Page</th>
                  <th className="py-2 pr-4">Route</th>
                  <th className="py-2 pr-4">Parent</th>
                  <th className="py-2 pr-4">User Type</th>
                  <th className="py-2 pr-4">Auth</th>
                  <th className="py-2 pr-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {moduleEntries.map((entry) => (
                  <tr key={entry.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{entry.pageName}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-muted-foreground)]">{entry.route}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-muted-foreground)]">{entry.parentRoute ?? "—"}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{entry.userType}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{entry.authRequired ? "Required" : "Public"}</td>
                    <td className="py-2.5 pr-4"><Badge variant={STATUS_VARIANT[entry.status]}>{entry.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
