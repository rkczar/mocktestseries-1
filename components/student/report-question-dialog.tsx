"use client";

import { useState, useTransition } from "react";
import { Flag } from "lucide-react";
import type { ReportType } from "@prisma/client";
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
import { SelectNative } from "@/components/ui/select-native";
import { Label } from "@/components/ui/label";

const REPORT_TYPES: { value: ReportType; label: string }[] = [
  { value: "WRONG_ANSWER", label: "Wrong answer marked as correct" },
  { value: "WRONG_QUESTION", label: "Wrong question (text/options don't make sense)" },
  { value: "INCORRECT_EXPLANATION", label: "Incorrect AI explanation" },
  { value: "IMAGE_ISSUE", label: "Image is missing or broken" },
  { value: "OTHER", label: "Other" },
];

export function ReportQuestionDialog({ onSubmit }: { onSubmit: (reportType: ReportType, message: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reportType, setReportType] = useState<ReportType>("OTHER");
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();

  const reset = () => {
    setDone(false);
    setMessage("");
    setReportType("OTHER");
  };

  const handleSubmit = () => {
    startTransition(async () => {
      await onSubmit(reportType, message);
      setDone(true);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Flag className="h-4 w-4" aria-hidden /> Report
        </Button>
      </DialogTrigger>
      <DialogContent>
        {done ? (
          <>
            <DialogHeader>
              <DialogTitle>Report submitted</DialogTitle>
              <DialogDescription>Thank you — Admin will review this question.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button>Close</Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Report this question</DialogTitle>
              <DialogDescription>Let Admin know what&apos;s wrong with this question.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reportType">Issue type</Label>
                <SelectNative id="reportType" value={reportType} onChange={(e) => setReportType(e.target.value as ReportType)}>
                  {REPORT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </SelectNative>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reportMessage">Details (optional)</Label>
                <textarea
                  id="reportMessage"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
                />
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button onClick={handleSubmit} disabled={isPending}>
                {isPending ? "Submitting…" : "Submit Report"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
