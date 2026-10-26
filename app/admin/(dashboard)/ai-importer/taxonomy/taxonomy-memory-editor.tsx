"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import { addFormatRuleAction, addHeadingAliasAction, addTaxonomyConfusionAction, addTaxonomySynonymAction, removeTaxonomyMemoryAction } from "../actions";

type Subject = { id: string; name: string; topics: { id: string; name: string }[] };

/** Synonyms, commonly confused subjects and confirmed examples of one exam; editing needs the Manage permission. */
export function TaxonomyMemoryEditor({
  examId,
  canEdit,
  subjects,
  synonyms,
  confusions,
  corrections,
  headingAliases = [],
  formatRules = [],
  ruleOptions = [],
  history = [],
  version = 0,
}: {
  examId: string;
  canEdit: boolean;
  subjects: Subject[];
  synonyms: { id: string; term: string; target: string; at: string }[];
  confusions: { id: string | null; a: string; b: string; note: string | null; builtIn: boolean }[];
  corrections: { id: string; text: string; target: string; source: string; at: string; jobId: string }[];
  headingAliases?: { id: string; raw: string; target: string; at: string; version: number; note: string | null }[];
  formatRules?: { id: string; rule: string; label: string; at: string; version: number; note: string | null }[];
  ruleOptions?: { code: string; label: string }[];
  history?: { version: number; at: string; action: string; detail: string }[];
  version?: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [term, setTerm] = useState("");
  const [synSubject, setSynSubject] = useState("");
  const [synTopic, setSynTopic] = useState("");
  const [ca, setCa] = useState("");
  const [cb, setCb] = useState("");
  const [note, setNote] = useState("");
  const [heading, setHeading] = useState("");
  const [headingSubject, setHeadingSubject] = useState("");
  const [rule, setRule] = useState("");
  const act = (fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, ok: string, after?: () => void) =>
    start(async () => {
      const r = await callImporter(fn);
      setMsg(r.ok ? { ok: true, text: ok } : { ok: false, text: r.error ?? "Failed" });
      if (r.ok) {
        after?.();
        router.refresh();
      }
    });
  const ro = !canEdit || pending;
  const subject = subjects.find((s) => s.id === synSubject);
  return (
    <div className="flex flex-col gap-4" data-testid="taxonomy-memory">
      {msg && <p className={`text-sm ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} data-testid="taxonomy-msg">{msg.text}</p>}
      <Card>
        <CardHeader>
          <CardTitle>Synonyms and alternative terms</CardTitle>
          <CardDescription>Words that point to a subject or topic of this exam (abbreviations, older names, common phrasing). Used as evidence only.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <ul className="flex flex-col gap-1 text-xs" data-testid="taxonomy-synonyms">
            {synonyms.map((x) => (
              <li key={x.id} className="flex items-center gap-2">
                <span>
                  “{x.term}” → {x.target}
                </span>
                {canEdit && (
                  <Button size="sm" variant="outline" disabled={ro} onClick={() => act(() => removeTaxonomyMemoryAction(examId, "synonym", x.id), "Removed.")}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
            {!synonyms.length && <li className="text-[var(--color-muted-foreground)]">None yet.</li>}
          </ul>
          {canEdit && (
            <div className="flex flex-wrap items-end gap-1">
              <Input className="h-8 w-48 text-xs" placeholder="Term (e.g. ADPKD)" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Term" data-testid="synonym-term" />
              <SelectNative className="h-8 w-auto max-w-48 text-xs" value={synSubject} onChange={(e) => (setSynSubject(e.target.value), setSynTopic(""))} aria-label="Subject" data-testid="synonym-subject">
                <option value="">Subject…</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </SelectNative>
              <SelectNative className="h-8 w-auto max-w-48 text-xs" value={synTopic} disabled={!subject} onChange={(e) => setSynTopic(e.target.value)} aria-label="Topic" data-testid="synonym-topic">
                <option value="">Whole subject</option>
                {subject?.topics.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </SelectNative>
              <Button size="sm" disabled={ro || !term.trim() || !synSubject} onClick={() => act(() => addTaxonomySynonymAction(examId, term, synSubject, synTopic || null), "Synonym added.", () => setTerm(""))} data-testid="synonym-add">
                Add
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Printed section headings</CardTitle>
          <CardDescription>A heading printed on this exam&apos;s papers (“■ SECTION: PREVENTIVE &amp; SOCIAL MEDICINE”) that names one of its subjects. Headings that already name a subject (“SURGERY” → General Surgery) need no entry. The questions under a mapped heading get that subject; the AI only chooses the topic within it.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <ul className="flex flex-col gap-1 text-xs" data-testid="taxonomy-heading-aliases">
            {headingAliases.map((x) => (
              <li key={x.id} className="flex items-center gap-2">
                <span>
                  “{x.raw}” → {x.target}
                  <span className="ml-1 text-[var(--color-muted-foreground)]">
                    (v{x.version}, {x.at.slice(0, 10)}
                    {x.note ? ` — ${x.note}` : ""})
                  </span>
                </span>
                {canEdit && (
                  <Button size="sm" variant="outline" disabled={ro} onClick={() => act(() => removeTaxonomyMemoryAction(examId, "headingAlias", x.id), "Removed.")}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
            {!headingAliases.length && <li className="text-[var(--color-muted-foreground)]">None yet.</li>}
          </ul>
          {canEdit && (
            <div className="flex flex-wrap items-end gap-1">
              <Input className="h-8 w-64 text-xs" placeholder="Heading as printed" value={heading} onChange={(e) => setHeading(e.target.value)} aria-label="Heading" data-testid="heading-alias-text" />
              <SelectNative className="h-8 w-auto max-w-48 text-xs" value={headingSubject} onChange={(e) => setHeadingSubject(e.target.value)} aria-label="Subject" data-testid="heading-alias-subject">
                <option value="">Subject…</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </SelectNative>
              <Button size="sm" disabled={ro || !heading.trim() || !headingSubject} onClick={() => act(() => addHeadingAliasAction(examId, heading, headingSubject, ""), "Heading mapped.", () => setHeading(""))} data-testid="heading-alias-add">
                Map heading
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Paper format rules</CardTitle>
          <CardDescription>Rules an administrator confirmed for this exam&apos;s papers. Each one is recorded with who added it and the reference version.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <ul className="flex flex-col gap-1 text-xs" data-testid="taxonomy-format-rules">
            {formatRules.map((x) => (
              <li key={x.id} className="flex items-center gap-2">
                <span>
                  {x.label}
                  <span className="ml-1 text-[var(--color-muted-foreground)]">
                    (v{x.version}, {x.at.slice(0, 10)})
                  </span>
                </span>
                {canEdit && (
                  <Button size="sm" variant="outline" disabled={ro} onClick={() => act(() => removeTaxonomyMemoryAction(examId, "formatRule", x.id), "Removed.")}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
            {!formatRules.length && <li className="text-[var(--color-muted-foreground)]">None.</li>}
          </ul>
          {canEdit && (
            <div className="flex flex-wrap items-end gap-1">
              <SelectNative className="h-8 w-auto max-w-96 text-xs" value={rule} onChange={(e) => setRule(e.target.value)} aria-label="Rule" data-testid="format-rule-select">
                <option value="">Rule…</option>
                {ruleOptions.filter((o) => !formatRules.some((x) => x.rule === o.code)).map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </SelectNative>
              <Button size="sm" disabled={ro || !rule} onClick={() => act(() => addFormatRuleAction(examId, rule, ""), "Rule confirmed.", () => setRule(""))} data-testid="format-rule-add">
                Confirm rule
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Commonly confused subjects</CardTitle>
          <CardDescription>When a question&apos;s words fit both subjects of a pair about equally, it is left for review instead of being forced into one.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <ul className="flex flex-col gap-1 text-xs" data-testid="taxonomy-confusions">
            {confusions.map((c, i) => (
              <li key={c.id ?? `b${i}`} className="flex items-center gap-2">
                <span>
                  {c.a} ↔ {c.b}
                  {c.note ? ` — ${c.note}` : ""}
                  {c.builtIn && <span className="ml-1 text-[var(--color-muted-foreground)]">(built-in)</span>}
                </span>
                {canEdit && c.id && (
                  <Button size="sm" variant="outline" disabled={ro} onClick={() => act(() => removeTaxonomyMemoryAction(examId, "confusion", c.id!), "Removed.")}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
            {!confusions.length && <li className="text-[var(--color-muted-foreground)]">None.</li>}
          </ul>
          {canEdit && (
            <div className="flex flex-wrap items-end gap-1">
              {[ca, cb].map((v, k) => (
                <SelectNative key={k} className="h-8 w-auto max-w-48 text-xs" value={v} onChange={(e) => (k ? setCb(e.target.value) : setCa(e.target.value))} aria-label={k ? "Second subject" : "First subject"}>
                  <option value="">Subject…</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </SelectNative>
              ))}
              <Input className="h-8 w-56 text-xs" placeholder="Why (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
              <Button size="sm" disabled={ro || !ca || !cb || ca === cb} onClick={() => act(() => addTaxonomyConfusionAction(examId, ca, cb, note), "Pair added.", () => setNote(""))}>
                Add pair
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Confirmed examples ({corrections.length})</CardTitle>
          <CardDescription>Questions an administrator classified in Review Exceptions with “Remember” on. A new question that is nearly the same gets the same subject / topic (and is still checked by Verify 1 / Verify 2).</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1 text-xs" data-testid="taxonomy-corrections">
            {corrections.map((c) => (
              <li key={c.id} className="flex items-start gap-2 border-t border-[var(--color-border)] pt-1">
                <span className="flex-1">
                  <b>{c.target}</b> — {c.text}
                  <span className="ml-1 text-[var(--color-muted-foreground)]">({c.source}, {c.at.slice(0, 10)})</span>
                </span>
                {canEdit && (
                  <Button size="sm" variant="outline" disabled={ro} onClick={() => act(() => removeTaxonomyMemoryAction(examId, "correction", c.id), "Removed.")}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
            {!corrections.length && <li className="text-[var(--color-muted-foreground)]">None yet.</li>}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Change history (version {version})</CardTitle>
          <CardDescription>Every change of this exam&apos;s reference, newest first (the audit log keeps the same entries).</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-1 text-xs" data-testid="taxonomy-history">
            {history.map((h) => (
              <li key={`${h.version}-${h.at}`}>
                v{h.version} · {h.at.slice(0, 16).replace("T", " ")} UTC · {h.action.replace(/^AI_IMPORT_TAXONOMY_/, "").replace(/_/g, " ").toLowerCase()} <span className="text-[var(--color-muted-foreground)]">{h.detail}</span>
              </li>
            ))}
            {!history.length && <li className="text-[var(--color-muted-foreground)]">No recorded changes yet.</li>}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
