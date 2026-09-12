"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { approveDeletionRequestAction, rejectDeletionRequestAction } from "../actions";

export function DeletionActions({ requestId }: { requestId: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        variant="danger"
        disabled={pending}
        onClick={() => startTransition(() => approveDeletionRequestAction(requestId))}
      >
        Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => startTransition(() => rejectDeletionRequestAction(requestId))}
      >
        Reject
      </Button>
    </div>
  );
}
