"use client";

import { useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
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

export interface ConfirmActionResult {
  error?: string;
  success?: string;
}

/**
 * Confirmation modal in front of a destructive device/session action. The
 * action runs only from the confirm button; its result message stays in
 * the dialog so the outcome is never silent.
 */
export function ConfirmActionDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive = true,
  triggerVariant = "outline",
  disabled = false,
}: {
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<ConfirmActionResult>;
  destructive?: boolean;
  triggerVariant?: "outline" | "danger" | "secondary" | "ghost";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ConfirmActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () =>
    startTransition(async () => {
      try {
        const outcome = await onConfirm();
        setResult(outcome);
        if (!outcome.error) setOpen(false);
      } catch {
        setResult({ error: "Something went wrong. Please try again." });
      }
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setResult(null);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant={triggerVariant} size="sm" disabled={disabled}>
          {trigger}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-col gap-2 text-sm text-[var(--color-muted-foreground)]">{description}</div>
          </DialogDescription>
        </DialogHeader>
        {result?.error ? <p className="text-sm text-[var(--color-error)]">{result.error}</p> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" variant={destructive ? "danger" : "primary"} onClick={run} disabled={pending}>
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
