"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * The recoverable error state every route segment's error.tsx renders, so an
 * unexpected failure never leaves a blank "This page couldn't load" screen.
 * Server errors arrive with only a digest (no message — Next strips it in
 * production); the digest is shown so a student can quote it to support and
 * it matches the `digest` in the PM2 error log.
 */
export function RouteError({
  error,
  retry,
  home,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  home: { href: string; label: string };
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[50vh] w-full max-w-lg flex-col items-center justify-center gap-4 px-4 py-12 text-center">
      <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Something went wrong</h1>
      <p className="text-sm text-[var(--color-muted-foreground)]">
        This page hit an unexpected problem. Your saved answers and progress are safe. Please try again — if it keeps
        happening, contact support{error.digest ? " and mention the reference below" : ""}.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={() => retry()}>Try again</Button>
        <Button asChild variant="outline">
          <Link href={home.href}>{home.label}</Link>
        </Button>
      </div>
      {error.digest ? <p className="text-xs text-[var(--color-muted-foreground)]">Reference: {error.digest}</p> : null}
    </div>
  );
}
