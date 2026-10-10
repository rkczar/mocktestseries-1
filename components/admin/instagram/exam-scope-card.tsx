"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ScopedExam } from "@/lib/instagram/scope";
import { saveScopeAction } from "@/app/admin/(dashboard)/instagram/studio-actions";

/** Settings → Exam scope: which exams Instagram Studio may use. NEET UG is always excluded. */
export function ExamScopeCard({ initial }: { initial: { exams: ScopedExam[]; mode: "auto" | "custom" } }) {
  const router = useRouter();
  const [mode, setMode] = useState(initial.mode);
  const [chosen, setChosen] = useState<Set<string>>(new Set(initial.exams.filter((e) => e.eligible).map((e) => e.id)));
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card data-testid="exam-scope">
      <CardHeader className="pb-2">
        <CardTitle>Exam scope</CardTitle>
        <CardDescription>
          Instagram Studio is for MBBS-level and post-MBBS exams (FMGE, NEET PG, INI-CET, AIIMS, UPSC CMS, State Medical Officer). NEET UG and school-level exams are always
          excluded here — nothing changes for them elsewhere on the website.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-5 pb-5">
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === "auto"} onChange={() => setMode("auto")} /> Automatic (by exam name)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === "custom"} onChange={() => setMode("custom")} data-testid="scope-custom" /> Choose exams
          </label>
        </div>
        <ul className="flex flex-col gap-1.5 text-sm">
          {initial.exams.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2" data-exam={e.code}>
              <input
                type="checkbox"
                disabled={mode === "auto" || e.excluded}
                checked={mode === "auto" ? e.eligible : chosen.has(e.id)}
                onChange={(ev) => setChosen((s) => {
                  const n = new Set(s);
                  if (ev.target.checked) n.add(e.id);
                  else n.delete(e.id);
                  return n;
                })}
                aria-label={e.name}
              />
              <span className={e.excluded ? "text-[var(--color-muted-foreground)] line-through" : ""}>{e.name}</span>
              <span className="text-xs text-[var(--color-muted-foreground)]">{`${e.code}${e.isActive ? "" : " · inactive"} · ${e.reason}`}</span>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            disabled={pending}
            data-testid="scope-save"
            onClick={() =>
              start(async () => {
                const r = await saveScopeAction({ mode, examIds: [...chosen] });
                setMsg(r.ok ? "Exam scope saved." : r.error);
                if (r.ok) router.refresh();
              })
            }
          >
            Save exam scope
          </Button>
          {msg ? <span className="text-xs" role="status">{msg}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
