import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { StatCard } from "@/components/admin/stat-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getDeviceMonitoringData } from "@/lib/student-devices";
import { formatIst } from "@/lib/ist-time";
import { maskEmail, maskPhone } from "@/lib/pii-mask";
import { DeviceMonitoringTable, type DeviceMonitoringRow } from "./device-monitoring-table";
import { getMultipleSessions } from "@/lib/admin-dashboard-metrics";

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
    case "DEVICE_LIMIT":
      return "Device Limit Block";
    default:
      return method ?? "Unknown";
  }
}

/** Kept outside the component: computing "now" is an impure call components/hooks must not make directly during render. */
async function loadAuthMonitoringData() {
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [total, successful, byMethod, recent, devices] = await Promise.all([
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
    getDeviceMonitoringData(),
  ]);

  return { total, successful, byMethod, recent, devices };
}

export default async function AuthenticationMonitoringPage() {
  const session = await getAdminSession();
  if (!session?.user?.permissions?.includes(PERMISSIONS.SETTINGS_MANAGE)) {
    return <RestrictedCard title="Authentication Monitoring" />;
  }

  const [{ total, successful, byMethod, recent, devices }, multi] = await Promise.all([loadAuthMonitoringData(), getMultipleSessions()]);
  const deviceRows: DeviceMonitoringRow[] = devices.rows.map((r) => ({
    ...r,
    lastLoginLabel: r.lastLoginAt ? formatIst(new Date(r.lastLoginAt)) : "Never",
    emailMasked: maskEmail(r.email),
    mobileMasked: maskPhone(r.mobile),
  }));

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
          <CardTitle>Student Device Monitoring</CardTitle>
          <CardDescription>
            Device limit {devices.limit} per student. Blocks, resets and suspicious activity come from the device security
            audit trail; open a student to revoke devices or reset their limit.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <StatCard label="Active Student Sessions" value={devices.summary.activeSessions} />
            <StatCard label="Registered Devices" value={devices.summary.registeredDevices} />
            <StatCard label="Device Limit Blocks Today" value={devices.summary.blocksToday} />
            <StatCard label="Suspicious Accounts" value={devices.summary.suspiciousAccounts} />
            <StatCard label="Device Resets Today" value={devices.summary.resetsToday} />
          </div>
          <DeviceMonitoringTable rows={deviceRows} limit={devices.limit} />
        </CardContent>
      </Card>

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

      <Card id="multiple-sessions" className="scroll-mt-20" data-testid="multiple-sessions">
        <CardHeader>
          <CardTitle>Multiple Active Sessions</CardTitle>
          <CardDescription>
            Students signed in on 2 or more sessions that each made an authenticated request in the last {multi.windowHours} hours (not revoked, not expired, device still registered). Login attempts are not
            sessions, and several tabs in one browser are one session. Sign-ins from before session tracking existed have no session record and are not counted. Display only — nothing here blocks an
            account; use the device controls above to act.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="2+ sessions" value={multi.twoPlus} />
            <StatCard label="3+ sessions" value={multi.threePlus} />
            <StatCard label="Highest" value={multi.highest || "—"} />
          </div>
          {multi.rows.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No student currently has more than one active session.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                    <th className="py-2 pr-4">Student ID</th>
                    <th className="py-2 pr-4">Name</th>
                    <th className="py-2 pr-4">Active sessions</th>
                    <th className="py-2 pr-4">Last activity</th>
                    <th className="py-2 pr-4">Sessions (device · method · signed in)</th>
                  </tr>
                </thead>
                <tbody>
                  {multi.rows.map((r) => (
                    <tr key={r.studentDbId} className="border-b border-[var(--color-border)] align-top last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">
                        <a href={`/admin/students/${r.studentDbId}`} className="text-[var(--color-primary)] hover:underline">
                          {r.studentId}
                        </a>
                      </td>
                      <td className="py-2 pr-4">{r.name}</td>
                      <td className="py-2 pr-4">
                        <Badge variant={r.activeSessions >= 3 ? "error" : "warning"}>{r.activeSessions}</Badge>
                      </td>
                      <td className="py-2 pr-4 text-[var(--color-muted-foreground)]">{formatIst(r.lastActivity)}</td>
                      <td className="py-2 pr-4 text-xs text-[var(--color-muted-foreground)]">
                        <ul className="flex flex-col gap-0.5">
                          {r.sessions.map((s, i) => (
                            <li key={i}>
                              {s.device}
                              {s.browser || s.os ? ` (${[s.browser, s.os].filter(Boolean).join(", ")})` : ""} · {methodLabel(s.method)} · signed in {formatIst(s.signedInAt)} · last seen {formatIst(s.lastSeenAt)}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
