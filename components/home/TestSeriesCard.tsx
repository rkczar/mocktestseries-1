import { Clock, FileText, Target } from "lucide-react";
import Link from "next/link";

import type { TestSeriesCardDTO } from "@/lib/content/types";

const KIND_ICON = {
  FULL_MOCK: Clock,
  PREVIOUS_YEAR: FileText,
  SUBJECT_WISE: Target,
} as const;

export function TestSeriesCard({ series }: { series: TestSeriesCardDTO }) {
  const Icon = KIND_ICON[series.kind];

  return (
    <Link
      href={`/test-series/${series.slug}`}
      className="block rounded-[14px] border border-border bg-background p-6 transition-colors duration-150 hover:border-primary hover:bg-surface"
    >
      <Icon className="size-[22px] text-primary" strokeWidth={1.9} />
      <h3 className="mt-4 text-[18.5px] font-extrabold text-text-heading">{series.title}</h3>
      <p className="mt-2 text-[14.5px] leading-relaxed text-text-muted">{series.description}</p>
      {series.metaLabel ? (
        <p className="mt-3.5 font-mono text-xs text-text-faint">{series.metaLabel}</p>
      ) : null}
    </Link>
  );
}
