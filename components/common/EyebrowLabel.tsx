import { cn } from "@/lib/utils";

export function EyebrowLabel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "font-mono text-[11.5px] font-semibold tracking-[.1em] text-brand-accent-text uppercase",
        className,
      )}
    >
      {children}
    </p>
  );
}
