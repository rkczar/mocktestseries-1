"use client";

import { useState, useTransition } from "react";
import { Link2, ListTree, Trash2, Unlink } from "lucide-react";
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
import { createSubTopicAction, deleteSubTopicAction, linkSubTopicAction, unlinkSubTopicAction } from "./actions";

interface SubTopic {
  id: string;
  name: string;
  /** Linked to the current exam (always true without an exam context). */
  linked: boolean;
}

/**
 * Canonical sub-topics of one topic. With an exam context: linked ones can be
 * removed from the exam (unlink), other existing ones can be linked ("Use
 * Existing"), and adding a name that already exists reuses that record.
 * Without an exam context (master overview) the trash button deletes the
 * master record, which the server refuses while any exam links it.
 */
export function SubTopicsDialog({
  topicId,
  topicName,
  initialSubTopics,
  examId,
}: {
  topicId: string;
  topicName: string;
  initialSubTopics: SubTopic[];
  examId?: string;
}) {
  const [subTopics, setSubTopics] = useState(initialSubTopics);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const run = (fn: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  };

  const handleAdd = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError("Name must be at least 2 characters.");
      return;
    }
    run(async () => {
      const created = await createSubTopicAction(topicId, trimmed, examId);
      setSubTopics((prev) =>
        prev.some((st) => st.id === created.id)
          ? prev.map((st) => (st.id === created.id ? { ...st, linked: true } : st))
          : [...prev, { id: created.id, name: created.name, linked: true }]
      );
      if (created.existed) setNotice(`"${created.name}" already existed — the existing sub-topic was reused, not duplicated.`);
      setName("");
    });
  };

  const handleLink = (st: SubTopic) =>
    run(async () => {
      await linkSubTopicAction(examId!, st.id);
      setSubTopics((prev) => prev.map((x) => (x.id === st.id ? { ...x, linked: true } : x)));
    });

  const handleUnlink = (st: SubTopic) =>
    run(async () => {
      const res = await unlinkSubTopicAction(examId!, st.id);
      if (res.error) throw new Error(res.error);
      setSubTopics((prev) => prev.map((x) => (x.id === st.id ? { ...x, linked: false } : x)));
    });

  const handleDelete = (st: SubTopic) =>
    run(async () => {
      await deleteSubTopicAction(st.id);
      setSubTopics((prev) => prev.filter((x) => x.id !== st.id));
    });

  const linkedCount = subTopics.filter((st) => st.linked).length;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" size="compact" variant="outline">
          <ListTree className="h-3.5 w-3.5" aria-hidden /> Sub-topics ({linkedCount})
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sub-topics of {topicName}</DialogTitle>
          <DialogDescription>
            Optional finer categorization used when tagging questions. Sub-topics are shared master records
            {examId ? "; removing one from this exam keeps it for other exams." : "."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
          {subTopics.length === 0 ? (
            <p className="py-2 text-sm text-[var(--color-muted-foreground)]">No sub-topics yet.</p>
          ) : (
            subTopics.map((st) => (
              <div
                key={st.id}
                className="flex items-center justify-between gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2 text-sm"
              >
                <span className={st.linked ? "text-[var(--color-foreground)]" : "text-[var(--color-muted-foreground)]"}>
                  {st.name}
                  {!st.linked ? " · not in this exam" : ""}
                </span>
                {!examId ? (
                  <button type="button" onClick={() => handleDelete(st)} disabled={isPending} aria-label={`Delete master sub-topic ${st.name}`}>
                    <Trash2 className="h-3.5 w-3.5 text-[var(--color-error)]" aria-hidden />
                  </button>
                ) : st.linked ? (
                  <button type="button" onClick={() => handleUnlink(st)} disabled={isPending} aria-label={`Remove ${st.name} from this exam`} title="Remove from this exam">
                    <Unlink className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden />
                  </button>
                ) : (
                  <Button type="button" size="compact" variant="outline" onClick={() => handleLink(st)} disabled={isPending}>
                    <Link2 className="h-3.5 w-3.5" aria-hidden /> Use Existing
                  </Button>
                )}
              </div>
            ))
          )}
        </div>

        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New sub-topic name" aria-label="New sub-topic name" />
          <Button type="button" onClick={handleAdd} disabled={isPending}>
            Add
          </Button>
        </div>
        {notice ? <p className="text-sm text-[var(--color-success)]">{notice}</p> : null}
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
