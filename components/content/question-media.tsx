import type { AssetView } from "@/lib/rich-content-types";
import { cn } from "@/lib/utils";

/**
 * Ordered images of a RICH_V1 question (question figures, one option's
 * images, or explanation diagrams). Width/height are reserved up front so a
 * diagram never shifts the layout while it loads; `darkBacking` puts
 * black-on-transparent line art on a light plate so it stays readable in dark
 * mode. PLAIN questions keep their legacy single `imageUrl` markup instead.
 */
export function QuestionMedia({ assets, size = "question", className }: { assets: AssetView[]; size?: "question" | "option"; className?: string }) {
  if (assets.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="question-media">
      {assets.map((a, i) => (
        <figure key={`${a.url}:${i}`} className="m-0 flex max-w-full flex-col gap-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={a.url}
            alt={a.alt}
            width={a.width || undefined}
            height={a.height || undefined}
            loading="lazy"
            decoding="async"
            className={cn(
              "h-auto max-w-full rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain",
              size === "option" ? "max-h-48" : "max-h-96",
              a.darkBacking && "bg-white p-1.5"
            )}
            style={a.width ? { width: `min(100%, ${a.width}px)` } : undefined}
          />
          {a.caption ? <figcaption className="text-xs text-[var(--color-muted-foreground)]">{a.caption}</figcaption> : null}
        </figure>
      ))}
    </div>
  );
}
