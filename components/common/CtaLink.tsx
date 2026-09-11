import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils";

const variantClasses = {
  primary: "bg-primary text-primary-foreground hover:bg-primary-hover",
  secondary: "bg-surface border border-border-strong text-primary hover:bg-accent",
  accent: "bg-brand-accent text-white hover:bg-brand-accent-hover",
  ghost: "border border-panel-border text-white hover:bg-primary-hover",
} as const;

// Radius is a CSS var (--radius-button) so it inherits the admin-configured value from
// /admin/appearance instead of a hard-coded pixel size — see app/layout.tsx.
const sizeClasses = {
  sm: "gap-2 rounded-[var(--radius-button)] px-4 py-2.5 text-[14.5px] font-bold",
  lg: "gap-2.5 rounded-[var(--radius-button)] px-6 py-[15px] text-base font-bold",
} as const;

export function CtaLink({
  href,
  variant = "primary",
  size = "lg",
  icon = false,
  className,
  children,
}: {
  href: string;
  variant?: keyof typeof variantClasses;
  size?: keyof typeof sizeClasses;
  icon?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap transition-colors duration-150",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
    >
      {children}
      {icon ? <ArrowRight className="size-[17px]" strokeWidth={2.2} /> : null}
    </Link>
  );
}
