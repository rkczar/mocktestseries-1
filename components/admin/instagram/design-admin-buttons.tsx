"use client";

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { deleteDesignPresetAction, saveDefaultTemplateAction } from "@/app/admin/(dashboard)/instagram/studio-actions";
import type { TemplateKey } from "@/lib/instagram/types";

export function SetDefaultDesignButton({ template }: { template: TemplateKey }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        data-testid={`set-default-${template}`}
        onClick={() =>
          start(async () => {
            const r = await saveDefaultTemplateAction(template);
            if (!r.ok) setErr(r.error);
            else router.refresh();
          })
        }
      >
        Set as default design
      </Button>
      {err ? <span className="text-xs text-[var(--color-error)]">{err}</span> : null}
    </div>
  );
}

export function DeletePresetButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="compact"
      variant="ghost"
      disabled={pending}
      aria-label={`Delete preset ${name}`}
      onClick={() =>
        start(async () => {
          const r = await deleteDesignPresetAction(id);
          if (r.ok) router.refresh();
        })
      }
    >
      Delete
    </Button>
  );
}
