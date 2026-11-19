"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * SYSTEM CLOCK dashboard card: live IST and UTC.
 * The instant comes from the server (epoch ms, timezone-free); the browser only measures elapsed time, so a wrong
 * browser clock or browser timezone never changes what is shown. Each zone is formatted with an explicit IANA zone.
 */
const ZONES = [
  { key: "ist", label: "IST", name: "Indian Standard Time", zone: "Asia/Kolkata", offset: "UTC+05:30" },
  { key: "utc", label: "UTC", name: "Coordinated Universal Time", zone: "UTC", offset: "UTC+00:00" },
] as const;

const fmt = (zone: string) => ({
  time: new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }),
  date: new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "2-digit", month: "short", year: "numeric" }),
});
const FORMATS = Object.fromEntries(ZONES.map((z) => [z.key, fmt(z.zone)]));

export function formatClock(ms: number, zone: "ist" | "utc"): { time: string; date: string } {
  const d = new Date(ms);
  return { time: FORMATS[zone].time.format(d), date: FORMATS[zone].date.format(d) };
}

export function SystemClock({ serverNowMs }: { serverNowMs: number }) {
  // First render (server and hydration) uses the server instant exactly, so the markup matches.
  const [now, setNow] = useState(serverNowMs);
  useEffect(() => {
    // Server minus browser at mount; network delay of the page response (well under a second) is the only error.
    // shortcut: no periodic re-sync with the server; a browser clock changed while the page is open shifts the display — re-sync if that matters.
    const skew = serverNowMs - Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const t = Date.now() + skew;
      setNow(t);
      timer = setTimeout(tick, 1000 - (t % 1000) + 5); // align to the next whole second
    };
    tick();
    return () => clearTimeout(timer);
  }, [serverNowMs]);

  return (
    <Card data-testid="system-clock">
      <CardHeader className="flex-row items-center justify-between gap-2 pb-1">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">System Clock</CardTitle>
        <Clock className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden />
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ZONES.map((z) => {
          const c = formatClock(now, z.key);
          return (
            <div key={z.key} className="min-w-0 rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 py-2" data-testid={`clock-${z.key}`} data-zone={z.zone}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-[var(--color-foreground)]">{z.label}</span>
                <span className="text-[11px] text-[var(--color-muted-foreground)]">{z.offset}</span>
              </div>
              <p className="mt-0.5 font-mono text-2xl font-semibold tabular-nums text-[var(--color-foreground)]" data-testid={`clock-${z.key}-time`} aria-live="off">
                {c.time}
              </p>
              <p className="text-xs text-[var(--color-muted-foreground)]" data-testid={`clock-${z.key}-date`}>{c.date}</p>
              <p className="truncate text-[11px] text-[var(--color-muted-foreground)]">
                {z.name} · {z.zone}
              </p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
