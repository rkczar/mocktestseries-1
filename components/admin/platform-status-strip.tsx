import Link from "next/link";
import { getPlatformControls, effectivePlatformControls } from "@/lib/platform-controls";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { cn } from "@/lib/utils";

type Tone = "ok" | "paused" | "lockdown";

const TONE: Record<Tone, string> = {
  ok: "border-[var(--color-success)]/40 bg-[var(--color-success)]/10 text-[var(--color-success)]",
  paused: "border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 text-[var(--color-warning)]",
  lockdown: "border-[var(--color-error)]/40 bg-[var(--color-error)]/10 text-[var(--color-error)]",
};

/**
 * Compact effective-state summary of Platform Controls (Admin dashboard +
 * the Platform Controls page). Green = open, amber = paused, red = paused
 * by Emergency Lockdown. Read-only; links to the controls page. Hidden
 * from roles without PLATFORM_CONTROLS_VIEW (TEACHER).
 */
export async function PlatformStatusStrip({ className }: { className?: string }) {
  if (!(await hasPermission(PERMISSIONS.PLATFORM_CONTROLS_VIEW))) return null;
  const eff = effectivePlatformControls(await getPlatformControls());
  const pausedTone: Tone = eff.lockdownActive ? "lockdown" : "paused";
  const item = (open: boolean) => ({ tone: open ? ("ok" as Tone) : pausedTone, text: open ? "Open" : "Paused" });
  const platformTone: Tone = eff.status === "LOCKDOWN" ? "lockdown" : eff.status === "LIVE" ? "ok" : "paused";
  const items: { label: string; tone: Tone; text: string }[] = [
    { label: "Platform", tone: platformTone, text: eff.status === "LIVE" ? "Live" : eff.status.charAt(0) + eff.status.slice(1).toLowerCase() },
    { label: "Registration", ...item(eff.registrationsOpen) },
    { label: "Login", ...item(eff.loginOpen) },
    { label: "Payments", ...item(eff.paymentsOpen) },
    { label: "Tests", ...item(eff.testsOpen) },
    { label: "AI", ...item(eff.aiOpen) },
  ];

  return (
    <Link
      href="/admin/system/platform-controls"
      aria-label="Platform status — open Platform Controls"
      className={cn("flex flex-wrap items-center gap-1.5 rounded-[var(--radius-card)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]", className)}
    >
      {items.map((i) => (
        <span key={i.label} className={cn("inline-flex items-center gap-1 rounded-[var(--radius-badge)] border px-2 py-0.5 text-[11px] font-medium", TONE[i.tone])}>
          <span className="text-[var(--color-muted-foreground)]">{i.label}</span>
          {i.text}
        </span>
      ))}
    </Link>
  );
}
