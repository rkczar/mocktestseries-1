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
import { editTopicAction, type EditTopicFormState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

export function TopicEditDialog({ id, name, order }: { id: string; name: string; order: number }) {
  const [state, formAction] = useActionState<EditTopicFormState, FormData>(editTopicAction, {});
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (state.success) setOpen(false);
  }, [state.success]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="compact" variant="outline" aria-label={`Edit ${name}`}>
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Topic</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="id" value={id} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`topic-name-${id}`}>Topic Name</Label>
            <Input id={`topic-name-${id}`} name="name" defaultValue={name} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`topic-order-${id}`}>Display Order</Label>
            <Input id={`topic-order-${id}`} name="order" type="number" min={0} defaultValue={order} />
          </div>
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
