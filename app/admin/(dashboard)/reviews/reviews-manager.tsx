"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatIst } from "@/lib/ist-time";
import { bulkReviewAction, setReviewOrderAction, type ReviewActionResult, type ReviewBulkOperation } from "./actions";
import { ReviewForm } from "./review-form";

export interface AdminReviewRow {
  id: string;
  source: "STUDENT_SUBMITTED" | "ADMIN_ADDED";
  status: "PENDING" | "APPROVED" | "REJECTED";
  isPublished: boolean;
  isFeatured: boolean;
  displayOrder: number;
  displayName: string;
  rating: number;
  comment: string;
  examName: string | null;
  original: { displayName: string | null; rating: number | null; comment: string } | null;
  studentCode: string | null;
  studentInactive: boolean;
  createdAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedAt: string | null;
  editedAt: string | null;
  editedBy: string | null;
  createdBy: string | null;
}

const STATUS_VARIANT = { PENDING: "warning", APPROVED: "success", REJECTED: "error" } as const;
const BULK: { op: ReviewBulkOperation; label: string; variant?: "outline" | "danger" }[] = [
  { op: "approve_publish", label: "Approve & Publish" },
  { op: "publish", label: "Publish", variant: "outline" },
  { op: "unpublish", label: "Unpublish", variant: "outline" },
  { op: "reject", label: "Reject", variant: "outline" },
  { op: "feature", label: "Feature", variant: "outline" },
  { op: "unfeature", label: "Unfeature", variant: "outline" },
  { op: "delete", label: "Delete", variant: "danger" },
];

export function ReviewsManager({ rows, canManage, emptyText }: { rows: AdminReviewRow[]; canManage: boolean; emptyText: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<AdminReviewRow | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const visibleIds = rows.map((r) => r.id);
  const selectedIds = visibleIds.filter((id) => selected.has(id));
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;

  const run = (fn: () => Promise<ReviewActionResult>, after?: () => void) => {
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await fn();
        setMessage(result.ok ? { tone: "ok", text: result.message ?? "Done." } : { tone: "error", text: result.error });
        if (result.ok) {
          after?.();
          router.refresh();
        }
      } catch {
        setMessage({ tone: "error", text: "Something went wrong. Please try again." });
      }
    });
  };

  const bulk = (op: ReviewBulkOperation, ids: string[]) => {
    if (op === "delete" && !confirm(`Permanently delete ${ids.length} review${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    run(() => bulkReviewAction(op, ids), () => setSelected(new Set()));
  };

  if (rows.length === 0) {
    return <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">{emptyText}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Bulk actions">
          <span className="text-sm text-[var(--color-muted-foreground)]">{selectedIds.length} selected</span>
          {BULK.map((b) => (
            <Button key={b.op} size="sm" variant={b.variant ?? "primary"} disabled={pending || selectedIds.length === 0} onClick={() => bulk(b.op, selectedIds)}>
              {b.label}
            </Button>
          ))}
        </div>
      ) : null}
      {message ? (
        <p role="status" className={`text-sm ${message.tone === "ok" ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>
          {message.text}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
              {canManage ? (
                <th className="w-8 py-2 pr-3">
                  <input
                    type="checkbox"
                    aria-label="Select all reviews"
                    checked={allSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(visibleIds) : new Set())}
                  />
                </th>
              ) : null}
              <th className="py-2 pr-4">Review</th>
              <th className="py-2 pr-4">Source</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Order</th>
              <th className="py-2 pr-4">Dates</th>
              {canManage ? <th className="py-2 pr-4">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-[var(--color-border)] align-top last:border-0">
                {canManage ? (
                  <td className="py-3 pr-3">
                    <input
                      type="checkbox"
                      aria-label={`Select review by ${r.displayName}`}
                      checked={selected.has(r.id)}
                      onChange={(e) =>
                        setSelected((cur) => {
                          const next = new Set(cur);
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          return next;
                        })
                      }
                    />
                  </td>
                ) : null}
                <td className="max-w-[420px] py-3 pr-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-[var(--color-foreground)]">{r.displayName}</span>
                    <span className="inline-flex items-center gap-0.5 text-[var(--color-warning)]" aria-label={`${r.rating} out of 5 stars`}>
                      {r.rating}
                      <Star className="h-3.5 w-3.5 fill-current" aria-hidden />
                    </span>
                    {r.isFeatured ? <Badge variant="primary">Featured</Badge> : null}
                  </div>
                  {r.examName ? <p className="text-xs text-[var(--color-muted-foreground)]">{r.examName}</p> : null}
                  <p className="mt-1 whitespace-pre-line break-words text-[var(--color-foreground)]">{r.comment}</p>
                  {r.original && (r.original.comment !== r.comment || r.original.rating !== r.rating || r.original.displayName !== r.displayName) ? (
                    <details className="mt-2 text-xs text-[var(--color-muted-foreground)]">
                      <summary className="cursor-pointer">Edited — view original student submission</summary>
                      <p className="mt-1">
                        {r.original.displayName} · {r.original.rating}★
                      </p>
                      <p className="mt-1 whitespace-pre-line break-words">{r.original.comment}</p>
                    </details>
                  ) : null}
                </td>
                <td className="py-3 pr-4">
                  {r.source === "STUDENT_SUBMITTED" ? (
                    <div className="flex flex-col gap-1">
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-success)]">
                        <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
                        Student-submitted
                      </span>
                      {r.studentCode ? <span className="font-mono text-xs text-[var(--color-muted-foreground)]">{r.studentCode}</span> : null}
                      {r.studentInactive ? <span className="text-xs text-[var(--color-warning)]">Account inactive — not shown publicly</span> : null}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-[var(--color-muted-foreground)]">Admin-added</span>
                      {r.createdBy ? <span className="text-xs text-[var(--color-muted-foreground)]">by {r.createdBy}</span> : null}
                    </div>
                  )}
                </td>
                <td className="py-3 pr-4">
                  <div className="flex flex-col items-start gap-1">
                    <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>
                    <Badge variant={r.isPublished ? "info" : "neutral"}>{r.isPublished ? "PUBLISHED" : "HIDDEN"}</Badge>
                  </div>
                </td>
                <td className="py-3 pr-4">
                  {canManage ? (
                    <Input
                      type="number"
                      className="h-8 w-20"
                      aria-label={`Display order for ${r.displayName}`}
                      defaultValue={r.displayOrder}
                      min={-9999}
                      max={9999}
                      onBlur={(e) => {
                        const value = Number(e.target.value);
                        if (Number.isInteger(value) && value !== r.displayOrder) run(() => setReviewOrderAction(r.id, value));
                      }}
                    />
                  ) : (
                    <span className="tabular-nums">{r.displayOrder}</span>
                  )}
                </td>
                <td className="py-3 pr-4 text-xs text-[var(--color-muted-foreground)]">
                  <p>Created {formatIst(new Date(r.createdAt))}</p>
                  {r.approvedAt ? (
                    <p>
                      Approved {formatIst(new Date(r.approvedAt))}
                      {r.approvedBy ? ` by ${r.approvedBy}` : ""}
                    </p>
                  ) : null}
                  {r.rejectedAt ? <p>Rejected {formatIst(new Date(r.rejectedAt))}</p> : null}
                  {r.editedAt ? (
                    <p>
                      Edited {formatIst(new Date(r.editedAt))}
                      {r.editedBy ? ` by ${r.editedBy}` : ""}
                    </p>
                  ) : null}
                </td>
                {canManage ? (
                  <td className="py-3 pr-4">
                    <div className="flex flex-wrap gap-1.5">
                      {r.status !== "APPROVED" ? (
                        <Button size="compact" disabled={pending} onClick={() => bulk("approve", [r.id])}>
                          Approve
                        </Button>
                      ) : null}
                      {r.status !== "REJECTED" && r.source === "STUDENT_SUBMITTED" ? (
                        <Button size="compact" variant="outline" disabled={pending} onClick={() => bulk("reject", [r.id])}>
                          Reject
                        </Button>
                      ) : null}
                      {r.status === "APPROVED" ? (
                        <Button size="compact" variant="outline" disabled={pending} onClick={() => bulk(r.isPublished ? "unpublish" : "publish", [r.id])}>
                          {r.isPublished ? "Unpublish" : "Publish"}
                        </Button>
                      ) : null}
                      <Button size="compact" variant="outline" disabled={pending} onClick={() => bulk(r.isFeatured ? "unfeature" : "feature", [r.id])}>
                        {r.isFeatured ? "Unfeature" : "Feature"}
                      </Button>
                      <Button size="compact" variant="outline" disabled={pending} onClick={() => setEditing(r)}>
                        Edit
                      </Button>
                      <Button size="compact" variant="ghost" disabled={pending} onClick={() => bulk("delete", [r.id])}>
                        Delete
                      </Button>
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit review</DialogTitle>
            <DialogDescription>
              {editing?.source === "STUDENT_SUBMITTED"
                ? "Editing changes what the homepage shows. The student's original submission and its source are kept unchanged."
                : "Admin-added testimonial."}
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <ReviewForm
              key={editing.id}
              mode="edit"
              initial={{
                id: editing.id,
                displayName: editing.displayName,
                rating: editing.rating,
                comment: editing.comment,
                examName: editing.examName,
                isFeatured: editing.isFeatured,
                isPublished: editing.isPublished,
                displayOrder: editing.displayOrder,
                approved: editing.status === "APPROVED",
              }}
              onDone={() => {
                setEditing(null);
                router.refresh();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
