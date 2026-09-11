import { cn } from "@/lib/utils";

const toneClasses = {
  success: "text-success-text bg-success-tint border-success-border",
  accent: "text-brand-accent-text bg-brand-accent-tint border-brand-accent-border",
  neutral: "text-text-faint bg-background border-border",
} as const;

const dotClasses = {
  success: "bg-success",
  accent: "bg-brand-accent",
  neutral: "bg-text-faint",
} as const;

export function StatusBadge({
  tone = "neutral",
  dot = false,
  className,
  children,
}: {
  tone?: keyof typeof toneClasses;
  dot?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-semibold tracking-[.07em] uppercase",
        toneClasses[tone],
        className,
      )}
    >
      {dot ? <span className={cn("size-1.5 rounded-full", dotClasses[tone])} /> : null}
      {children}
    </span>
  );
}
