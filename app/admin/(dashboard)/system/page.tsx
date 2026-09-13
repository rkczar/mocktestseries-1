import { getStorageSnapshot, formatBytes } from "@/lib/storage-stats";
import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StorageScanButton } from "./storage-panel";

export const metadata = { title: "System — Mock Test Series.in Admin" };

function formatWhen(ts: number) {
  return new Date(ts).toLocaleString("en-IN");
}

export default async function SystemPage() {
  const snapshot = await getStorageSnapshot();
  const usedPercent =
    snapshot.filesystem.totalBytes && snapshot.filesystem.usedBytes
      ? Math.round((snapshot.filesystem.usedBytes / snapshot.filesystem.totalBytes) * 100)
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">System</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          VPS disk usage, database size, and a directory-level storage breakdown.
        </p>
      </div>

      <ControlCenterTabs
        defaultValue="overview"
        tabs={[
          { value: "overview", label: "Overview", content: <OverviewTab snapshot={snapshot} usedPercent={usedPercent} /> },
          { value: "storage", label: "Storage", content: <StorageTab snapshot={snapshot} /> },
        ]}
      />
    </div>
  );
}

function OverviewTab({
  snapshot,
  usedPercent,
}: {
  snapshot: Awaited<ReturnType<typeof getStorageSnapshot>>;
  usedPercent: number | null;
}) {
  return (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  Disk used
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-[var(--color-foreground)]">
                  {formatBytes(snapshot.filesystem.usedBytes)}
                  {usedPercent != null ? (
                    <span className="ml-1 text-sm font-normal text-[var(--color-muted-foreground)]">
                      ({usedPercent}%)
                    </span>
                  ) : null}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  Disk free
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-[var(--color-foreground)]">
                  {formatBytes(snapshot.filesystem.availBytes)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  Database size
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-[var(--color-foreground)]">
                  {formatBytes(snapshot.database.bytes)}
                </p>
              </CardContent>
            </Card>
          </div>
  );
}

function StorageTab({ snapshot }: { snapshot: Awaited<ReturnType<typeof getStorageSnapshot>> }) {
  return (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <div>
                <CardTitle>Storage breakdown</CardTitle>
                <CardDescription>Last scanned {formatWhen(snapshot.scannedAt)}</CardDescription>
              </div>
              <StorageScanButton />
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
                      <th className="pb-2 font-medium">Directory</th>
                      <th className="pb-2 font-medium">Size</th>
                      <th className="pb-2 font-medium">% of scanned total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {snapshot.categories.map((cat) => {
                      const pct =
                        cat.bytes != null && snapshot.totalUsedBytes
                          ? Math.round((cat.bytes / snapshot.totalUsedBytes) * 100)
                          : null;
                      return (
                        <tr key={cat.label}>
                          <td className="py-2 text-[var(--color-foreground)]">{cat.label}</td>
                          <td className="py-2 text-[var(--color-foreground)]">
                            {cat.error ? "Unavailable" : formatBytes(cat.bytes)}
                          </td>
                          <td className="py-2 text-[var(--color-muted-foreground)]">{pct != null ? `${pct}%` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
  );
}
