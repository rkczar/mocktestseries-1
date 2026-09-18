"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { publishAnnouncementAction, unpublishAnnouncementAction, archiveAnnouncementAction } from "./actions";

export function AnnouncementStatusActions({ announcementId, status }: { announcementId: string; status: "DRAFT" | "PUBLISHED" | "ARCHIVED" }) {
  const [pending, startTransition] = useTransition();

  if (status === "ARCHIVED") {
    return <span className="text-xs text-[var(--color-muted-foreground)]">Archived</span>;
  }

  return (
    <div className="flex items-center gap-2">
      {status === "DRAFT" ? (
        <Button size="sm" disabled={pending} onClick={() => startTransition(() => publishAnnouncementAction(announcementId))}>
          Publish
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => startTransition(() => unpublishAnnouncementAction(announcementId))}
        >
          Unpublish
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          if (confirm("Archive this announcement? It will stop appearing to students and can no longer be edited.")) {
            startTransition(() => archiveAnnouncementAction(announcementId));
          }
        }}
      >
        Archive
      </Button>
    </div>
  );
}
