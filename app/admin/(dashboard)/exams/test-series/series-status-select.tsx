"use client";

import { useTransition } from "react";
import { SelectNative } from "@/components/ui/select-native";
import { setTestSeriesStatusAction } from "./actions";
import type { TestSeriesStatus } from "@prisma/client";

export function SeriesStatusSelect({ id, status }: { id: string; status: TestSeriesStatus }) {
  const [pending, startTransition] = useTransition();

  return (
    <SelectNative
      value={status}
      disabled={pending}
      onChange={(e) => startTransition(() => setTestSeriesStatusAction(id, e.target.value as TestSeriesStatus))}
      className="h-8 w-32 text-xs"
      aria-label="Test series status"
    >
      <option value="DRAFT">Draft</option>
      <option value="PUBLISHED">Published</option>
      <option value="ARCHIVED">Archived</option>
    </SelectNative>
  );
}
