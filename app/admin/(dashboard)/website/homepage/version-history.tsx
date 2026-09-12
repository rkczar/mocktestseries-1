"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { restoreVersionAction } from "./actions";

export interface VersionRow {
  id: string;
  version: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  publishedAt: string | null;
}

export function VersionHistory({ versions }: { versions: VersionRow[] }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-2">
      {versions.map((v) => (
        <div key={v.id} className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-[var(--color-foreground)]">Version {v.version}</span>
            <Badge variant={v.status === "PUBLISHED" ? "success" : v.status === "DRAFT" ? "info" : "neutral"}>{v.status}</Badge>
            {v.publishedAt ? (
              <span className="text-xs text-[var(--color-muted-foreground)]">{new Date(v.publishedAt).toLocaleString("en-IN")}</span>
            ) : null}
          </div>
          {v.status === "ARCHIVED" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => {
                if (confirm(`Restore version ${v.version} into the current draft? Unsaved draft edits will be replaced.`)) {
                  startTransition(() => restoreVersionAction(v.id));
                }
              }}
            >
              Restore
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
