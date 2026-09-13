import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-button)] text-sm font-medium tracking-[-0.01em] transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]",
  {
    variants: {
      variant: {
        primary: "bg-[var(--color-action-fill)] text-[var(--color-action-ink)] shadow-[0_1px_4px_rgba(0,0,0,0.1),0_0_1px_rgba(0,0,0,0.1)] hover:opacity-90",
        secondary:
          "bg-[color-mix(in_srgb,var(--color-foreground)_8%,transparent)] text-[var(--color-foreground)] hover:bg-[color-mix(in_srgb,var(--color-foreground)_14%,transparent)]",
        outline: "border border-[var(--color-border)] bg-transparent text-[var(--color-foreground)] hover:bg-[color-mix(in_srgb,var(--color-foreground)_6%,transparent)]",
        ghost: "bg-transparent text-[var(--color-muted-foreground)] hover:bg-[color-mix(in_srgb,var(--color-foreground)_6%,transparent)] hover:text-[var(--color-foreground)]",
        danger: "bg-[var(--color-error)] text-[#1a1a1a] hover:opacity-90",
        success: "bg-[var(--color-success)] text-[#1a1a1a] hover:opacity-90",
        cta: "bg-[var(--color-action-fill)] text-[var(--color-action-ink)] shadow-[0_1px_4px_rgba(0,0,0,0.1),0_0_1px_rgba(0,0,0,0.1)] hover:opacity-90",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        default: "h-10 px-4",
        lg: "h-12 px-6 text-base",
        icon: "h-9 w-9",
        compact: "h-7 px-2 text-xs",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";
