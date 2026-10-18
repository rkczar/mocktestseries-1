"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { extendRetentionAction } from "../actions";
import { callImporter } from "@/components/admin/ai-importer/call-importer";

export function ExtendRetention({ fileId }: { fileId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="ml-2 text-xs underline disabled:opacity-50"
      disabled={pending}
      onClick={() => {
        const days = Number(prompt("Keep this file for how many more days?", "90"));
        if (!days) return;
        start(async () => {
          const r = await callImporter(() => extendRetentionAction(fileId, days));
          if (!r.ok) alert(r.error);
          router.refresh();
        });
      }}
      data-testid="extend-retention"
    >
      Keep longer
    </button>
  );
}
