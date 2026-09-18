"use client";

import { useActionState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { correctStudentNameAction, type StudentNameActionState } from "../actions";

const INITIAL_STATE: StudentNameActionState = {};

/** Admin -> Students -> Student Profile: the only UI that can rename a student's account (PERMISSIONS.STUDENTS_MANAGE). */
export function NameCorrectionDialog({ studentId, name }: { studentId: string; name: string }) {
  const [state, formAction, isPending] = useActionState(correctStudentNameAction.bind(null, studentId), INITIAL_STATE);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="h-4 w-4" aria-hidden /> Correct Name
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Correct Student Name</DialogTitle>
          <DialogDescription>
            Use this only to fix a spelling or legal-name mistake. The change is recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Full Name</Label>
            <Input id="name" name="name" defaultValue={name} required minLength={2} />
          </div>
          {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
          {state.success ? <p className="text-sm text-[var(--color-success)]">{state.success}</p> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving…" : "Save Correction"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
