import { cn } from "@/lib/utils";

export function ImagePlaceholder({
  label = "exam icon / image",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-[10px] border border-[#E9EFF5] bg-[repeating-linear-gradient(135deg,#F2F6FA_0_8px,#FFFFFF_8px_16px)]",
        className,
      )}
    >
      {label ? (
        <span className="font-mono text-[11px] tracking-[.06em] text-text-placeholder">{label}</span>
      ) : null}
    </div>
  );
}
