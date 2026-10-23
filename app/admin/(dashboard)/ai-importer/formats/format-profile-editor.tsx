"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import { updateFormatProfileAction } from "../actions";
import type { FormatProfile, FormatRules } from "@/lib/ai-import/format-profile";

/** Inspect a format profile; Master Admin edits its rules or disables it (each save is a new version). */
export function FormatProfileEditor({ profile, canEdit }: { profile: FormatProfile; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [name, setName] = useState(profile.name);
  const [rules, setRules] = useState<FormatRules>(profile.rules);
  const [ocr, setOcr] = useState(profile.rules.ocrErrors.map((e) => `${e.wrong} => ${e.right}`).join("\n"));
  const set = <K extends keyof FormatRules>(k: K, v: FormatRules[K]) => setRules((r) => ({ ...r, [k]: v }));
  const save = (patch: { enabled?: boolean }) =>
    start(async () => {
      const ocrErrors = ocr
        .split("\n")
        .map((l) => l.split("=>").map((x) => x.trim()))
        .filter((x) => x.length === 2 && x[0])
        .map(([wrong, right]) => ({ wrong, right }));
      const r = await callImporter(() => updateFormatProfileAction({ id: profile.id, name, rules: { ...rules, ocrErrors }, ...patch, note: patch.enabled === false ? "disabled by Master Admin" : patch.enabled ? "enabled by Master Admin" : "edited by Master Admin" }));
      setMsg(r.ok ? { ok: true, text: `Saved as version ${r.data.version}.` } : { ok: false, text: r.error ?? "Failed" });
      if (r.ok) router.refresh();
    });
  const ro = !canEdit || pending;
  return (
    <div className="flex flex-col gap-2" data-testid="format-profile-editor">
      <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1">
          Name
          <Input value={name} disabled={ro} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          Option labels (shape of the first label)
          <Input value={rules.optionLabels ?? ""} disabled={ro} placeholder="(a)" onChange={(e) => set("optionLabels", e.target.value || null)} />
        </label>
        <label className="flex flex-col gap-1">
          Numbered statements
          <SelectNative value={rules.statementNumbering ?? ""} disabled={ro} onChange={(e) => set("statementNumbering", (e.target.value || null) as FormatRules["statementNumbering"])}>
            <option value="">not used</option>
            <option value="roman">I, II, III</option>
            <option value="arabic">1, 2, 3</option>
            <option value="letter">A, B, C</option>
          </SelectNative>
        </label>
        <label className="flex flex-col gap-1">
          Answer placement
          <SelectNative value={rules.answerPlacement} disabled={ro} onChange={(e) => set("answerPlacement", e.target.value as FormatRules["answerPlacement"])}>
            <option value="below-question">beneath every question</option>
            <option value="answer-key">separate answer key only</option>
            <option value="none">no fixed place</option>
          </SelectNative>
        </label>
        <label className="flex flex-col gap-1">
          Words before the answer label
          <Input value={rules.answerLinePrefix ?? ""} disabled={ro} placeholder="► Official Answer: Option" onChange={(e) => set("answerLinePrefix", e.target.value || null)} />
        </label>
        <label className="flex flex-col gap-1">
          Figures
          <SelectNative value={rules.figures} disabled={ro} onChange={(e) => set("figures", e.target.value as FormatRules["figures"])}>
            <option value="none">none</option>
            <option value="stem">in the question</option>
            <option value="options">in options</option>
            <option value="both">question and options</option>
          </SelectNative>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={rules.explanations} disabled={ro} onChange={(e) => set("explanations", e.target.checked)} /> Explanations after the answer
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={rules.spansPages} disabled={ro} onChange={(e) => set("spansPages", e.target.checked)} /> Questions span pages
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs">
        Known reading errors (one per line: wrong =&gt; right; reported where they occur, never replaced automatically)
        <Textarea rows={3} value={ocr} disabled={ro} onChange={(e) => setOcr(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Notes
        <Textarea rows={2} value={rules.notes} disabled={ro} onChange={(e) => set("notes", e.target.value)} />
      </label>
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={pending} onClick={() => save({})} data-testid="format-profile-save">
            Save changes
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => save({ enabled: !profile.enabled })} data-testid="format-profile-toggle">
            {profile.enabled ? "Disable" : "Enable"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-[var(--color-muted-foreground)]">Only Master Admin can change format profiles.</p>
      )}
      {msg && <p className={`text-sm ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>{msg.text}</p>}
    </div>
  );
}
