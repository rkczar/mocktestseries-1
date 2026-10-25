"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createEditJobAction } from "@/app/admin/(dashboard)/video-studio/actions";

/** Creates an empty AI Video Editor project, then opens it for uploading. */
export function NewEditForm({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await createEditJobAction(title);
          if (r.ok) router.push(`/admin/video-studio/jobs/${r.data.id}`);
          else setError(r.error);
        });
      }}
    >
      <Input aria-label="Project title" placeholder="Project title, e.g. Cardiology lecture clip" className="h-9 w-80 max-w-full" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} disabled={disabled || pending} data-testid="edit-title" />
      <Button type="submit" disabled={disabled || pending} data-testid="create-edit">
        New editor project
      </Button>
      {error ? <span className="text-xs text-[var(--color-error)]" role="alert">{error}</span> : null}
    </form>
  );
}
