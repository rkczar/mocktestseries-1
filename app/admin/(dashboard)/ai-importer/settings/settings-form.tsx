"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import type { ImporterSettings } from "@/lib/ai-import/config";
import { saveSettingsAction } from "../actions";

export interface ModelOption {
  id: string;
  name: string;
  vision: boolean;
  promptPerM: number | null;
  completionPerM: number | null;
  context: number | null;
  synced: string;
}

function ModelSelect({ id, label, value, models, vision, onChange, disabled, help }: { id: string; label: string; value: string | null; models: ModelOption[]; vision: boolean; onChange: (v: string | null) => void; disabled: boolean; help: string }) {
  const list = models.filter((m) => !vision || m.vision);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <SelectNative id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} disabled={disabled} data-testid={id}>
        <option value="">Not set</option>
        {list.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id} — ${m.promptPerM?.toFixed(3) ?? "?"}/${m.completionPerM?.toFixed(3) ?? "?"} per M tokens
          </option>
        ))}
        {value && !list.some((m) => m.id === value) && <option value={value}>{value} (not approved / not usable)</option>}
      </SelectNative>
      <p className="text-xs text-[var(--color-muted-foreground)]">{help}</p>
    </div>
  );
}

const num = (v: string) => (v.trim() === "" ? NaN : Number(v));

export function SettingsForm({ initial, models, canManage }: { initial: ImporterSettings; models: ModelOption[]; canManage: boolean }) {
  const router = useRouter();
  const [s, setS] = useState<ImporterSettings>(initial);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const d = !canManage;
  const set = <K extends keyof ImporterSettings>(k: K, v: Partial<ImporterSettings[K]>) => setS((cur) => ({ ...cur, [k]: { ...(cur[k] as object), ...v } }));
  const field = (id: string, label: string, value: number, onChange: (n: number) => void, help?: string) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} inputMode="decimal" defaultValue={String(value)} onBlur={(e) => onChange(num(e.target.value))} disabled={d} data-testid={id} />
      {help && <p className="text-xs text-[var(--color-muted-foreground)]">{help}</p>}
    </div>
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveSettingsAction(s);
          if (r.ok) {
            setS(r.data);
            setMsg({ ok: true, text: "Settings saved." });
            router.refresh();
          } else setMsg({ ok: false, text: r.error });
        });
      }}
      data-testid="settings-form"
    >
      <Card>
        <CardHeader>
          <CardTitle>Paid AI processing</CardTitle>
          <CardDescription>Off: only local parsing (digital PDFs, DOCX, spreadsheets) runs and scanned pages are flagged. On: AI calls run only after a job&apos;s estimate is confirmed, inside the budgets below.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.aiEnabled} onChange={(e) => setS({ ...s, aiEnabled: e.target.checked })} disabled={d} data-testid="ai-enabled" />
            Allow paid AI calls for the importer
          </label>
          <div className="grid gap-4 md:grid-cols-2">
            <ModelSelect id="m-extract" label="Extraction model (vision)" value={s.models.extract} models={models} vision onChange={(v) => set("models", { extract: v })} disabled={d} help="Reads scanned pages, formulas and figure positions." />
            <ModelSelect id="m-fallback" label="Fallback extraction model (vision)" value={s.models.extractFallbacks[0] ?? null} models={models} vision onChange={(v) => set("models", { extractFallbacks: v ? [v] : [] })} disabled={d} help="Tried only when the extraction model is unavailable." />
            <ModelSelect id="m-verify" label="Independent check model (different vendor)" value={s.models.verify} models={models} vision onChange={(v) => set("models", { verify: v })} disabled={d} help="Second read of scanned / low-confidence pages, and the optional answer opinion." />
            <ModelSelect id="m-classify" label="Topic classification model" value={s.models.classify} models={models} vision={false} onChange={(v) => set("models", { classify: v })} disabled={d} help="Maps questions to the exam's existing topics (ids only)." />
            <ModelSelect id="m-key" label="Answer-key reading model (vision)" value={s.models.key} models={models} vision onChange={(v) => set("models", { key: v })} disabled={d} help="Scanned answer keys only. Blank = the extraction model." />
          </div>
          {!models.length && <p className="text-sm text-[var(--color-warning)]">No approved models with a published price. Approve models in AI → Models first.</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Privacy</CardTitle>
          <CardDescription>Applied to every importer request as an OpenRouter provider requirement. OpenRouter routes only to providers whose policy matches; it cannot verify a provider&apos;s internal practice.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="dc" checked={s.privacy.dataCollection === "deny"} onChange={() => set("privacy", { dataCollection: "deny" })} disabled={d} data-testid="privacy-deny" />
            Only providers that do not store or train on prompts (recommended)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="dc" checked={s.privacy.dataCollection === "allow"} onChange={() => set("privacy", { dataCollection: "allow" })} disabled={d} />
            Allow providers that may store or train on prompts
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.privacy.zdr} onChange={(e) => set("privacy", { zdr: e.target.checked })} disabled={d} />
            Zero-data-retention endpoints only (fewer models available)
          </label>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Budgets and limits</CardTitle>
          <CardDescription>The importer budget is separate from the student Ask AI budget. A job pauses before its own cap or the monthly budget would be exceeded — retries and parallel pages included.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {field("b-month", "Monthly importer budget (₹)", s.budget.monthlyInr, (n) => set("budget", { monthlyInr: n }))}
          {field("b-job", "Default job budget (₹)", s.budget.defaultJobCapInr, (n) => set("budget", { defaultJobCapInr: n }))}
          {field("b-req", "Maximum per AI request (₹)", s.budget.maxRequestInr, (n) => set("budget", { maxRequestInr: n }))}
          {field("l-file", "Maximum file size (MB)", s.limits.maxFileMb, (n) => set("limits", { maxFileMb: n }))}
          {field("l-pages", "Maximum pages per file", s.limits.maxPagesPerFile, (n) => set("limits", { maxPagesPerFile: n }))}
          {field("l-files", "Maximum files per import", s.limits.maxFilesPerJob, (n) => set("limits", { maxFilesPerJob: n }))}
          {field("l-dpi", "Page render resolution (dpi)", s.limits.renderDpi, (n) => set("limits", { renderDpi: n }))}
          {field("l-conc", "Parallel AI requests (1–3)", s.limits.concurrency, (n) => set("limits", { concurrency: n }))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Verification and publishing policy</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="grid gap-4 sm:grid-cols-3">
            {field("v-second", "Second read below confidence (0–1)", s.verification.secondReadBelow, (n) => set("verification", { secondReadBelow: n }))}
            {field("v-topic", "Accept AI topic from confidence (0–1)", s.verification.topicMinConfidence, (n) => set("verification", { topicMinConfidence: n }))}
            {field("v-dup", "Near-duplicate similarity (0.5–1)", s.verification.nearDuplicateAt, (n) => set("verification", { nearDuplicateAt: n }))}
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.verification.independentAnswer} onChange={(e) => set("verification", { independentAnswer: e.target.checked })} disabled={d} data-testid="v-independent" />
            Ask the independent model for its own answer to every question (an opinion only; it never replaces the official key)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.publish.allowUnverifiedAnswers} onChange={(e) => set("publish", { allowUnverifiedAnswers: e.target.checked })} disabled={d} data-testid="p-unverified" />
            Allow bulk publishing of questions without an official key (their answer stays marked UNVERIFIED in the Question Bank)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.publish.requireTopic} onChange={(e) => set("publish", { requireTopic: e.target.checked })} disabled={d} />
            Require a topic before a question can be published
          </label>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Retention</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="grid gap-4 sm:grid-cols-3">
            {field("r-orig", "Keep original papers (days)", s.retention.originalDays, (n) => set("retention", { originalDays: n }), "Applies to new uploads; extend single files in the Vault.")}
            {field("r-int", "Keep page renders of finished jobs (days)", s.retention.intermediateDays, (n) => set("retention", { intermediateDays: n }))}
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={s.retention.autoCleanup} onChange={(e) => set("retention", { autoCleanup: e.target.checked })} disabled={d} data-testid="r-auto" />
            Remove expired temporary files, renders and originals automatically (same reference checks as the Storage Manager)
          </label>
        </CardContent>
      </Card>
      {msg && <p className={`text-sm ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} data-testid="settings-msg">{msg.text}</p>}
      {canManage && (
        <div>
          <Button type="submit" disabled={pending} data-testid="settings-save">
            {pending ? "Saving…" : "Save settings"}
          </Button>
        </div>
      )}
    </form>
  );
}
