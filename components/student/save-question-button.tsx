"use client";

import { useState, useTransition } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SaveQuestionButton({ initialSaved, onToggle }: { initialSaved: boolean; onToggle: () => Promise<void> }) {
  const [saved, setSaved] = useState(initialSaved);
  const [isPending, startTransition] = useTransition();

  const handleClick = () => {
    const next = !saved;
    setSaved(next);
    startTransition(() => {
      onToggle().catch(() => setSaved(!next));
    });
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleClick} disabled={isPending}>
      {saved ? (
        <BookmarkCheck className="h-4 w-4 text-[var(--color-primary)]" aria-hidden />
      ) : (
        <Bookmark className="h-4 w-4" aria-hidden />
      )}
      {saved ? "Saved" : "Save"}
    </Button>
  );
}
