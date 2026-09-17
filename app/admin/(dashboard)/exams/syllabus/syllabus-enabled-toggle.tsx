"use client";

import { useTransition } from "react";
import { Switch } from "@/components/ui/switch";
import { toggleSyllabusEnabledAction } from "./actions";

export function SyllabusEnabledToggle({ examId, enabled }: { examId: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={enabled}
        disabled={pending}
        onCheckedChange={(checked) => startTransition(() => toggleSyllabusEnabledAction(examId, checked))}
        aria-label={enabled ? "Disable public syllabus" : "Enable public syllabus"}
      />
      <span className="text-sm text-[var(--color-foreground)]">{enabled ? "Published" : "Draft (hidden from students)"}</span>
    </div>
  );
}
