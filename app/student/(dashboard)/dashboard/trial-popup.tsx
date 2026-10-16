"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Crown, Sparkles, X as XIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { TrialPopupData } from "@/lib/premium-trial";
import { PREMIUM_LOCKED_EVENT } from "@/lib/plans-path";
import { claimTrialPopupAction, startTrialAction } from "./trial-actions";

/** "1 Day 14 Hours Remaining" / "5 Hours 12 Minutes Remaining" / "12 Minutes Remaining". */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "Trial ended";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (days > 0) return `${part(days, "Day")} ${part(hours, "Hour")} Remaining`;
  if (hours > 0) return `${part(hours, "Hour")} ${part(minutes, "Minute")} Remaining`;
  return `${part(Math.max(1, minutes), "Minute")} Remaining`;
}

/**
 * Student Dashboard trial / upgrade popup. Never rendered for paid Premium
 * students or while enforcement is OFF — the server returns null then.
 * The countdown is anchored to the SERVER clock (serverNow), so a wrong
 * device clock can't change what the student sees.
 */
export function TrialPopup({ force }: { force: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<TrialPopupData | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [now, setNow] = useState(() => Date.now());
  const skew = useRef(0);
  const asked = useRef(false);

  // `forced` = the student asked for their options (a Premium Unlock). The
  // server answers with a redirect when it has no trial to offer them, so an
  // Unlock click never does nothing.
  const claim = useCallback(
    (forced: boolean) => {
      claimTrialPopupAction(forced)
        .then((d) => {
          if (!d) return;
          if ("redirect" in d) {
            router.push(d.redirect);
            return;
          }
          skew.current = new Date(d.serverNow).getTime() - Date.now();
          setNow(Date.now() + skew.current);
          setData(d);
          setOpen(true);
        })
        .catch(() => undefined);
    },
    [router]
  );

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    claim(force);
  }, [force, claim]);

  // An Unlock click on the dashboard itself (already at ?premium=locked or not) re-opens it.
  useEffect(() => {
    const onLocked = () => claim(true);
    window.addEventListener(PREMIUM_LOCKED_EVENT, onLocked);
    return () => window.removeEventListener(PREMIUM_LOCKED_EVENT, onLocked);
  }, [claim]);

  const ticking = open && data?.endsAt && (data.state === "ACTIVE" || data.state === "ENDING");
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now() + skew.current), 30_000);
    return () => clearInterval(id);
  }, [ticking]);

  if (!data) return null;
  const remaining = data.endsAt ? new Date(data.endsAt).getTime() - now : 0;

  const startTrial = () => {
    setError(null);
    startTransition(async () => {
      try {
        const r = await startTrialAction();
        if (!r.ok) {
          setError(r.message);
          return;
        }
        setData({ ...data, state: "ACTIVE", endsAt: r.endsAt });
        router.refresh();
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  const close = () => setOpen(false);
  const buy = (label: string, primary = true) => (
    <Button asChild variant={primary ? "primary" : "outline"} className="w-full sm:w-auto" data-autofocus={primary ? "" : undefined}>
      <Link href={data.buyHref}>
        <Crown className="h-4 w-4" aria-hidden /> {label}
      </Link>
    </Button>
  );

  const copy = {
    WELCOME: {
      title: "Unlock Your 2-Day FREE Premium Trial",
      text: `Explore Premium PYQs, Mock Tests, Subject Tests and more for ${data.trialHours} hours.`,
    },
    ACTIVE: { title: "Your Premium Trial Is Active!", text: formatRemaining(remaining) },
    ENDING: { title: "Your Free Trial Ends Soon!", text: formatRemaining(remaining) },
    EXPIRED: { title: "Your Premium Trial Has Ended", text: "Your free tests, analytics and previous results are still available." },
  }[data.state];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
        data-testid="trial-popup"
        data-state-kind={data.state}
        // Focus the main action (not "Continue Free") when the popup opens.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-autofocus]")?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6 text-lg">
            <Sparkles className="h-5 w-5 shrink-0 text-[var(--color-primary)]" aria-hidden />
            {copy.title}
          </DialogTitle>
          <DialogDescription data-testid="trial-popup-text">{copy.text}</DialogDescription>
        </DialogHeader>

        {data.state === "WELCOME" ? <Comparison data={data} /> : null}
        {data.state === "EXPIRED" ? <FreeList items={data.free} /> : null}

        {error ? (
          <p className="mt-3 text-sm text-[var(--color-error)]" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          {data.state === "WELCOME" ? (
            <>
              <Button variant="ghost" onClick={close} className="w-full sm:w-auto">
                Continue Free
              </Button>
              {buy("Buy Premium Now", false)}
              <Button variant="cta" onClick={startTrial} disabled={pending} className="w-full sm:w-auto" data-testid="start-trial" data-autofocus="">
                {pending ? "Starting…" : "Start 2-Day Free Trial"}
              </Button>
            </>
          ) : data.state === "EXPIRED" ? (
            <>
              <Button variant="ghost" onClick={close} className="w-full sm:w-auto">
                Continue Free
              </Button>
              {buy("Buy Premium")}
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={close} className="w-full sm:w-auto">
                Continue Practicing
              </Button>
              {buy(data.state === "ENDING" ? "Buy Premium" : "Upgrade to Premium")}
            </>
          )}
        </div>
        {data.priceLabel && data.state !== "ACTIVE" ? (
          <p className="mt-2 text-right text-xs text-[var(--color-muted-foreground)]">Premium: {data.priceLabel}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function FreeList({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {items.map((f) => (
        <li key={f} className="flex items-start gap-2">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden /> <span>{f}</span>
        </li>
      ))}
    </ul>
  );
}

/** Compact FREE FOREVER | 2-DAY TRIAL | PREMIUM comparison. */
function Comparison({ data }: { data: TrialPopupData }) {
  const yes = <Check className="mx-auto h-4 w-4 text-[var(--color-success)]" aria-label="Included" />;
  const no = <XIcon className="mx-auto h-4 w-4 text-[var(--color-muted-foreground)]" aria-label="Not included" />;
  const rows: { label: string; free: boolean; trial: boolean; premium: boolean }[] = [
    { label: "Selected free PYQ, Mock & Subject Test", free: true, trial: true, premium: true },
    { label: "Analytics, history & previous results", free: true, trial: true, premium: true },
    ...data.premium.map((label) => ({ label, free: false, trial: true, premium: true })),
  ];
  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)]">
      <table className="w-full text-xs sm:text-sm">
        <thead className="bg-[color-mix(in_srgb,var(--color-foreground)_5%,transparent)]">
          <tr>
            <th className="px-2 py-2 text-left font-medium">Feature</th>
            <th className="px-1 py-2 text-center font-semibold">FREE FOREVER</th>
            <th className="px-1 py-2 text-center font-semibold">{data.trialHours === 48 ? "2-DAY TRIAL" : `${data.trialHours}-HOUR TRIAL`}</th>
            <th className="px-1 py-2 text-center font-semibold">PREMIUM</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-[var(--color-border)]">
              <td className="px-2 py-1.5">{r.label}</td>
              <td className="px-1 py-1.5">{r.free ? yes : no}</td>
              <td className="px-1 py-1.5">{r.trial ? yes : no}</td>
              <td className="px-1 py-1.5">{r.premium ? yes : no}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
