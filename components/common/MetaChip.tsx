import { cn } from "@/lib/utils";

export function MetaChip({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <li
      className={cn(
        "rounded-[7px] border border-border bg-background px-2.5 py-1.5 text-[12.5px] font-semibold text-text-muted",
        className,
      )}
    >
      {children}
    </li>
  );
}
