import Link from "next/link";
import { ArrowRight, MoveRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * For a tab whose feature already lives somewhere else in the admin (e.g. the
 * Navigation/Footer tabs here are pre-built Phase-6 placeholders that
 * shadow the Header/Footer sections already editable in the Homepage
 * Builder). Points admins at the real editor instead of implying the
 * feature is unbuilt.
 */
export function AvailableElsewhere({
  title,
  message,
  linkHref,
  linkLabel,
}: {
  title: string;
  message: string;
  linkHref: string;
  linkLabel: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{title}</h1>
      </div>
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <MoveRight className="h-8 w-8 text-[var(--color-primary)]" aria-hidden />
          <p className="text-base font-medium text-[var(--color-foreground)]">Managed elsewhere</p>
          <p className="max-w-sm text-sm text-[var(--color-muted-foreground)]">{message}</p>
          <Link
            href={linkHref}
            className="mt-2 inline-flex items-center gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-surface)]"
          >
            {linkLabel}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
