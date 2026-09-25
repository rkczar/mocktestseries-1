"use client";

import { useOptimistic, useTransition } from "react";
import Link from "next/link";
import { Megaphone, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { dismissAnnouncementAction } from "../actions";

export interface DashboardAnnouncement {
  id: string;
  title: string;
  message: string;
  priority: string;
  ctaLabel: string | null;
  ctaRoute: string | null;
}

/** Dashboard announcements, each closable (X) per student — persisted server-side, not just hidden in state. */
export function DashboardAnnouncements({ announcements }: { announcements: DashboardAnnouncement[] }) {
  const [visible, hide] = useOptimistic(announcements, (list, id: string) => list.filter((a) => a.id !== id));
  const [, startTransition] = useTransition();

  if (visible.length === 0) return null;

  return (
    <section aria-label="Announcements" className="flex flex-col gap-3">
      {visible.map((a) => (
        <Card key={a.id} className={a.priority === "IMPORTANT" ? "border-[var(--color-warning)]/50" : undefined}>
          <CardContent className="flex items-start gap-3 pt-5">
            <Megaphone className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-[var(--color-foreground)]">{a.title}</p>
                  {a.priority === "IMPORTANT" ? <Badge variant="warning">Important</Badge> : null}
                </div>
                <p className="break-words text-sm text-[var(--color-muted-foreground)]">{a.message}</p>
              </div>
              {a.ctaRoute && a.ctaLabel ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={a.ctaRoute}>{a.ctaLabel}</Link>
                </Button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() =>
                startTransition(async () => {
                  hide(a.id);
                  await dismissAnnouncementAction(a.id);
                })
              }
              aria-label={`Dismiss announcement: ${a.title}`}
              title="Dismiss"
              className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-foreground)]"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}
