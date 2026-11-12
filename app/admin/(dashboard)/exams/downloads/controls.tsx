"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SelectNative } from "@/components/ui/select-native";
import { Label } from "@/components/ui/label";
import { generateNumberedOmrAction, setExamDownloadSwitchAction, setExamResourceActiveAction, type DownloadsActionState } from "./actions";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<DownloadsActionState | null>(null);
  const run = (fn: () => Promise<DownloadsActionState>) =>
    start(async () => {
      try {
        const r = await fn();
        setMsg(r);
        router.refresh();
      } catch {
        setMsg({ error: "Not allowed or failed. Only a Master Admin can change downloads." });
      }
    });
  const note = msg ? <p className={`text-xs ${msg.error ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>{msg.error ?? msg.success}</p> : null;
  return { pending, run, note };
}

export function DownloadsExamPicker({ exams, selectedExamId }: { exams: { id: string; name: string; code: string }[]; selectedExamId?: string }) {
  const router = useRouter();
  return (
    <div className="flex flex-col gap-1.5 sm:max-w-xs">
      <Label htmlFor="downloads-exam">Exam</Label>
      <SelectNative
        id="downloads-exam"
        value={selectedExamId ?? ""}
        onChange={(e) => router.push(e.target.value ? `/admin/exams?tab=downloads&examId=${e.target.value}` : "/admin/exams?tab=downloads")}
      >
        <option value="">Select an exam…</option>
        {exams.map((exam) => (
          <option key={exam.id} value={exam.id}>
            {exam.name} ({exam.code})
          </option>
        ))}
      </SelectNative>
    </div>
  );
}

export function DownloadSwitch({ examId, feature, label, enabled, canManage }: { examId: string; feature: string; label: string; enabled: boolean; canManage: boolean }) {
  const { pending, run, note } = useRun();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${enabled ? "bg-[var(--color-success)]/15 text-[var(--color-success)]" : "bg-[var(--color-surface)] text-[var(--color-muted-foreground)]"}`}>
          {enabled ? "ON" : "OFF"}
        </span>
        {canManage ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              if (!enabled && !window.confirm(`Turn ${label} ON for students?`)) return;
              run(() => setExamDownloadSwitchAction(examId, feature, !enabled));
            }}
          >
            {enabled ? "Turn OFF" : "Turn ON"}
          </Button>
        ) : null}
      </div>
      {note}
    </div>
  );
}

export function GenerateOmrButton({ examId }: { examId: string }) {
  const { pending, run, note } = useRun();
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" size="sm" disabled={pending} onClick={() => run(() => generateNumberedOmrAction(examId))}>
        {pending ? "Generating…" : "Generate OMR sheet"}
      </Button>
      {note}
    </div>
  );
}

export function ResourceActiveButton({ resourceId, isActive }: { resourceId: string; isActive: boolean }) {
  const { pending, run, note } = useRun();
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => setExamResourceActiveAction(resourceId, !isActive))}>
        {isActive ? "Deactivate" : "Activate"}
      </Button>
      {note}
    </div>
  );
}
