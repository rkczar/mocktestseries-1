"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  deleteCustomModuleAction,
  deleteMockTestAction,
  getCustomModuleDeleteCheckAction,
  getMockTestDeleteCheckAction,
} from "@/app/admin/(dashboard)/tests/delete-actions";
import { setMockTestStatusAction } from "@/app/admin/(dashboard)/tests/mock/actions";
import { setCustomModuleStatusAction } from "@/app/admin/(dashboard)/custom-modules/actions";
import type { TestDeleteCheck } from "@/lib/test-deletion";

const FLASH_KEY = "mts-admin-test-deleted";
const FLASH_EVENT = "mts:test-deleted";

/** Survives the row unmounting (list refresh) and the detail page redirect. */
function flash(message: string) {
  try {
    sessionStorage.setItem(FLASH_KEY, message);
  } catch {}
  window.dispatchEvent(new CustomEvent(FLASH_EVENT, { detail: message }));
}

/** Success banner for admin lists; rendered outside the rows so it outlives them. */
export function TestDeletedNotice() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const take = () => {
      try {
        const m = sessionStorage.getItem(FLASH_KEY);
        if (m) {
          sessionStorage.removeItem(FLASH_KEY);
          setMessage(m);
        }
      } catch {}
    };
    take();
    const onEvent = (e: Event) => {
      setMessage((e as CustomEvent<string>).detail);
      try {
        sessionStorage.removeItem(FLASH_KEY);
      } catch {}
    };
    window.addEventListener(FLASH_EVENT, onEvent);
    return () => window.removeEventListener(FLASH_EVENT, onEvent);
  }, []);
  if (!message) return null;
  return (
    <div
      role="status"
      data-testid="test-deleted-notice"
      className="mb-3 flex items-start justify-between gap-3 rounded-[var(--radius-button)] border border-[var(--color-success)] bg-[var(--color-success)]/10 px-3 py-2 text-sm text-[var(--color-foreground)]"
    >
      <span>{message}</span>
      <button type="button" onClick={() => setMessage(null)} className="text-xs text-[var(--color-muted-foreground)] hover:underline">
        Dismiss
      </button>
    </div>
  );
}

/**
 * Delete action for one admin-created test (Mock Test incl. Live CBT, or an
 * admin Custom Module). The server re-checks every dependency inside the
 * deleting transaction; this dialog only shows the current summary.
 */
export function DeleteTestDialog({
  kind,
  id,
  title,
  trigger = "link",
  afterDeleteHref,
}: {
  kind: "mock" | "custom";
  id: string;
  title: string;
  trigger?: "link" | "button";
  /** Where to go after deleting (detail pages); lists just refresh in place. */
  afterDeleteHref?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<TestDeleteCheck | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const loadCheck = () => {
    setLoading(true);
    (kind === "mock" ? getMockTestDeleteCheckAction(id) : getCustomModuleDeleteCheckAction(id))
      .then((res) => {
        if ("error" in res) setError(res.error);
        else setCheck(res.check);
      })
      .catch(() => setError("Could not check this test's dependencies. Try again."))
      .finally(() => setLoading(false));
  };

  const handleOpen = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    setError(null);
    setConfirmText("");
    setCheck(null);
    if (next) loadCheck();
  };

  const handleDelete = () => {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await (kind === "mock" ? deleteMockTestAction(id) : deleteCustomModuleAction(id));
        if (!res.ok) {
          setError(res.reason);
          if (res.check) setCheck(res.check);
          return;
        }
        flash(`Deleted "${res.title}" permanently.`);
        setOpen(false);
        if (afterDeleteHref) router.push(afterDeleteHref);
        else router.refresh();
      } catch {
        setError("The test was not deleted — the request failed. Please try again.");
      }
    });
  };

  const handleArchive = () => {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      try {
        if (kind === "mock") {
          const res = await setMockTestStatusAction(id, "ARCHIVED");
          if (res.error) return setError(res.error);
        } else {
          await setCustomModuleStatusAction(id, "ARCHIVED");
        }
        flash(`Archived "${title}" — hidden from students; all attempts and results are kept.`);
        setOpen(false);
        router.refresh();
      } catch {
        setError("Could not archive this test. Please try again.");
      }
    });
  };

  const canConfirm = Boolean(check?.canDelete) && confirmText.trim() === "DELETE" && !pending;
  const tiles: [string, number][] = check
    ? [
        ["Questions", check.questions],
        ["Attempts", check.attempts],
        ...(check.enrollments !== null ? ([["Enrollments", check.enrollments]] as [string, number][]) : []),
      ]
    : [];

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        {trigger === "button" ? (
          <Button type="button" size="sm" variant="outline" className="border-[var(--color-error)] text-[var(--color-error)]" data-testid="delete-test-trigger">
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
          </Button>
        ) : (
          <button type="button" className="text-[var(--color-error)] hover:underline" data-testid="delete-test-trigger" aria-label={`Delete ${title}`}>
            Delete
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto" data-testid="delete-test-dialog">
        <DialogHeader>
          <DialogTitle>{check && !check.canDelete ? "This test cannot be permanently deleted" : "Delete this test permanently?"}</DialogTitle>
          <DialogDescription className="break-words">
            <span className="font-medium text-[var(--color-foreground)]">{check?.title ?? title}</span>
            {check ? <span className="block">{check.typeLabel} · {check.status}</span> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {loading ? <p className="text-sm text-[var(--color-muted-foreground)]">Checking attempts, enrollments and payments…</p> : null}
          {check ? (
            <>
              <div className="grid grid-cols-3 gap-2 text-sm">
                {tiles.map(([label, n]) => (
                  <div key={label} className="rounded-md border border-[var(--color-border)] px-2 py-1.5">
                    <div className="text-base font-semibold text-[var(--color-foreground)]">{n}</div>
                    <div className="text-xs text-[var(--color-muted-foreground)]">{label}</div>
                  </div>
                ))}
              </div>
              {check.canDelete ? (
                <>
                  <Alert variant="destructive">
                    <AlertDescription>
                      This action cannot be undone. Only this test and its question links are removed — the questions stay in the Question Bank.
                    </AlertDescription>
                  </Alert>
                  <label className="flex flex-col gap-1 text-sm text-[var(--color-foreground)]">
                    Type DELETE to confirm
                    <Input
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder="DELETE"
                      autoComplete="off"
                      autoCapitalize="characters"
                      aria-label="Type DELETE to confirm"
                    />
                  </label>
                </>
              ) : (
                <Alert variant="destructive">
                  <AlertDescription>
                    <p>This test has student activity or protected dependencies and cannot be permanently deleted.</p>
                    <ul className="mt-2 list-disc pl-5">
                      {check.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                    {check.canArchive ? <p className="mt-2">You can Archive it instead: it is hidden from students and every attempt and result is kept.</p> : null}
                  </AlertDescription>
                </Alert>
              )}
            </>
          ) : null}
          {error ? (
            <p className="text-sm text-[var(--color-error)]" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="flex-wrap">
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          {check && !check.canDelete && check.canArchive ? (
            <Button variant="secondary" disabled={pending} onClick={handleArchive}>
              {pending ? "Archiving…" : "Archive instead"}
            </Button>
          ) : null}
          {check?.canDelete ? (
            <Button variant="danger" disabled={!canConfirm} onClick={handleDelete}>
              {pending ? "Deleting…" : "Delete permanently"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
