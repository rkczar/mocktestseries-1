"use client";

import { useTransition } from "react";
import { UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { publishHomepageAction } from "./actions";

export function PublishButton() {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="success"
      disabled={pending}
      onClick={() => {
        if (confirm("Publish the current draft? It will go live on the public homepage immediately.")) {
          startTransition(publishHomepageAction);
        }
      }}
    >
      <UploadCloud className="h-4 w-4" aria-hidden />
      {pending ? "Publishing…" : "Publish"}
    </Button>
  );
}
