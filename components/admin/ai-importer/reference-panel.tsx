"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import { applyReferenceAnswersAction, unlinkReferenceAction } from "@/app/admin/(dashboard)/ai-importer/actions";
import { ACCEPT, STAGE_LABEL, uploadReferenceFile } from "@/components/admin/ai-importer/upload-client";

export interface ReferenceRow {
  refId: string;
  name: string;
  questions: number;
  key: number;
  note: string | null;
  /** stored / text extracted / compared / not compared (lib/ai-import/reference-status.ts). */
  status?: string | null;
}

/** The import's reference papers: add, download the original, unlink (the file is kept), use their answers. */
export function ReferencePanel({ jobId, refs, canUse }: { jobId: string; refs: ReferenceRow[]; canUse: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="reference-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Reference papers</span>
        <span className="text-xs text-[var(--color-muted-foreground)]">supporting evidence for Verify 1 — conflicts are shown, the question paper is never changed by them</span>
      </div>
      {refs.length ? (
        <ul className="flex flex-col gap-1" data-testid="reference-list">
          {refs.map((r) => (
            <li key={r.refId} className="flex flex-wrap items-center gap-2" data-testid="reference-row">
              <a className="underline" href={`/api/admin/ai-importer/references/${jobId}/${r.refId}`}>
                {r.name}
              </a>
              <span className="text-xs text-[var(--color-muted-foreground)]" data-testid="reference-status">
                {r.status ?? `${r.questions} question(s)${r.key ? `, ${r.key} answer-key entries` : ""}${r.note ? ` · ${r.note}` : ""}`}
              </span>
              {canUse && (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => confirm(`Unlink “${r.name}” from this import? Its file is kept.`) && start(async () => {
                  const x = await callImporter(() => unlinkReferenceAction(jobId, r.refId));
                  setMsg(x.ok ? { ok: true, text: "Reference unlinked (file kept). Run Verify 1 again." } : { ok: false, text: x.error ?? "Failed" });
                  if (x.ok) router.refresh();
                })}>
                  Unlink
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-[var(--color-muted-foreground)]">No reference paper. Add a previous paper, a clean copy or an answer-key document to cross-check this import.</p>
      )}
      {canUse && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()} data-testid="reference-add">
            {busy ? "Reading…" : "Add reference paper"}
          </Button>
          {refs.length > 0 && (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => confirm("Take the reference paper's answer for every question that has no answer? Only answers that fit the question's options and type are used; each is recorded as your decision.") && start(async () => {
              const x = await callImporter(() => applyReferenceAnswersAction(jobId, []));
              setMsg(x.ok ? { ok: true, text: `${x.data.applied} answer(s) taken from the reference.` } : { ok: false, text: x.error ?? "Failed" });
              if (x.ok) router.refresh();
            })} data-testid="reference-answers">
              Use reference answers
            </Button>
          )}
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setBusy(true);
              setMsg({ ok: true, text: `Uploading “${f.name}”… 0%` });
              const r = await uploadReferenceFile(jobId, f, (p) => setMsg({ ok: true, text: `Uploading “${f.name}”… ${p}%` }));
              setBusy(false);
              setMsg(r.ok ? { ok: true, text: `“${f.name}” added: ${r.note}. Run Verify 1 to compare.` } : { ok: false, text: `${STAGE_LABEL[r.stage]} failed — ${f.name}: ${r.error}` });
              if (r.ok) router.refresh();
            }}
            data-testid="reference-input"
          />
        </div>
      )}
      {msg && (
        <p className={`text-xs ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} role={msg.ok ? "status" : "alert"} data-testid="reference-msg">
          {msg.text}
        </p>
      )}
    </div>
  );
}
