import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-button)] text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]",
  {
    variants: {
      variant: {
        primary: "bg-[var(--color-primary)] text-white hover:opacity-90",
        secondary: "bg-[var(--color-secondary)] text-white hover:opacity-90",
        outline: "border border-[var(--color-border)] bg-transparent text-[var(--color-foreground)] hover:bg-[var(--color-surface)]",
        ghost: "bg-transparent text-[var(--color-foreground)] hover:bg-[var(--color-surface)]",
        danger: "bg-[var(--color-error)] text-white hover:opacity-90",
        success: "bg-[var(--color-success)] text-white hover:opacity-90",
        cta: "bg-[var(--color-accent)] text-white hover:opacity-90 shadow-[var(--shadow-card)]",
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
