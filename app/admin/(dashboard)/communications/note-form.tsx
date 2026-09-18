"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { updateInternalNoteAction } from "./actions";

export function InternalNoteForm({ id, initialNote }: { id: string; initialNote: string }) {
  const [note, setNote] = useState(initialNote);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          setSaved(false);
        }}
        rows={4}
        maxLength={2000}
        placeholder="Internal note — never shown to the submitter."
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await updateInternalNoteAction(id, note);
            setSaved(true);
          })
        }
      >
        {pending ? "Saving…" : saved ? "Saved" : "Save Note"}
      </Button>
    </div>
  );
}
