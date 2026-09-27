"use client";

import { useState, useTransition } from "react";
import { Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { unlinkSubjectAction } from "./actions";
import { unlinkSubTopicAction, unlinkTopicAction } from "../topics/actions";

const ACTIONS = { subject: unlinkSubjectAction, topic: unlinkTopicAction, subTopic: unlinkSubTopicAction };

/**
 * "Remove from Exam" — unlinks a canonical Subject/Topic/SubTopic from ONE
 * exam. The master record (and every other exam's link) is untouched. Two
 * clicks: the first arms it, the second confirms.
 */
export function RemoveFromExamButton({
  kind,
  examId,
  id,
  label,
  onRemoved,
}: {
  kind: keyof typeof ACTIONS;
  examId: string;
  id: string;
  label: string;
  onRemoved?: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleClick = () => {
    if (!armed) {
      setArmed(true);
      setError(null);
      return;
    }
    startTransition(async () => {
      const res = await ACTIONS[kind](examId, id);
      setArmed(false);
      if (res.error) setError(res.error);
      else onRemoved?.();
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="compact"
          variant={armed ? "danger" : "ghost"}
          onClick={handleClick}
          disabled={isPending}
          aria-label={`Remove ${label} from this exam`}
          title="Remove from this exam (the shared master record is kept)"
        >
          <Unlink className="h-3.5 w-3.5" aria-hidden />
          {armed ? (isPending ? "Removing…" : "Confirm remove") : null}
        </Button>
        {armed && !isPending ? (
          <Button type="button" size="compact" variant="ghost" onClick={() => setArmed(false)}>
            Cancel
          </Button>
        ) : null}
      </div>
      {error ? <p className="max-w-[240px] text-right text-xs text-[var(--color-error)]">{error}</p> : null}
    </div>
  );
}
