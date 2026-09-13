import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckButton } from "./check-button";
import type { BadgeProps } from "@/components/ui/badge";
import type { DiagramEntry } from "@/lib/diagram-graph";
import type { GlobalNavGroup } from "@/lib/global-nav-links";

const STATUS_VARIANT: Record<string, BadgeProps["variant"]> = {
  CONNECTED: "success",
  WARNING: "warning",
  BROKEN: "error",
  ORPHAN: "error",
  UNAUTHORIZED: "error",
  DRAFT: "neutral",
};

function GlobalNavCard({ groups }: { groups: GlobalNavGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Global navigation links</CardTitle>
        <CardDescription>
          Header, footer, and sidebar links render on many pages at once, so they&apos;re listed here rather than as
          page-to-page edges. Scanned live from each file&apos;s literal <code className="text-xs">href</code>s.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {groups.map((group) => (
          <div key={group.file}>
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">{group.label}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {group.links.map((link) => (
                <code key={link} className="rounded-[var(--radius-badge)] border border-[var(--color-border)] px-1.5 py-0.5 text-xs text-[var(--color-foreground)]">
                  {link}
                </code>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function RegistryTable({ entries, globalNavGroups }: { entries: DiagramEntry[]; globalNavGroups: GlobalNavGroup[] }) {
  const byModule = entries.reduce<Record<string, DiagramEntry[]>>((acc, entry) => {
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
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Every page — route, module, parent, user type, auth requirement, and connection status. Merged live from
          the app&apos;s actual file tree (<code className="text-xs">lib/route-scanner.ts</code>) with the
          admin-controlled registry in the database.
        </p>
        <CheckButton />
      </div>

      <div className="flex flex-wrap gap-2">
        {Object.entries(counts).map(([status, count]) => (
          <Badge key={status} variant={STATUS_VARIANT[status]}>{status}: {count}</Badge>
        ))}
      </div>

      <GlobalNavCard groups={globalNavGroups} />

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
                  <tr key={entry.route} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">
                      {entry.pageName}
                      {entry.autoDiscovered ? <span className="ml-1.5 text-xs font-normal text-[var(--color-info)]">🆕 new</span> : null}
                    </td>
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
