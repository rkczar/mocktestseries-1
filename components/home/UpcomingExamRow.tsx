import Link from "next/link";

import { StatusBadge } from "@/components/common/StatusBadge";
import type { UpcomingExamDTO } from "@/lib/content/types";

function dateTile(exam: UpcomingExamDTO) {
  if (exam.examDate) {
    const month = exam.examDate.toLocaleDateString("en-IN", { month: "short" }).toUpperCase();
    const day = exam.examDate.getDate();
    return { top: month, bottom: String(day) };
  }
  if (exam.dateLabel) {
    const [first, ...rest] = exam.dateLabel.split(" ");
    return { top: first.toUpperCase(), bottom: rest.join(" ") || "—" };
  }
  return { top: "TBD", bottom: "—" };
}

export function UpcomingExamRow({ exam }: { exam: UpcomingExamDTO }) {
  const tile = dateTile(exam);

  return (
    <li className="flex flex-wrap items-center gap-x-4.5 gap-y-3 rounded-xl border border-border bg-background px-4.5 py-4">
      <span className="flex size-14 flex-none flex-col items-center justify-center rounded-[10px] border border-primary-border bg-surface">
        <span className="font-mono text-[10px] font-semibold tracking-[.08em] text-brand-accent-text uppercase">
          {tile.top}
        </span>
        <span className="text-[19px] leading-[1.1] font-extrabold text-text-heading">
          {tile.bottom}
        </span>
      </span>
      <span className="min-w-0 flex-1 basis-60">
        <span className="block text-base font-bold text-text-heading">{exam.title}</span>
        {exam.subtitle ? (
          <span className="mt-0.5 block text-[13.5px] text-text-faint">{exam.subtitle}</span>
        ) : null}
      </span>
      <StatusBadge tone={exam.statusTone}>{exam.status}</StatusBadge>
      {exam.actionHref && exam.actionLabel ? (
        <Link href={exam.actionHref} className="text-sm font-bold whitespace-nowrap text-primary">
          {exam.actionLabel} →
        </Link>
      ) : null}
    </li>
  );
}
