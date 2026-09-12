"use client";

import { useTransition } from "react";
import { SelectNative } from "@/components/ui/select-native";
import { setReportStatusAction } from "./actions";
import type { ReportStatus } from "@prisma/client";

export function ReportStatusSelect({ reportId, status }: { reportId: string; status: ReportStatus }) {
  const [pending, startTransition] = useTransition();

  return (
    <SelectNative
      value={status}
      disabled={pending}
      onChange={(e) => startTransition(() => setReportStatusAction(reportId, e.target.value as ReportStatus))}
      className="h-8 w-32 text-xs"
      aria-label="Report status"
    >
      <option value="OPEN">Open</option>
      <option value="REVIEWED">Reviewed</option>
      <option value="RESOLVED">Resolved</option>
    </SelectNative>
  );
}
