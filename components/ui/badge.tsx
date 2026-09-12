import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        neutral: "bg-[var(--color-border)] text-[var(--color-foreground)]",
        primary: "bg-[var(--color-primary)]/15 text-[var(--color-primary)]",
        success: "bg-[var(--color-success)]/15 text-[var(--color-success)]",
        error: "bg-[var(--color-error)]/15 text-[var(--color-error)]",
        warning: "bg-[var(--color-warning)]/15 text-[var(--color-warning)]",
        info: "bg-[var(--color-info)]/15 text-[var(--color-info)]",
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
