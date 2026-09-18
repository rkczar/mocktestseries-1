import Link from "next/link";
import { cn } from "@/lib/utils";
import { BRAND_NAME } from "@/lib/brand";

/**
 * Canonical site wordmark. Text only — no image, icon, or inline SVG artwork.
 * Inherits typography and color from the Universal Design / Appearance
 * system (`--font-heading`, `--color-foreground`) so it follows the active
 * theme (light / dark / eye-saver) automatically. Pass `className` to
 * override size or color for contexts with a fixed (non-themed) background,
 * such as the student login canvas.
 */
const SIZE_CLASSES = {
  sm: "text-sm sm:text-base",
  md: "text-base sm:text-lg",
  lg: "text-lg sm:text-xl",
  xl: "text-xl sm:text-2xl",
} as const;

export type BrandLogoSize = keyof typeof SIZE_CLASSES;

export function BrandLogo({
  size = "md",
  href = "/",
  className,
}: {
  size?: BrandLogoSize;
  href?: string | null;
  className?: string;
}) {
  const mark = (
    <span
      className={cn(
        "inline-flex shrink-0 items-baseline whitespace-nowrap font-bold leading-none tracking-tight text-[var(--color-foreground)]",
        SIZE_CLASSES[size],
        className
      )}
      style={{ fontFamily: "var(--font-heading)" }}
    >
      {BRAND_NAME}
      <sup className="ml-0.5 text-[0.5em] font-semibold">™</sup>
    </span>
  );

  if (!href) return mark;

  return (
    <Link href={href} aria-label="MockTestSeries.in — Home" className="inline-flex shrink-0 items-baseline">
      {mark}
    </Link>
  );
}
