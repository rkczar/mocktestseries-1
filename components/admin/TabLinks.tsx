import Link from "next/link";

import { cn } from "@/lib/utils";

export function TabLinks({
  tabs,
  active,
  basePath,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  basePath: string;
}) {
  return (
    <div className="mb-6 flex gap-1 border-b border-border">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={`${basePath}?tab=${tab.key}`}
          className={cn(
            "border-b-2 px-3.5 py-2.5 text-sm font-bold",
            active === tab.key
              ? "border-primary text-primary"
              : "border-transparent text-text-faint hover:text-text-muted",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
