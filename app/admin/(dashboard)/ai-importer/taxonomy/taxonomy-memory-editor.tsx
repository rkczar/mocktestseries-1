"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import { addTaxonomyConfusionAction, addTaxonomySynonymAction, removeTaxonomyMemoryAction } from "../actions";

type Subject = { id: string; name: string; topics: { id: string; name: string }[] };

/** Synonyms, commonly confused subjects and confirmed examples of one exam; editing needs the Manage permission. */
export function TaxonomyMemoryEditor({
  examId,
  canEdit,
  subjects,
  synonyms,
  confusions,
  corrections,
}: {
  examId: string;
  canEdit: boolean;
  subjects: Subject[];
  synonyms: { id: string; term: string; target: string; at: string }[];
  confusions: { id: string | null; a: string; b: string; note: string | null; builtIn: boolean }[];
  corrections: { id: string; text: string; target: string; source: string; at: string; jobId: string }[];
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
    </div>
  );
}
