"use client";

import { useTransition } from "react";
import { Switch } from "@/components/ui/switch";
import { togglePageVisibilityAction } from "./actions";
import type { PageVisibilityKey } from "@/lib/page-visibility";

export function PageVisibilityToggle({
  pageKey,
  isVisible,
  canManage,
}: {
  pageKey: PageVisibilityKey;
  isVisible: boolean;
  canManage: boolean;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <Switch
      checked={isVisible}
      disabled={pending || !canManage}
      onCheckedChange={(checked) => startTransition(() => togglePageVisibilityAction(pageKey, checked))}
      aria-label={isVisible ? "Hide page" : "Show page"}
      title={canManage ? undefined : "MASTER_ADMIN only"}
    />
  );
}
