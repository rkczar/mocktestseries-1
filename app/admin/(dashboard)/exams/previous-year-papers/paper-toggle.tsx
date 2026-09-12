"use client";

import { useTransition } from "react";
import { Switch } from "@/components/ui/switch";
import { togglePaperActiveAction } from "./actions";

export function PaperToggle({ paperId, isActive }: { paperId: string; isActive: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Switch
      checked={isActive}
      disabled={pending}
      onCheckedChange={(checked) => startTransition(() => togglePaperActiveAction(paperId, checked))}
      aria-label={isActive ? "Deactivate paper" : "Activate paper"}
    />
  );
}
