"use client";

import { useTransition } from "react";
import { SelectNative } from "@/components/ui/select-native";
import { setCommunicationStatusAction } from "./actions";
import type { CommunicationStatus } from "@prisma/client";

export function CommunicationStatusSelect({ id, status }: { id: string; status: CommunicationStatus }) {
  const [pending, startTransition] = useTransition();

  return (
    <SelectNative
      value={status}
      disabled={pending}
      onChange={(e) => startTransition(() => setCommunicationStatusAction(id, e.target.value as CommunicationStatus))}
      className="h-8 w-36 text-xs"
      aria-label="Status"
    >
      <option value="NEW">New</option>
      <option value="READ">Read</option>
      <option value="IN_PROGRESS">In Progress</option>
      <option value="RESOLVED">Resolved</option>
      <option value="ARCHIVED">Archived</option>
    </SelectNative>
  );
}
