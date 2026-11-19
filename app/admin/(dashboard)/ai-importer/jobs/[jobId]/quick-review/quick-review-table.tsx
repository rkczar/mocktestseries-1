"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { callImporter } from "@/components/admin/ai-importer/call-importer";
import { bulkTaxonomyAction } from "../../../actions";

export interface QuickRow {
  id: string;
  number: string;
  group: string;
  taxonomyOnly: boolean;
  stem: string;
  options: string[];
  answer: string;
  answerStatus: string;
  stored: string | null;
  suggestion: { subjectId: string; topicId: string | null; label: string } | null;
  corrections: { field: string; to: string; kind: string; reason: string }[];
  issues: string[];
  page: { id: string; region: { x: number; y: number; w: number; h: number } | null; aspect: number } | null;
  key: { id: string; raw: string; hasBox: boolean } | null;
}

const CROP_W = 360;

/** The question's region of its page image, cropped in the browser (the page route serves the whole page). */
function PageCrop({ page }: { page: NonNullable<QuickRow["page"]> }) {
  const r = page.region;
  if (!r || r.w <= 0 || r.h <= 0) return <a className="text-xs underline" href={`/api/admin/ai-importer/pages/${page.id}/image`} target="_blank" rel="noreferrer">Page image</a>;
  const imgW = CROP_W / r.w;
  const imgH = imgW * page.aspect;
  return (
    <div className="relative overflow-hidden rounded border border-[var(--color-border)] bg-white" style={{ width: CROP_W, height: Math.min(420, r.h * imgH) }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- private, auth-checked route */}
      <img src={`/api/admin/ai-importer/pages/${page.id}/image`} alt="Question on the original page" loading="lazy" style={{ position: "absolute", width: imgW, height: imgH, maxWidth: "none", left: -r.x * imgW, top: -r.y * imgH }} />
    </div>
  );
}

export function QuickReviewTable({ rows, canUse }: { rows: QuickRow[]; canUse: boolean }) {
  const router = useRouter();
  const [sortByGroup, setSortByGroup] = useState(true);
  const list = useMemo(() => (sortByGroup ? [...rows].sort((a, b) => a.group.localeCompare(b.group)) : rows), [rows, sortByGroup]);
  const [cur, setCur] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (ev.key === "j") setCur((c) => Math.min(list.length - 1, c + 1));
      else if (ev.key === "k") setCur((c) => Math.max(0, c - 1));
      else if (ev.key === "x" && list[cur]) setSel((s) => { const n = new Set(s); if (n.has(list[cur].id)) n.delete(list[cur].id); else n.add(list[cur].id); return n; });
      else if (ev.key === "o" && list[cur]) router.push(`/admin/ai-importer/questions/${list[cur].id}`);
      else return;
      ev.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, cur, router]);
  useEffect(() => document.getElementById(`qr-${list[cur]?.id}`)?.scrollIntoView({ block: "nearest" }), [cur, list]);

  // The batch is allowed only when every selected row carries the SAME suggested subject / topic.
  const chosen = list.filter((r) => sel.has(r.id));
  const same = chosen.length > 0 && chosen.every((r) => r.suggestion && r.suggestion.subjectId === chosen[0].suggestion?.subjectId && r.suggestion.topicId === chosen[0].suggestion?.topicId);
  const apply = () => {
    const s = chosen[0].suggestion!;
    if (!window.confirm(`Set ${s.label} on ${chosen.length} question(s)? They still need approval afterwards.`)) return;
    start(async () => {
      const r = await callImporter(() => bulkTaxonomyAction(chosen.map((x) => x.id), s.subjectId, s.topicId, null, { count: chosen.length }));
      setMsg(r.ok ? `Subject / topic set on ${r.data.updated} question(s)${r.data.refused.length ? `; not changed: ${r.data.refused.join(" ")}` : ""}. They still need approval.` : r.error);
      if (r.ok) {
        setSel(new Set());
        router.refresh();
      }
    });
  };
  const groups = [...new Set(list.map((r) => r.group))];

  return (
    <div className="flex flex-col gap-2" data-testid="quick-review">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {groups.map((g) => <Badge key={g} variant="neutral">{g}: {list.filter((r) => r.group === g).length}</Badge>)}
        <label className="flex items-center gap-1"><input type="checkbox" checked={sortByGroup} onChange={(e) => setSortByGroup(e.target.checked)} /> Group</label>
        {canUse ? (
          <Button size="sm" disabled={pending || !same} onClick={apply} data-testid="qr-apply-taxonomy">
            Apply suggested subject / topic ({chosen.length})
          </Button>
        ) : null}
        {chosen.length && !same ? <span className="text-xs text-[var(--color-muted-foreground)]">Select rows with the same suggestion.</span> : null}
        {msg ? <span role="status" className="text-xs">{msg}</span> : null}
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-left">
            <th className="p-1" />
            <th className="p-1">Q</th>
            <th className="p-1">Group</th>
            <th className="p-1">Original</th>
            <th className="p-1">Extracted</th>
            <th className="p-1">Answer / key</th>
            <th className="p-1">Subject / topic</th>
            <th className="p-1">Suggestions and issues</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r, i) => (
            <tr key={r.id} id={`qr-${r.id}`} onClick={() => setCur(i)} aria-selected={i === cur} className={`border-t border-[var(--color-border)] align-top ${i === cur ? "bg-[var(--color-muted)]" : ""}`} data-testid="qr-row">
              <td className="p-1">
                <input type="checkbox" aria-label={`Select question ${r.number}`} checked={sel.has(r.id)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} />
              </td>
              <td className="p-1 font-semibold"><Link className="underline" href={`/admin/ai-importer/questions/${r.id}`}>{r.number}</Link></td>
              <td className="p-1">{r.group}{r.taxonomyOnly ? <div className="text-[var(--color-muted-foreground)]">wording + answer verified</div> : null}</td>
              <td className="p-1">{r.page ? <PageCrop page={r.page} /> : "—"}</td>
              <td className="max-w-md p-1 whitespace-pre-line">{r.stem}{"\n"}{r.options.join("\n")}</td>
              <td className="p-1">
                <div>{r.answer} <span className="text-[var(--color-muted-foreground)]">({r.answerStatus.toLowerCase().replace(/_/g, " ")})</span></div>
                {r.key?.hasBox ? (
                  // eslint-disable-next-line @next/next/no-img-element -- private, auth-checked route
                  <img src={`/api/admin/ai-importer/key-entries/${r.key.id}/image`} alt={`Answer key cell ${r.key.raw}`} className="mt-1 max-h-16 w-auto rounded border border-[var(--color-border)] bg-white" loading="lazy" />
                ) : r.key ? <div>Key: {r.key.raw}</div> : <div className="text-[var(--color-muted-foreground)]">no key entry</div>}
              </td>
              <td className="p-1">
                <div>{r.stored ?? "—"}</div>
                {r.suggestion ? <div className="text-[var(--color-primary)]">Suggested: {r.suggestion.label}</div> : null}
              </td>
              <td className="p-1">
                {r.corrections.map((c, k) => (
                  <div key={k} className="mb-1"><Badge variant="neutral">{c.kind}</Badge> {c.field}: <span className="whitespace-pre-line">{c.to}</span> <span className="text-[var(--color-muted-foreground)]">— {c.reason}</span></div>
                ))}
                <ul className="list-disc pl-4">{r.issues.map((t, k) => <li key={k}>{t}</li>)}</ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
