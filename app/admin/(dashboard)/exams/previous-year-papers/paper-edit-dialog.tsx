"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { editPaperAction, type PaperFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

export function PaperEditDialog({
  id,
  title,
  year,
  paperCode,
  order,
  durationMinutes,
}: {
  id: string;
  title: string;
  year: number;
  paperCode: string | null;
  order: number;
  /** Stored paper duration; null = not set yet (falls back to the Exam's duration, then 120). */
  durationMinutes: number | null;
}) {
  const [state, formAction] = useActionState<PaperFormState, FormData>(editPaperAction, {});
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (state.success) setOpen(false);
  }, [state.success]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="compact" variant="outline" aria-label={`Edit ${title}`}>
          <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Paper</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="id" value={id} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`paper-title-${id}`}>Title</Label>
            <Input id={`paper-title-${id}`} name="title" defaultValue={title} required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`paper-year-${id}`}>Year</Label>
              <Input id={`paper-year-${id}`} name="year" type="number" defaultValue={year} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`paper-code-${id}`}>Paper Code</Label>
              <Input id={`paper-code-${id}`} name="paperCode" defaultValue={paperCode ?? ""} placeholder="e.g. Code 12" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`paper-order-${id}`}>Display Order</Label>
              <Input id={`paper-order-${id}`} name="order" type="number" min={0} defaultValue={order} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`paper-duration-${id}`}>Duration (minutes)</Label>
              <Input
                id={`paper-duration-${id}`}
                name="durationMinutes"
                type="number"
                min={1}
                max={600}
                step={1}
                defaultValue={durationMinutes ?? 120}
                required
              />
            </div>
          </div>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Standard Mode time for new attempts. Attempts already started keep their original duration.
          </p>
          {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <SubmitButton />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
