"use client";

import { LogOut, Monitor, Smartphone, Tablet, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConfirmActionDialog } from "@/components/security/confirm-action-dialog";
import { logoutDeviceSessionAction, logoutOtherSessionsAction, removeOwnDeviceAction } from "./actions";

export interface StudentDeviceView {
  id: string;
  displayName: string;
  os: string | null;
  browser: string | null;
  deviceType: string;
  firstSeen: string;
  lastActive: string;
  active: boolean;
  current: boolean;
  hasTestInProgress: boolean;
  /** Open (signed-in) sessions on this device. */
  sessionIds: string[];
}

function DeviceIcon({ type }: { type: string }) {
  const Icon = type === "MOBILE" ? Smartphone : type === "TABLET" ? Tablet : Monitor;
  return <Icon className="h-5 w-5" aria-hidden />;
}

const TEST_WARNING = (
  <p className="text-[var(--color-warning)]">
    This device has a test in progress. Its saved answers are kept, but the test will stop saving on that device.
  </p>
);

export function DevicesCard({
  devices,
  registered,
  limit,
  selfRemoveEnabled,
  nextSelfRemoval,
  hasOtherSessions,
}: {
  devices: StudentDeviceView[];
  registered: number;
  limit: number;
  selfRemoveEnabled: boolean;
  nextSelfRemoval: string | null;
  hasOtherSessions: boolean;
}) {
  const full = registered >= limit;
  const otherHasTest = devices.some((d) => !d.current && d.hasTestInProgress);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Devices &amp; Security</CardTitle>
          <Badge variant={full ? "warning" : "neutral"}>
            {registered}/{limit} Devices
          </Badge>
        </div>
        <CardDescription>
          Registered Devices: {registered} / {limit}. Your account can be used on up to {limit} devices. A new device can
          only sign in while a slot is free
          {selfRemoveEnabled ? "." : " — contact support if you need to replace a device."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {devices.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            No devices registered yet. This device is registered the next time you sign in.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {devices.map((d) => (
              <li
                key={d.id}
                className="flex flex-col gap-3 rounded-[var(--radius-button)] border border-[var(--color-border)] p-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="flex min-w-0 gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-[var(--color-primary)]">
                    <DeviceIcon type={d.deviceType} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-sm font-medium text-[var(--color-foreground)]">{d.displayName}</p>
                      {d.current ? <Badge variant="primary">Current Device</Badge> : null}
                      {d.active ? (
                        d.sessionIds.length > 0 ? <Badge variant="success">Signed In</Badge> : <Badge variant="neutral">Signed Out</Badge>
                      ) : (
                        <Badge variant="error">Revoked</Badge>
                      )}
                      {d.hasTestInProgress ? <Badge variant="info">Test In Progress</Badge> : null}
                    </div>
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      {[d.os, d.browser].filter(Boolean).join(" · ") || "Unknown system"}
                    </p>
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      First registered {d.firstSeen} · Last active {d.lastActive}
                    </p>
                  </div>
                </div>
                {!d.current && d.active ? (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {d.sessionIds.length > 0 ? (
                      <ConfirmActionDialog
                        trigger={
                          <>
                            <LogOut className="h-4 w-4" aria-hidden /> Log out
                          </>
                        }
                        title="Log out this device?"
                        description={
                          <>
                            <p>{d.displayName} will be signed out. It stays registered to your account.</p>
                            {d.hasTestInProgress ? TEST_WARNING : null}
                          </>
                        }
                        confirmLabel="Log out device"
                        onConfirm={async () => {
                          let last = {};
                          for (const id of d.sessionIds) last = await logoutDeviceSessionAction(id);
                          return last;
                        }}
                      />
                    ) : null}
                    {selfRemoveEnabled ? (
                      <ConfirmActionDialog
                        trigger={
                          <>
                            <Trash2 className="h-4 w-4" aria-hidden /> Remove
                          </>
                        }
                        title="Remove this device?"
                        description={
                          <>
                            <p>
                              {d.displayName} will be signed out and removed, freeing one device slot. You can remove a
                              device only once in a while.
                            </p>
                            {nextSelfRemoval ? <p>Next removal available after {nextSelfRemoval}.</p> : null}
                            {d.hasTestInProgress ? TEST_WARNING : null}
                          </>
                        }
                        confirmLabel="Remove device"
                        onConfirm={() => removeOwnDeviceAction(d.id)}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {hasOtherSessions ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
            <p className="text-xs text-[var(--color-muted-foreground)]">Don&apos;t recognise a device? Sign it out and change your password.</p>
            <ConfirmActionDialog
              trigger={
                <>
                  <LogOut className="h-4 w-4" aria-hidden /> Log out all other devices
                </>
              }
              title="Log out all other devices?"
              description={
                <>
                  <p>Every other device will be signed out. This device stays signed in. Devices stay registered.</p>
                  {otherHasTest ? TEST_WARNING : null}
                </>
              }
              confirmLabel="Log out others"
              onConfirm={() => logoutOtherSessionsAction()}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
