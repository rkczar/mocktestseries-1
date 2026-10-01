import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import {
  getPlatformControls,
  effectivePlatformControls,
  DEFAULT_PUBLIC_MESSAGES,
  DEFAULT_MAINTENANCE_MESSAGE,
  type ChangeMeta,
  type EffectivePlatformControls,
  type PausableControl,
} from "@/lib/platform-controls";
import { reasonRequired } from "@/lib/platform-controls-admin";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { PlatformStatusStrip } from "@/components/admin/platform-status-strip";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ControlForm } from "./control-form";

export const metadata = { title: "Platform Controls — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

const PAUSABLE: { group: string; control: PausableControl; label: string; explain: string; effectiveKey: keyof EffectivePlatformControls }[] = [
  {
    group: "Access",
    control: "registrations",
    label: "New Registrations",
    effectiveKey: "registrationsOpen",
    explain: "Paused: no new student accounts through password, mobile OTP or Google. Existing students can still log in.",
  },
  {
    group: "Access",
    control: "login",
    label: "Student Login",
    effectiveKey: "loginOpen",
    explain: "Paused: no NEW student sign-ins (also stops registration). Students already signed in stay signed in. Admin login is never affected.",
  },
  {
    group: "Commerce",
    control: "payments",
    label: "New Payments",
    effectiveKey: "paymentsOpen",
    explain:
      "Paused: no new checkout orders. Payments already started still verify, webhooks, invoices and entitlements keep working, and paid access continues. Global Payment Mode stays PAID.",
  },
  {
    group: "Testing",
    control: "tests",
    label: "Start New Tests",
    effectiveKey: "testsOpen",
    explain: "Paused: no new test attempts. Tests already in progress still save, submit and auto-submit normally.",
  },
  {
    group: "AI",
    control: "ai",
    label: "AI Services",
    effectiveKey: "aiOpen",
    explain: "Paused: no new AI generation calls. Explanations and practice variants already generated stay visible.",
  },
];

const IST: Intl.DateTimeFormatOptions = { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" };
const fmt = (iso: string | Date | null) => (iso ? `${new Date(iso).toLocaleString("en-IN", IST)} IST` : null);

function LastChanged({ meta, reason }: { meta: ChangeMeta; reason: string | null }) {
  const when = fmt(meta.updatedAt);
  return (
    <p className="text-xs text-[var(--color-muted-foreground)]">
      {when ? (
        <>
          Last changed {when}
          {meta.updatedByName ? ` by ${meta.updatedByName}` : ""}
          {reason ? <> · Reason: “{reason}”</> : null}
        </>
      ) : (
        "Never changed — default state."
      )}
    </p>
  );
}

function StateBadge({ on, onLabel, offLabel, onTone, offTone }: { on: boolean; onLabel: string; offLabel: string; onTone: "success" | "warning" | "error"; offTone: "success" | "warning" | "error" }) {
  return <Badge variant={on ? onTone : offTone}>{on ? onLabel : offLabel}</Badge>;
}

export default async function PlatformControlsPage() {
  const session = await getAdminSession();
  const perms = session?.user?.permissions ?? [];
  if (!perms.includes(PERMISSIONS.PLATFORM_CONTROLS_VIEW)) return <RestrictedCard title="Platform Controls" />;
  const canManage = perms.includes(PERMISSIONS.PLATFORM_CONTROLS_MANAGE);

  const [state, logs] = await Promise.all([
    getPlatformControls(),
    prisma.auditLog.findMany({
      where: { entityType: "PlatformControl" },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, entityId: true, metadata: true, createdAt: true, actor: { select: { name: true } } },
    }),
  ]);
  const eff = effectivePlatformControls(state);

  // Reason of the most recent change per control, from the existing AuditLog.
  const lastReason = new Map<string, string | null>();
  for (const l of logs) {
    if (l.entityId && !lastReason.has(l.entityId)) lastReason.set(l.entityId, ((l.metadata as { reason?: string | null } | null)?.reason ?? null) || null);
  }
  const needsReason = (change: Parameters<typeof reasonRequired>[0]) => reasonRequired(change, state);
  const overriddenBy = eff.lockdownActive ? "Emergency Lockdown" : eff.maintenanceOn ? "Maintenance Mode" : null;

  const groups = [...new Set(PAUSABLE.map((p) => p.group))];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Platform Controls</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Pause parts of the platform during an incident or maintenance. Every switch is enforced on the server. Pausing never deletes data and never
          changes payment mode, orders, entitlements or test attempts.
          {canManage ? "" : " You have read-only access — only Master Admin can change these."}
        </p>
        <PlatformStatusStrip />
      </div>

      {eff.lockdownActive || eff.lockdownExpired ? (
        <Card className="border-[var(--color-error)]/50">
          <CardContent className="py-3 text-sm text-[var(--color-error)]">
            {eff.lockdownActive
              ? `Emergency Lockdown is ACTIVE${state.lockdown.until ? ` until ${fmt(state.lockdown.until)}` : " until manually ended"}. Registration, login, new payments, new tests and AI are paused. Individual settings below are kept and return when lockdown ends.`
              : `Emergency Lockdown expired at ${fmt(state.lockdown.until)} and is no longer enforced. End it below to clear the record.`}
          </CardContent>
        </Card>
      ) : null}

      {groups.map((group) => (
        <section key={group} className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">{group}</h2>
          {PAUSABLE.filter((p) => p.group === group).map((p) => {
            const configured = state[p.control];
            const effectiveOpen = eff[p.effectiveKey] === true;
            const why = !effectiveOpen && configured.open ? (overriddenBy ?? (p.control === "registrations" && !eff.loginOpen ? "Student Login paused" : null)) : null;
            return (
              <Card key={p.control}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    {p.label}
                    <StateBadge on={configured.open} onLabel="OPEN" offLabel="PAUSED" onTone="success" offTone="warning" />
                    {why ? <Badge variant={eff.lockdownActive ? "error" : "warning"}>Effectively PAUSED by {why}</Badge> : null}
                  </CardTitle>
                  <CardDescription>{p.explain}</CardDescription>
                  <LastChanged meta={configured} reason={lastReason.get(p.control) ?? null} />
                </CardHeader>
                <CardContent>
                  <ControlForm
                    control={p.control}
                    kind="pausable"
                    active={configured.open}
                    label={p.label}
                    readOnly={!canManage}
                    reasonRequired={needsReason({ control: p.control, open: !configured.open })}
                    defaults={{ message: configured.message, messagePlaceholder: DEFAULT_PUBLIC_MESSAGES[p.control] }}
                  />
                </CardContent>
              </Card>
            );
          })}
        </section>
      ))}

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">Operations</h2>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              Maintenance Mode
              <StateBadge on={state.maintenance.on} onLabel="ON" offLabel="OFF" onTone="warning" offTone="success" />
            </CardTitle>
            <CardDescription>
              ON: visitors and students see a maintenance page (HTTP 503, not indexed). Admin, the health check, Razorpay webhooks, checkout verification,
              invoices and tests already in progress keep working. New registrations, logins, payments, test starts and AI are paused.
            </CardDescription>
            <LastChanged meta={state.maintenance} reason={lastReason.get("maintenance") ?? null} />
          </CardHeader>
          <CardContent>
            <ControlForm
              control="maintenance"
              kind="maintenance"
              active={state.maintenance.on}
              label="Maintenance Mode"
              readOnly={!canManage}
              reasonRequired={needsReason({ control: "maintenance", on: !state.maintenance.on })}
              defaults={{ title: state.maintenance.title, message: state.maintenance.message, eta: state.maintenance.eta, messagePlaceholder: DEFAULT_MAINTENANCE_MESSAGE }}
            />
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-error)]">Emergency</h2>
        <Card className="border-[var(--color-error)]/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              Emergency Lockdown
              <StateBadge on={eff.lockdownActive} onLabel="ON" offLabel="OFF" onTone="error" offTone="success" />
            </CardTitle>
            <CardDescription>
              ON: pauses registration, student login, new payments, new test starts and AI in one step, without changing the individual settings above —
              ending lockdown restores exactly what was configured. Signed-in students, tests in progress, payments already started and existing paid
              access stay safe. Admin is never locked out.
            </CardDescription>
            <LastChanged meta={state.lockdown} reason={lastReason.get("lockdown") ?? null} />
          </CardHeader>
          <CardContent>
            <ControlForm
              control="lockdown"
              kind="lockdown"
              active={state.lockdown.on}
              label="Emergency Lockdown"
              readOnly={!canManage}
              reasonRequired={needsReason({ control: "lockdown", on: !state.lockdown.on })}
              defaults={{}}
            />
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Change history</CardTitle>
          <CardDescription>Latest 30 changes, from the audit log.</CardDescription>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No changes yet — every control is at its default.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-border)] text-sm">
              {logs.map((l) => {
                const m = (l.metadata ?? {}) as { previous?: Record<string, unknown>; next?: Record<string, unknown>; reason?: string | null };
                const describe = (s?: Record<string, unknown>) => (s ? ("open" in s ? (s.open ? "OPEN" : "PAUSED") : s.on ? "ON" : "OFF") : "—");
                return (
                  <li key={l.id} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:gap-3">
                    <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">{fmt(l.createdAt)}</span>
                    <span>
                      <span className="font-medium">{l.actor?.name ?? "System"}</span> · {l.entityId} {describe(m.previous)} → {describe(m.next)}
                      {m.reason ? <span className="text-[var(--color-muted-foreground)]"> · “{m.reason}”</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
