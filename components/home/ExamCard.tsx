import { ArrowRight, LayoutGrid } from "lucide-react";
import Link from "next/link";

import { ImagePlaceholder } from "@/components/common/ImagePlaceholder";
import { MetaChip } from "@/components/common/MetaChip";
import { StatusBadge } from "@/components/common/StatusBadge";
import type { FeaturedExamDTO } from "@/lib/content/types";

export function ExamCard({ exam }: { exam: FeaturedExamDTO }) {
  const isActive = exam.status === "ACTIVE";

  return (
    <Link
      href={`/exams/${exam.slug}`}
      className="block rounded-2xl border-[1.5px] border-primary bg-surface p-6 shadow-[0_10px_30px_-20px_rgba(15,76,129,.4)] transition-shadow duration-150 hover:shadow-[0_16px_36px_-18px_rgba(15,76,129,.45)]"
    >
      <div className="flex items-center gap-3">
        <span className="flex size-[46px] flex-none items-center justify-center rounded-xl border border-primary-border bg-primary-tint">
          <LayoutGrid className="size-[23px] text-primary" strokeWidth={1.9} />
        </span>
        <StatusBadge tone={isActive ? "success" : "neutral"} dot={isActive}>
          {isActive ? "Active" : exam.status === "COMING_SOON" ? "Coming soon" : "Archived"}
        </StatusBadge>
      </div>
      <h3 className="mt-[18px] text-xl leading-tight font-extrabold text-text-heading">
        {exam.title}
      </h3>
      <p className="mt-2 text-[14.5px] leading-relaxed text-text-muted text-pretty">
        {exam.description}
      </p>
      {exam.metaChips.length ? (
        <ul className="mt-4 flex flex-wrap gap-2">
          {exam.metaChips.map((chip) => (
            <MetaChip key={chip}>{chip}</MetaChip>
          ))}
        </ul>
      ) : null}
      <span className="mt-5 inline-flex items-center gap-2 rounded-[9px] bg-primary px-[18px] py-3 text-[14.5px] font-bold text-primary-foreground">
        Open exam page
        <ArrowRight className="size-4" strokeWidth={2.2} />
      </span>
    </Link>
  );
}

export function ExamCardPlaceholder({ helper }: { helper: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-2xl border border-dashed border-border-strong bg-surface p-6">
      <StatusBadge tone="neutral" className="self-start">
        Coming soon
      </StatusBadge>
      <h3 className="mt-4 text-lg font-bold text-text-muted">Next exam slot</h3>
      <p className="mt-2 text-sm leading-relaxed text-text-faint">{helper}</p>
      <div className="mt-auto pt-4.5">
        <ImagePlaceholder className="h-[76px]" />
      </div>
    </div>
  );
}
