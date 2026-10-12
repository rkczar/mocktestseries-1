"use client";

import { usePathname } from "next/navigation";
import { isBgExcludedPath } from "@/lib/background-effects-scope";

/**
 * Last line of protection for the decorative layer: whatever scope the admin
 * picked, it never mounts on the Test Player / result / review, OMR,
 * payment checkout, Live CBT or Admin routes (lib/background-effects-scope.ts).
 * A client component because the Student Dashboard layout does not re-render
 * on client-side navigation (e.g. dashboard → /student/checkout).
 */
export function BackgroundScopeGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return pathname && isBgExcludedPath(pathname) ? null : children;
}
