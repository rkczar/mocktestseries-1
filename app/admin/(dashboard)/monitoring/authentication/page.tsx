import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { StatCard } from "@/components/admin/stat-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Authentication Monitoring — Mock Test Series.in Admin" };

const RECENT_LIMIT = 50;
const WINDOW_DAYS = 30;

/** Minimizes PII in the admin monitoring table: emails keep only the first two characters, mobiles only the last four digits. */
function maskIdentifier(identifier: string): string {
  if (identifier.includes("@")) {
    const [local, domain] = identifier.split("@");
    return `${local.slice(0, 2)}${"*".repeat(Math.max(local.length - 2, 1))}@${domain}`;
  }
  const digits = identifier.replace(/\D/g, "");
  if (digits.length >= 4) {
    return `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
  }
  return identifier;
}

function methodLabel(method: string | null): string {
  switch (method) {
    case "GOOGLE":
      return "Google";
    case "PHONE_OTP":
      return "Phone OTP";
    case "PASSWORD":
      return "Password";
    case "CREATE_ACCOUNT":
      return "Create Account";
    case "LOGOUT":
      return "Logout";
    default:
      return method ?? "Unknown";
  }
}

/** Kept outside the component: computing "now" is an impure call components/hooks must not make directly during render. */
async function loadAuthMonitoringData() {
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [total, successful, byMethod, recent] = await Promise.all([
    prisma.studentLoginAttempt.count({ where: { createdAt: { gte: windowStart } } }),
    prisma.studentLoginAttempt.count({ where: { createdAt: { gte: windowStart }, success: true } }),
    prisma.studentLoginAttempt.groupBy({
      by: ["method", "success"],
      where: { createdAt: { gte: windowStart } },
      _count: { _all: true },
    }),
    prisma.studentLoginAttempt.findMany({
      orderBy: { createdAt: "desc" },
      take: RECENT_LIMIT,
    }),
  ]);

  return { total, successful, byMethod, recent };
}

export default async function AuthenticationMonitoringPage() {
  const session = await getAdminSession();
  if (!session?.user?.permissions?.includes(PERMISSIONS.SETTINGS_MANAGE)) {
    return <RestrictedCard title="Authentication Monitoring" />;
  }

  const { total, successful, byMethod, recent } = await loadAuthMonitoringData();

  const failed = total - successful;
  const successRate = total > 0 ? Math.round((successful / total) * 1000) / 10 : 0;

  const methodTotals = new Map<string, { success: number; failure: number }>();
  for (const row of byMethod) {
    const key = row.method ?? "UNKNOWN";
    const entry = methodTotals.get(key) ?? { success: 0, failure: 0 };
    if (row.success) entry.success += row._count._all;
    else entry.failure += row._count._all;
    methodTotals.set(key, entry);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Authentication Monitoring</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Live totals from persisted login attempts (last {WINDOW_DAYS} days). Identifiers are partially masked;
          full contact details live on the Students page, not here.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Total Attempts" value={total} />
        <StatCard label="Successful Logins" value={successful} />
        <StatCard label="Failed Attempts" value={failed} />
        <StatCard label="Success Rate" value={`${successRate}%`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>By Method</CardTitle>
          <CardDescription>Success vs. failure per authentication channel.</CardDescription>
        </CardHeader>
        <CardContent>
          {methodTotals.size === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No authentication events recorded yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from(methodTotals.entries()).map(([method, counts]) => (
                <div key={method} className="rounded-[var(--radius-button)] border border-[var(--color-border)] p-3">
                  <p className="text-sm font-medium text-[var(--color-foreground)]">{methodLabel(method)}</p>
                  <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                    <span className="text-[var(--color-success)]">{counts.success} success</span>
                    {" · "}
                    <span className="text-[var(--color-error)]">{counts.failure} failed</span>
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Events</CardTitle>
          <CardDescription>Last {RECENT_LIMIT} authentication events across all channels.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-4 font-medium">Timestamp</th>
                <th className="py-2 pr-4 font-medium">Channel</th>
                <th className="py-2 pr-4 font-medium">Identifier</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-[var(--color-muted-foreground)]">
                    No authentication events yet.
                  </td>
                </tr>
              ) : (
                recent.map((event) => (
                  <tr key={event.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2 pr-4 text-[var(--color-muted-foreground)]">
                      {event.createdAt.toLocaleString("en-IN")}
                    </td>
                    <td className="py-2 pr-4 text-[var(--color-foreground)]">{methodLabel(event.method)}</td>
                    <td className="py-2 pr-4 text-[var(--color-foreground)]">{maskIdentifier(event.identifier)}</td>
                    <td className="py-2 pr-4">
                      <Badge variant={event.success ? "success" : "error"}>{event.success ? "Success" : "Failed"}</Badge>
                    </td>
                    <td className="py-2 pr-4 text-[var(--color-muted-foreground)]">{event.ipAddress}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
