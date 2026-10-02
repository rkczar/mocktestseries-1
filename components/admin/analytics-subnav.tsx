import Link from "next/link";
import { cn } from "@/lib/utils";

const ITEMS = [
  { key: "platform", label: "Platform Overview", href: "/admin/analytics" },
  { key: "questions", label: "Question Insights", href: "/admin/analytics/questions" },
] as const;

/** Section switcher shared by every Admin → Analytics page (the sidebar keeps one "Analytics" entry). */
export function AnalyticsSubnav({ active }: { active: (typeof ITEMS)[number]["key"] }) {
  return (
    <nav aria-label="Analytics sections" className="flex flex-wrap gap-2">
      {ITEMS.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          aria-current={item.key === active ? "page" : undefined}
          className={cn(
            "rounded-[var(--radius-button)] border px-3 py-1.5 text-sm font-medium transition-colors",
            item.key === active
              ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
              : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
