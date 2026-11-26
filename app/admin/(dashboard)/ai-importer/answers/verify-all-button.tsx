"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { confirmKeyPaperAction, verifyAllAnswersAction } from "../actions";

/** Per-paper Verify All Answers: re-matches the stored key (no AI / re-scan); an unconfirmed key needs an explicit, recorded confirmation first. */
export function VerifyAllButton({ jobId, title }: { jobId: string; title: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const go = () =>
    start(async () => {
      let r = await verifyAllAnswersAction(jobId);
      if (!r.ok) return setMsg(r.error);
      for (const k of r.data.needsConfirm) {
        if (k.state === "PROVISIONAL") {
          if (!confirm(`"${title}": answer key "${k.keyFile}" is recorded as PROVISIONAL, so its answers are NOT used.\n\n${k.detail}\n\nOK = re-confirm it as this paper's OFFICIAL key. Cancel = keep it provisional and verify anyway.`)) continue;
        } else if (!confirm(`"${title}": the paper identity of answer key "${k.keyFile}" could not be established.\n\n${k.detail}\n\nIts answers are NOT used until you confirm it belongs to this paper and series. Continue to confirm?`)) return setMsg(`Not verified: key "${k.keyFile}" is not confirmed for this paper.`);
        const note = (prompt("Say how you checked this key belongs to this paper (recorded, at least 10 characters):") ?? "").trim();
        if (!note) return setMsg("Cancelled: nothing changed.");
        // An explicit OK/Cancel choice (a typed word silently recorded official keys as PROVISIONAL, 2026-11-26).
        const official = confirm("Is this the OFFICIAL answer key published by the exam body (e.g. UPSC)?\n\nOK = OFFICIAL: its answers are used.\nCancel = PROVISIONAL: kept for reference only, never used as official answers.");
        const c = await confirmKeyPaperAction(jobId, k.keyFileId, note, official ? "OFFICIAL" : "PROVISIONAL");
        if (!c.ok) return setMsg(c.error);
      }
      if (r.data.needsConfirm.length) {
        r = await verifyAllAnswersAction(jobId, true);
        if (!r.ok) return setMsg(r.error);
      }
      const n = r.data.counts;
      setMsg(n ? `Matched ${n.MATCH} · Mismatched ${n.MISMATCH} · Unverified ${n.UNVERIFIED} · No Key ${n.NO_KEY}` : "Some keys still need confirmation.");
      router.push(`/admin/ai-importer/answers?job=${jobId}&verify=1`);
      router.refresh();
    });
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={go} data-testid="verify-all-job">
        {pending ? "Verifying…" : "Verify All Answers"}
      </Button>
      {msg && <span className="text-xs" data-testid="verify-all-job-msg">{msg}</span>}
    </span>
  );
}
