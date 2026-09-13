import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-[var(--radius-badge)] border px-2 py-0.5 text-[11px] font-medium tracking-[0.02em]",
  {
    variants: {
      variant: {
        neutral: "border-[var(--color-border)] bg-transparent text-[var(--color-muted-foreground)]",
        primary: "border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10 text-[var(--color-primary)]",
        success: "border-[var(--color-success)]/40 bg-[var(--color-success)]/10 text-[var(--color-success)]",
        error: "border-[var(--color-error)]/40 bg-[var(--color-error)]/10 text-[var(--color-error)]",
        warning: "border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 text-[var(--color-warning)]",
        info: "border-[var(--color-info)]/40 bg-[var(--color-info)]/10 text-[var(--color-info)]",
      },
    },
    defaultVariants: { variant: "neutral" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
