"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";

export function StudentReportControls() {
  const [includeContact, setIncludeContact] = useState(false);
  const href = `/api/admin/student-data-report?includeContact=${includeContact ? "1" : "0"}`;

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm text-[var(--color-foreground)]">
        <Checkbox checked={includeContact} onCheckedChange={(v) => setIncludeContact(v === true)} />
        Include Contact Information (email, mobile)
      </label>
      <a
        href={href}
        download
        className="inline-flex w-fit shrink-0 items-center gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface)]"
      >
        <Download className="h-3.5 w-3.5" aria-hidden />
        Download Student Data Report
      </a>
    </div>
  );
}
