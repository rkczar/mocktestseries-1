"use client";

import { useState, useTransition } from "react";
import { ListTree, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createSubTopicAction, deleteSubTopicAction } from "./actions";

interface SubTopic {
  id: string;
  name: string;
}

export function SubTopicsDialog({ topicId, topicName, initialSubTopics }: { topicId: string; topicName: string; initialSubTopics: SubTopic[] }) {
  const [subTopics, setSubTopics] = useState(initialSubTopics);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleAdd = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError("Name must be at least 2 characters.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const created = await createSubTopicAction(topicId, trimmed);
        setSubTopics((prev) => [...prev, { id: created.id, name: created.name }]);
        setName("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not add sub-topic.");
      }
    });
  };

  const handleDelete = (subTopicId: string) => {
    setError(null);
    startTransition(async () => {
      try {
        await deleteSubTopicAction(subTopicId);
        setSubTopics((prev) => prev.filter((st) => st.id !== subTopicId));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not delete sub-topic.");
      }
    });
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" size="compact" variant="outline">
          <ListTree className="h-3.5 w-3.5" aria-hidden /> Sub-topics ({subTopics.length})
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sub-topics of {topicName}</DialogTitle>
          <DialogDescription>Optional finer categorization used when tagging questions.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {subTopics.length === 0 ? (
            <p className="py-2 text-sm text-[var(--color-muted-foreground)]">No sub-topics yet.</p>
          ) : (
            subTopics.map((st) => (
              <div key={st.id} className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2 text-sm">
                <span className="text-[var(--color-foreground)]">{st.name}</span>
                <button type="button" onClick={() => handleDelete(st.id)} disabled={isPending} aria-label={`Delete ${st.name}`}>
                  <Trash2 className="h-3.5 w-3.5 text-[var(--color-error)]" aria-hidden />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New sub-topic name" />
          <Button type="button" onClick={handleAdd} disabled={isPending}>
            Add
          </Button>
        </div>
        {error ? <p className="text-sm text-[var(--color-error)]">{error}</p> : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
