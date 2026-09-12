"use client";

import { useTransition } from "react";
import { SelectNative } from "@/components/ui/select-native";
import { setMockTestStatusAction } from "./actions";
import type { MockTestStatus } from "@prisma/client";

export function MockTestStatusSelect({ mockTestId, status }: { mockTestId: string; status: MockTestStatus }) {
  const [pending, startTransition] = useTransition();

  return (
    <SelectNative
      value={status}
      disabled={pending}
      onChange={(e) => startTransition(() => setMockTestStatusAction(mockTestId, e.target.value as MockTestStatus))}
      className="h-8 w-32 text-xs"
      aria-label="Mock test status"
    >
      <option value="DRAFT">Draft</option>
      <option value="PUBLISHED">Published</option>
      <option value="ARCHIVED">Archived</option>
    </SelectNative>
  );
}
