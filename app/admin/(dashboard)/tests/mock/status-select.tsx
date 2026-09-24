"use client";

import { useState, useTransition } from "react";
import { SelectNative } from "@/components/ui/select-native";
import { setMockTestStatusAction } from "./actions";
import type { MockTestStatus } from "@prisma/client";

export function MockTestStatusSelect({ mockTestId, status, readOnly = false }: { mockTestId: string; status: MockTestStatus; readOnly?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col gap-1">
      <SelectNative
        value={status}
        disabled={pending || readOnly}
        onChange={(e) => {
          const next = e.target.value as MockTestStatus;
          setError(null);
          startTransition(async () => {
            const res = await setMockTestStatusAction(mockTestId, next);
            if (res.error) setError(res.error);
          });
        }}
        className="h-8 w-32 text-xs"
        aria-label="Mock test status"
      >
        <option value="DRAFT">Draft</option>
        <option value="PUBLISHED">Published</option>
        <option value="ARCHIVED">Archived</option>
      </SelectNative>
      {error ? <span className="max-w-[16rem] text-[11px] text-[var(--color-error)]">{error}</span> : null}
    </span>
  );
}
