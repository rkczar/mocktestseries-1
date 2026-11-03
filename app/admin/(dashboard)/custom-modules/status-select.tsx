"use client";

import { useTransition } from "react";
import { SelectNative } from "@/components/ui/select-native";
import { setCustomModuleStatusAction } from "./actions";
import type { CustomModuleStatus } from "@prisma/client";

export function CustomModuleStatusSelect({ moduleId, status }: { moduleId: string; status: CustomModuleStatus }) {
  const [pending, startTransition] = useTransition();

  return (
    <SelectNative
      value={status}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value as CustomModuleStatus;
        startTransition(async () => {
          const result = await setCustomModuleStatusAction(moduleId, next);
          if (result?.error) window.alert(result.error);
        });
      }}
      className="h-8 w-32 text-xs"
      aria-label="Custom module status"
    >
      <option value="DRAFT">Draft</option>
      <option value="PUBLISHED">Published</option>
      <option value="ACTIVE">Active</option>
      <option value="INACTIVE">Inactive</option>
      <option value="ARCHIVED">Archived</option>
    </SelectNative>
  );
}
