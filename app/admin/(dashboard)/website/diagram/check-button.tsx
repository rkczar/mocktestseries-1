"use client";

import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runDiagramCheckAction } from "./actions";

export function CheckButton() {
  const [pending, startTransition] = useTransition();
  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={() => startTransition(runDiagramCheckAction)}>
      <RefreshCw className={pending ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} aria-hidden />
      {pending ? "Checking…" : "Run Broken-Connection Check"}
    </Button>
  );
}
