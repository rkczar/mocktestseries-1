"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { assignToMeAction } from "./actions";

export function AssignToMeButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => startTransition(() => assignToMeAction(id))}>
      {pending ? "Assigning…" : "Assign to me"}
    </Button>
  );
}
