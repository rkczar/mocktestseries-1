"use client";

import { useTransition } from "react";
import { Switch } from "@/components/ui/switch";
import { toggleExamActiveAction } from "./actions";

export function ActiveToggle({ examId, isActive }: { examId: string; isActive: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <Switch
      checked={isActive}
      disabled={pending}
      onCheckedChange={(checked) => startTransition(() => toggleExamActiveAction(examId, checked))}
      aria-label={isActive ? "Deactivate exam" : "Activate exam"}
    />
  );
}
