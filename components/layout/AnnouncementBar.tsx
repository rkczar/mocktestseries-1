import Link from "next/link";

import type { AnnouncementDTO } from "@/lib/content/types";

export function AnnouncementBar({ announcement }: { announcement: AnnouncementDTO | null }) {
  if (!announcement) return null;

  return (
    <div className="bg-primary px-0 py-2.5 text-[13px] leading-snug text-primary-foreground">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-center gap-x-4.5 gap-y-2 px-6 text-center">
        {announcement.tag ? (
          <span className="font-mono text-[11px] font-semibold tracking-[.08em] text-primary-foreground/80 uppercase">
            {announcement.tag}
          </span>
        ) : null}
        <span>{announcement.message}</span>
        {announcement.linkHref && announcement.linkLabel ? (
          <Link
            href={announcement.linkHref}
            className="font-semibold text-primary-foreground underline underline-offset-[3px]"
          >
            {announcement.linkLabel}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
