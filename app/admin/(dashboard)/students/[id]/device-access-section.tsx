import { LogOut, RotateCcw, ShieldOff } from "lucide-react";
import type { DeviceSecurityEventType } from "@prisma/client";
import { getStudentDeviceOverview, type DeviceSecurityStatus } from "@/lib/student-devices";
import { formatIst } from "@/lib/ist-time";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConfirmActionDialog } from "@/components/security/confirm-action-dialog";
import {
  adminLogoutAllAction,
  adminLogoutSessionAction,
  adminResetDeviceLimitAction,
  adminRevokeDeviceAction,
} from "./device-actions";

export const STATUS_BADGE: Record<DeviceSecurityStatus, { label: string; variant: "success" | "warning" | "error" }> = {
  NORMAL: { label: "Normal", variant: "success" },
  LIMIT_REACHED: { label: "Limit Reached", variant: "warning" },
  SUSPICIOUS: { label: "Suspicious", variant: "error" },
};

const EVENT_LABEL: Record<DeviceSecurityEventType, string> = {
  DEVICE_REGISTERED: "Device registered",
  LOGIN_SUCCESS: "Signed in",
  DEVICE_LIMIT_REACHED: "Blocked: device limit reached",
  SESSION_REVOKED: "Session logged out",
  DEVICE_REMOVED: "Device revoked",
  ADMIN_DEVICE_RESET: "Device limit reset by admin",
  LOGOUT_ALL: "Logged out of all devices",
  SUSPICIOUS_DEVICE_ACTIVITY: "Suspicious activity",
  TEST_DEVICE_CONFLICT: "Test opened on a second device",
};

function metaText(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object") return "";
  const m = metadata as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof m.method === "string") parts.push(m.method);
  if (typeof m.device === "string") parts.push(m.device);
  if (typeof m.reason === "string") parts.push(m.reason.replace(/_/g, " ").toLowerCase());
  if (typeof m.by === "string" && m.by !== "ADMIN") parts.push(`by ${m.by.toLowerCase()}`);
  if (typeof m.devicesRevoked === "number") parts.push(`${m.devicesRevoked} device(s) revoked`);
  if (typeof m.sessionsRevoked === "number") parts.push(`${m.sessionsRevoked} session(s) ended`);
  return parts.join(" · ");
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase text-[var(--color-muted-foreground)]">{label}</p>
      <div className="text-[var(--color-foreground)]">{children}</div>
    </div>
  );
}

/** Admin → Students → Student: DEVICE ACCESS (lib/student-devices.ts). */
export async function DeviceAccessSection({ studentId, canManage }: { studentId: string; canManage: boolean }) {
  const o = await getStudentDeviceOverview(studentId);
  const status = STATUS_BADGE[o.status];
  const full = o.registered >= o.limit;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Device Access</CardTitle>
            <CardDescription>
              Registered devices hold the student&apos;s sign-in slots. Revoking signs that device out immediately.
              {o.settings.enabled ? "" : " Device limit enforcement is currently OFF in Security Settings."}
            </CardDescription>
          </div>
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <ConfirmActionDialog
                trigger={
                  <>
                    <LogOut className="h-4 w-4" aria-hidden /> Log Out All Devices
                  </>
                }
                title="Log out all devices?"
                description={
                  <p>
                    Every session of this student is signed out now, including older sessions. Registered devices keep
                    their slots, so the student can sign in again on them. Saved test answers are not affected.
                  </p>
                }
                confirmLabel="Log out all"
                onConfirm={adminLogoutAllAction.bind(null, studentId)}
              />
              {o.settings.allowAdminReset ? (
                <ConfirmActionDialog
                  triggerVariant="danger"
                  trigger={
                    <>
                      <RotateCcw className="h-4 w-4" aria-hidden /> Reset Device Limit
                    </>
                  }
                  title="Reset device limit?"
                  description={
                    <>
                      <p>
                        All {o.registered} registered device(s) are revoked and every session is signed out. The student
                        can then register up to {o.limit} new devices on their next sign-in.
                      </p>
                      <p>Saved test answers are kept. This is recorded in the audit log with your name.</p>
                    </>
                  }
                  confirmLabel="Reset device limit"
                  onConfirm={adminResetDeviceLimitAction.bind(null, studentId)}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Stat label="Device Limit">{o.limit}</Stat>
          <Stat label="Registered">
            <span className="inline-flex items-center gap-2">
              {o.registered}
              {full ? <Badge variant="warning">{o.registered}/{o.limit} Devices</Badge> : null}
            </span>
          </Stat>
          <Stat label="Active Sessions">{o.activeSessions}</Stat>
          <Stat label="Status">
            <Badge variant={status.variant}>{status.label}</Badge>
          </Stat>
        </div>
        {o.resetAt ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">Last device reset: {formatIst(o.resetAt)}</p>
        ) : null}

        <div className="overflow-x-auto">
          {o.devices.length === 0 ? (
            <p className="py-4 text-center text-sm text-[var(--color-muted-foreground)]">
              No devices yet. Devices register on the student&apos;s next sign-in.
            </p>
          ) : (
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Device</th>
                  <th className="py-2 pr-4">Browser</th>
                  <th className="py-2 pr-4">OS</th>
                  <th className="py-2 pr-4">First Seen</th>
                  <th className="py-2 pr-4">Last Active</th>
                  <th className="py-2 pr-4">Last Login</th>
                  <th className="py-2 pr-4">Status</th>
                  {canManage ? <th className="py-2 pr-4">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {o.devices.map((d) => (
                  <tr key={d.id} className="border-b border-[var(--color-border)] align-top last:border-0">
                    <td className="py-2.5 pr-4">
                      <p className="text-[var(--color-foreground)]">{d.displayName}</p>
                      <p className="text-xs text-[var(--color-muted-foreground)]">
                        {d.deviceType.toLowerCase()}
                        {d.lastIpMasked ? ` · IP ${d.lastIpMasked}` : ""}
                        {d.registeredVia === "LEGACY_SESSION" ? " · registered from existing session" : ""}
                      </p>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{d.browser ?? "—"}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{d.os ?? "—"}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{formatIst(d.firstSeenAt)}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{formatIst(d.lastSeenAt)}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{d.lastLoginAt ? formatIst(d.lastLoginAt) : "—"}</td>
                    <td className="py-2.5 pr-4">
                      <div className="flex flex-wrap gap-1">
                        {d.active ? (
                          <Badge variant={d.sessions.length > 0 ? "success" : "neutral"}>
                            {d.sessions.length > 0 ? `Active · ${d.sessions.length} session` : "Registered"}
                          </Badge>
                        ) : (
                          <Badge variant="error">Revoked</Badge>
                        )}
                        {d.hasTestInProgress ? <Badge variant="info">Test In Progress</Badge> : null}
                      </div>
                      {!d.active && d.revokedAt ? (
                        <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                          {formatIst(d.revokedAt)}
                          {d.revokedByAdmin ? ` by ${d.revokedByAdmin.name}` : ""}
                          {d.revokeReason ? ` (${d.revokeReason.replace(/_/g, " ").toLowerCase()})` : ""}
                        </p>
                      ) : null}
                    </td>
                    {canManage ? (
                      <td className="py-2.5 pr-4">
                        {d.active ? (
                          <div className="flex flex-wrap gap-1.5">
                            {d.sessions.map((sess) => (
                              <ConfirmActionDialog
                                key={sess.id}
                                trigger={
                                  <>
                                    <LogOut className="h-4 w-4" aria-hidden /> Log Out Session
                                  </>
                                }
                                title="Log out this session?"
                                description={
                                  <>
                                    <p>
                                      Signs {d.displayName} out (signed in {formatIst(sess.createdAt)} via {sess.method}). The
                                      device stays registered.
                                    </p>
                                    {d.hasTestInProgress ? <p>A test is in progress on this device; its saved answers are kept.</p> : null}
                                  </>
                                }
                                confirmLabel="Log out session"
                                onConfirm={adminLogoutSessionAction.bind(null, studentId, sess.id)}
                              />
                            ))}
                            <ConfirmActionDialog
                              triggerVariant="danger"
                              trigger={
                                <>
                                  <ShieldOff className="h-4 w-4" aria-hidden /> Revoke Device
                                </>
                              }
                              title="Revoke this device?"
                              description={
                                <>
                                  <p>
                                    {d.displayName} is signed out and loses its device slot. Signing in again from it
                                    counts as a new device.
                                  </p>
                                  {d.hasTestInProgress ? <p>A test is in progress on this device; its saved answers are kept.</p> : null}
                                </>
                              }
                              confirmLabel="Revoke device"
                              onConfirm={adminRevokeDeviceAction.bind(null, studentId, d.id)}
                            />
                          </div>
                        ) : (
                          <span className="text-xs text-[var(--color-muted-foreground)]">—</span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div>
          <p className="mb-2 text-xs font-medium uppercase text-[var(--color-muted-foreground)]">Security Events</p>
          {o.events.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No device events yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-border)] text-sm">
              {o.events.map((e) => (
                <li key={e.id} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-[var(--color-foreground)]">
                    {EVENT_LABEL[e.eventType]}
                    {e.actorAdmin ? <span className="text-[var(--color-muted-foreground)]"> · by {e.actorAdmin.name}</span> : null}
                    {metaText(e.metadata) ? (
                      <span className="text-[var(--color-muted-foreground)]"> · {metaText(e.metadata)}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">{formatIst(e.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
