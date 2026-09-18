"use client";

import { useActionState, useState } from "react";
import { Handshake } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SelectNative } from "@/components/ui/select-native";
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
import { submitGrowWithUsAction, type CommunicationFormState } from "@/lib/communications-actions";

const INITIAL_STATE: CommunicationFormState = {};

const INTEREST_OPTIONS: { value: string; label: string }[] = [
  { value: "TEACHER", label: "Teacher / Educator" },
  { value: "TEST_SERIES_CREATOR", label: "Test Series Creator / Contributor" },
  { value: "IT_SUPPORT", label: "IT / Technical Support" },
  { value: "CONTENT_CONTRIBUTOR", label: "Content / Question Contributor" },
  { value: "OTHER", label: "Other" },
];

export function GrowWithUsButton({
  label = "Grow with Us",
  variant = "outline",
  className,
}: {
  label?: string;
  variant?: "outline" | "ghost" | "secondary";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(submitGrowWithUsAction, INITIAL_STATE);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant={variant} size="sm" className={className}>
          <Handshake className="h-4 w-4" aria-hidden /> {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Grow with MockTestSeries.in</DialogTitle>
          <DialogDescription>
            Tell us how you&apos;d like to contribute — as a teacher, contributor, or support partner.
          </DialogDescription>
        </DialogHeader>

        {state.success ? (
          <div className="flex flex-col gap-3 py-2">
            <p className="text-sm text-[var(--color-success)]">
              Thanks! We&apos;ve received your submission. Your reference ID is{" "}
              <span className="font-mono font-medium text-[var(--color-foreground)]">{state.referenceId}</span>.
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Close
                </Button>
              </DialogClose>
            </DialogFooter>
          </div>
        ) : (
          <form action={formAction} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gwu-name">Name</Label>
              <Input id="gwu-name" name="name" required minLength={2} maxLength={100} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gwu-email">Email</Label>
              <Input id="gwu-email" name="email" type="email" required maxLength={254} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gwu-phone">Phone (optional)</Label>
              <Input id="gwu-phone" name="phone" type="tel" maxLength={20} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gwu-interest">I want to grow with MockTestSeries.in as</Label>
              <SelectNative id="gwu-interest" name="interestType" required defaultValue="">
                <option value="" disabled>
                  Select a role
                </option>
                {INTEREST_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </SelectNative>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gwu-experience">Experience / short introduction (optional)</Label>
              <Textarea id="gwu-experience" name="experience" rows={3} maxLength={1000} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gwu-message">Message</Label>
              <Textarea id="gwu-message" name="message" rows={4} required minLength={10} maxLength={3000} />
            </div>
            {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={isPending}>
                {isPending ? "Submitting…" : "Submit"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
