"use client";

import { useTransition } from "react";
import { Switch } from "@/components/ui/switch";
import { toggleAdminUserActiveAction } from "./actions";

export function UserToggle({ userId, isActive, isSelf }: { userId: string; isActive: boolean; isSelf: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Switch
      checked={isActive}
      disabled={pending || (isSelf && isActive)}
      onCheckedChange={(checked) => startTransition(() => toggleAdminUserActiveAction(userId, checked))}
      aria-label={isActive ? "Deactivate admin" : "Activate admin"}
    />
  );
}
