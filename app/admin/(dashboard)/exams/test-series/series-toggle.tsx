"use client";

import { useTransition } from "react";
import { Switch } from "@/components/ui/switch";
import { toggleTestSeriesActiveAction } from "./actions";

export function SeriesToggle({ id, isActive }: { id: string; isActive: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <Switch
      checked={isActive}
      disabled={pending}
      onCheckedChange={(checked) => startTransition(() => toggleTestSeriesActiveAction(id, checked))}
      aria-label={isActive ? "Deactivate test series" : "Activate test series"}
    />
  );
}
