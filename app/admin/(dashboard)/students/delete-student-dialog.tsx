"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { adminDeleteStudentAction, getStudentDeletionPreviewAction, type StudentDeletionPreview } from "./actions";

const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });
const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * Delete Student Account (MASTER_ADMIN). Everything shown and done here is re-checked on the server; this only
 * collects an explicit confirmation. `afterDelete` = where to go once the account is gone (the detail page leaves).
 */
export function DeleteStudentDialog({ studentDbId, afterDelete, size = "sm" }: { studentDbId: string; afterDelete?: string; size?: "sm" | "default" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<StudentDeletionPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    setError(null);
    if (!next) return;
    setPreview(null);
    setLoadError(null);
    setCode("");
    setReason("");
    getStudentDeletionPreviewAction(studentDbId)
      .then((r) => (r.ok ? setPreview(r.preview) : setLoadError(r.error)))
      .catch(() => setLoadError("Could not load this student."));
  };

  const confirm = () => {
    setError(null);
    startTransition(async () => {
      try {
        const r = await adminDeleteStudentAction(studentDbId, code, reason);
        if (!r.ok) return setError(r.error ?? "Could not delete this account.");
        setOpen(false);
        if (afterDelete) router.push(afterDelete);
        else router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not delete this account.");
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size={size} variant="danger" data-testid="delete-student">
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="delete-student-dialog">
        <DialogHeader>
          <DialogTitle>Delete student account?</DialogTitle>
          <DialogDescription>
            This cannot be undone. The account is anonymized and signed out everywhere; its email and mobile number are released so the person can register again.
            Attempts, payments, orders and invoices are kept (anonymized). It is recorded under Deletion Requests and Deleted Students.
          </DialogDescription>
        </DialogHeader>
        {loadError ? <p className="text-sm text-[var(--color-error)]">{loadError}</p> : null}
        {!preview && !loadError ? <p className="text-sm text-[var(--color-muted-foreground)]">Loading…</p> : null}
        {preview ? (
          <div className="flex flex-col gap-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-testid="delete-student-summary">
              <dt className="text-[var(--color-muted-foreground)]">Student</dt>
              <dd className="font-medium">
                {preview.name} <span className="font-mono text-xs text-[var(--color-muted-foreground)]">{preview.studentCode}</span>
              </dd>
              <dt className="text-[var(--color-muted-foreground)]">Mobile</dt>
              <dd>{preview.mobile ?? "—"}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Email</dt>
              <dd className="break-all">{preview.email ?? "—"}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Registered</dt>
              <dd>{fmt(preview.createdAt)}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Exams</dt>
              <dd>{preview.exams.length ? preview.exams.join(", ") : "None selected"}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Active access</dt>
              <dd>{preview.activeAccess.length ? preview.activeAccess.join(", ") : "None"}</dd>
              <dt className="text-[var(--color-muted-foreground)]">Payments</dt>
              <dd>{preview.paidOrders ? `${preview.paidOrders} paid order(s), ${inr(preview.paidTotalPaise)} (kept)` : "No paid orders"}</dd>
            </dl>
            {preview.pendingRequest ? <p className="text-xs text-[var(--color-muted-foreground)]">The student already requested deletion; that request will be approved.</p> : null}
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--color-muted-foreground)]">Reason (kept in the deletion record)</span>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-testid="delete-student-reason" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-[var(--color-muted-foreground)]">
                Type <span className="font-mono font-semibold text-[var(--color-foreground)]">{preview.studentCode}</span> to confirm
              </span>
              <Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" data-testid="delete-student-code" />
            </label>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-[var(--color-error)]">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="danger"
            onClick={confirm}
            disabled={pending || !preview || code.trim().toUpperCase() !== preview.studentCode.toUpperCase() || reason.trim().length < 3}
            data-testid="delete-student-confirm"
          >
            {pending ? "Deleting…" : "Delete account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
