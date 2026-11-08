import Link from "next/link";
import { PendingSubmitButton } from "@/components/ui/pending-submit-button";
import { Badge } from "@/components/ui/badge";
import { EFFECTIVE_LABEL, type EffectiveStatus } from "@/lib/teacher/request-status";

/**
 * Small shared pieces of the Teacher Portal and the admin approval queue
 * (Phase A). Server Components only: every form posts to a Server Action
 * that redirects back with ?ok= / ?err=.
 */

const OK_TEXT: Record<string, string> = {
  "1": "Done.",
  created: "Question created as Draft. Submit it for publication when it is ready.",
  draft: "Draft saved.",
  revision: "Revision saved. The published question is unchanged until the Master Admin approves it — submit the revision when it is ready.",
};

export function Flash({ ok, err }: { ok?: string; err?: string }) {
  if (err) return <p role="alert" className="rounded-[var(--radius-card)] border border-[var(--color-error)]/40 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]">{err}</p>;
  if (ok) return <p role="status" className="rounded-[var(--radius-card)] border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-3 py-2 text-sm text-[var(--color-success)]">{OK_TEXT[ok] ?? OK_TEXT["1"]}</p>;
  return null;
}

/** A form with a mandatory reason (min 10 characters, also enforced server-side). */
export function ReasonForm({
  action,
  hidden,
  label,
  button,
  variant = "outline",
  required = true,
  placeholder = "Reason (required, at least 10 characters)",
  field = "reason",
}: {
  action: (formData: FormData) => Promise<void>;
  hidden: Record<string, string>;
  label: string;
  button: string;
  variant?: "outline" | "primary" | "danger" | "secondary";
  required?: boolean;
  placeholder?: string;
  /** Posted field name: "reason" (teacher requests) or "note" (Master Admin decisions). */
  field?: "reason" | "note";
}) {
  return (
    <details className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-2 text-sm">
      <summary className="cursor-pointer select-none font-medium text-[var(--color-foreground)]">{label}</summary>
      <form action={action} className="mt-2 flex flex-col gap-2">
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <textarea
          name={field}
          required={required}
          minLength={required ? 10 : undefined}
          maxLength={1000}
          rows={2}
          placeholder={placeholder}
          className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)]"
        />
        <div>
          <PendingSubmitButton size="sm" variant={variant}>
            {button}
          </PendingSubmitButton>
        </div>
      </form>
    </details>
  );
}

const STATUS_VARIANT = { PENDING: "warning", APPLIED: "success", NOT_APPLIED: "info", REJECTED: "error", WITHDRAWN: "neutral" } as const;
/** Pending / Approved — action not yet applied / Applied / Rejected / Withdrawn (lib/teacher/request-status.ts). */
export function RequestStatusBadge({ status }: { status: EffectiveStatus }) {
  return <Badge variant={STATUS_VARIANT[status]} data-status={status}>{EFFECTIVE_LABEL[status]}</Badge>;
}

export const REQUEST_TYPE_LABEL = {
  PUBLISH_QUESTION: "Publish question",
  REVISION: "Revision of published question",
  UNPUBLISH_NOTICE: "Unpublished from Mock Test",
  UNPUBLISH_REQUEST: "Unpublish request",
  RESTORE_REQUEST: "Restore request",
  DELETE_REQUEST: "Permanent deletion request",
} as const;

export const TARGET_KIND_LABEL: Record<string, string> = { MOCK_TEST: "Mock Test", GRAND_TEST: "Grand Test", LIVE_TEST: "Live Test", PYQ_PAPER: "PYQ paper" };

export function QuestionStatusBadge({ status, retired }: { status: string; retired?: boolean }) {
  if (retired) return <Badge variant="error">Retired</Badge>;
  return <Badge variant={status === "PUBLISHED" ? "success" : status === "DRAFT" ? "warning" : "neutral"}>{status.charAt(0) + status.slice(1).toLowerCase()}</Badge>;
}

export function Pager({ page, pages, href }: { page: number; pages: number; href: (p: number) => string }) {
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex items-center gap-3 text-sm">
      {page > 1 ? <Link className="underline" href={href(page - 1)}>Previous</Link> : null}
      <span className="text-[var(--color-muted-foreground)]">
        Page {page} of {pages}
      </span>
      {page < pages ? <Link className="underline" href={href(page + 1)}>Next</Link> : null}
    </nav>
  );
}

export const fmtDate = (d: Date) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
