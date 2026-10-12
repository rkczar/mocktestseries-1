"use client";

import { PostAiCost } from "@/components/admin/instagram/post-ai-cost";
import { useState } from "react";
import { CheckCircle2, AlertTriangle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import { checkDiagram } from "@/lib/instagram/diagram";
import { checkTrap } from "@/lib/instagram/trap";
import { DIAGRAM_KINDS, DIAGRAM_KIND_LABELS, TRAP_LIMITS, normalizeDiagram, type DiagramSpec, type PostContent, type PostDesign, type SlideModule, type TrapVariant } from "@/lib/instagram/types";
import type { PostDto } from "@/lib/instagram/posts";
import { aiDiagramAction, aiTrapAction } from "@/app/admin/(dashboard)/instagram/studio-actions";
import { MedicalImagePanel } from "@/components/admin/instagram/medical-image-panel";

export type ProviderChoice = "default" | "anthropic" | "gemini" | "openai";
type R<T> = { ok: true; data: T } | { ok: false; error: string; kind?: "conflict" | "needs-confirm" | "invalid" | "not-found" | "blocked" };
export type ActFn = <T>(call: () => Promise<R<T>>, onOk: (d: T) => void) => void;
/** Opens the AI Cost Preview; `run` gets the approved one-time quote id (components/admin/ai/cost-preview.tsx). */
export type AskCostFn = (req: { feature: string; context?: Record<string, string | number | null>; legacyProvider?: boolean }, run: (quoteId: string) => void) => void;

/** Per-request AI provider choice (the server checks it is configured and enabled). */
export function ProviderPicker({ value, onChange }: { value: ProviderChoice; onChange: (v: ProviderChoice) => void }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
      AI provider
      <SelectNative className="h-8 w-auto text-xs" value={value} onChange={(e) => onChange(e.target.value as ProviderChoice)} data-testid="ai-provider">
        <option value="default">Feature routing (AI Providers)</option>
        <option value="anthropic">Anthropic Claude</option>
        <option value="gemini">Google Gemini</option>
        <option value="openai">OpenAI</option>
      </SelectNative>
    </label>
  );
}

function CheckList({ checks }: { checks: TrapVariant["checks"] }) {
  return (
    <ul className="flex flex-col gap-1 text-xs" data-testid="trap-checks">
      {checks.map((c) => (
        <li key={c.code} className="flex items-start gap-1.5">
          {c.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-success)]" aria-hidden /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" aria-hidden />}
          <span>{c.message}</span>
        </li>
      ))}
    </ul>
  );
}

function DiagramSummary({ d }: { d: DiagramSpec }) {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-[var(--color-surface)] p-2 text-xs">
      <p className="font-semibold">{`${DIAGRAM_KIND_LABELS[d.kind]} · ${d.title}`}</p>
      {d.nodes.length ? <p>{d.nodes.map((n) => n.label + (n.note ? ` (${n.note})` : "")).join(d.kind === "hub" ? " · " : " → ")}</p> : null}
      {d.rows.length ? (
        <p>{`${d.columns.join(" | ")} — ${d.rows.length} rows: ${d.rows.map((r) => r.label).join(", ")}`}</p>
      ) : null}
      {d.sets.length ? <p>{`${d.sets.map((s) => `${s.label}: ${s.items.join(", ")}`).join(" / ")} · shared: ${d.overlap.join(", ")}`}</p> : null}
    </div>
  );
}

/**
 * Editor tab "Diagram & Trap": AI medical diagram (structured spec, drawn by
 * the app) and the Examiner Trap variant. There is no separate approval step:
 * both are listed as "check before publishing" warnings in the single final
 * "Publish to Instagram?" confirmation.
 */
export function AiStudioPanel({
  post,
  draft,
  editable,
  pending,
  provider,
  setProvider,
  act,
  askCost,
  onPost,
  onEditContent,
  onAddModule,
  onRemoveModule,
}: {
  post: PostDto;
  draft: { content: PostContent; design: PostDesign };
  editable: boolean;
  pending: boolean;
  provider: ProviderChoice;
  setProvider: (p: ProviderChoice) => void;
  act: ActFn;
  askCost: AskCostFn;
  onPost: (p: PostDto, summary: string) => void;
  onEditContent: (c: Partial<PostContent>) => void;
  onAddModule: (m: SlideModule) => void;
  onRemoveModule: (m: SlideModule) => void;
}) {
  const [kind, setKind] = useState<string>("auto");
  const [diagramInstr, setDiagramInstr] = useState("");
  const [trapInstr, setTrapInstr] = useState("");
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const c = draft.content;
  const base = () => ({ postId: post.id, expectedRevision: post.revision, content: draft.content, design: draft.design, provider: provider === "default" ? null : provider });
  const diagram = c.diagram;
  const trap = c.trap;
  const savedTrap = post.content.trap;
  const trapProblems = trap ? checkTrap(trap) : [];
  const diagramProblems = diagram ? checkDiagram(diagram) : [];

  const setTrap = (p: Partial<TrapVariant>) => trap && onEditContent({ trap: { ...trap, ...p } });

  return (
    <fieldset disabled={!editable || pending} className="flex flex-col gap-5" data-testid="studio-panel">
      <ProviderPicker value={provider} onChange={setProvider} />
      <PostAiCost postId={post.id} revision={post.revision} />

      {/* ---- Diagram ---- */}
      <section className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="diagram-section">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Medical Concept Diagram</h3>
          {diagram ? (
            <span className="text-xs font-medium text-[var(--color-warning)]" data-testid="diagram-status">
              Check every label before publishing
            </span>
          ) : null}
        </div>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          The AI plans a schematic (flowchart, mechanism, comparison or differential-diagnosis table, Venn, concept map); the app draws every label in the selected design mode. It is
          never presented as a clinical image.
        </p>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <SelectNative value={kind} onChange={(e) => setKind(e.target.value)} data-testid="diagram-kind">
            <option value="auto">Let the AI choose the best diagram type</option>
            {DIAGRAM_KINDS.map((k) => (
              <option key={k} value={k}>
                {DIAGRAM_KIND_LABELS[k]}
              </option>
            ))}
          </SelectNative>
          <Button
            type="button"
            data-testid="ai-diagram"
            onClick={() =>
              askCost({ feature: "ig_diagram", context: { postId: post.id }, legacyProvider: provider !== "default" }, (quoteId) =>
                act(() => aiDiagramAction({ ...base(), kind, instruction: diagramInstr, quoteId }), (r) => (onPost(r.post, r.summary), setJsonText(null)))
              )
            }
          >
            <Sparkles className="h-4 w-4" aria-hidden /> {diagram ? "Regenerate diagram" : "Generate diagram"}
          </Button>
        </div>
        <Input value={diagramInstr} onChange={(e) => setDiagramInstr(e.target.value)} placeholder='Optional instruction, e.g. "show the brachial plexus cords and their branches"' />
        {diagram ? (
          <>
            <DiagramSummary d={diagram} />
            {diagramProblems.length ? (
              <ul className="text-xs text-[var(--color-error)]">
                {diagramProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
            <details>
              <summary className="cursor-pointer text-xs font-medium">Edit diagram labels (JSON)</summary>
              <Textarea
                rows={10}
                className="mt-2 font-mono text-xs"
                value={jsonText ?? JSON.stringify({ ...diagram, origin: undefined, reviewed: undefined }, null, 2)}
                onChange={(e) => {
                  setJsonText(e.target.value);
                  try {
                    const parsed = normalizeDiagram(JSON.parse(e.target.value));
                    if (!parsed) return setJsonError("Unknown diagram type.");
                    setJsonError(null);
                    onEditContent({ diagram: { ...parsed, reviewed: false, origin: diagram.origin } });
                  } catch {
                    setJsonError("Not valid JSON yet.");
                  }
                }}
                data-testid="diagram-json"
              />
              {jsonError ? <p className="text-xs text-[var(--color-error)]">{jsonError}</p> : null}
            </details>
            <div className="flex flex-wrap gap-2">
              {!draft.design.modules.includes("DIAGRAM") ? (
                <Button type="button" size="sm" variant="outline" onClick={() => onAddModule("DIAGRAM")} data-testid="add-diagram-slide">
                  Add the diagram slide
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="ghost" onClick={() => onEditContent({ diagram: null })}>
                Remove diagram
              </Button>
            </div>
          </>
        ) : null}
      </section>

      {/* ---- Examiner trap ---- */}
      <section className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="trap-section">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">How the Examiner Traps You · AI Variant</h3>
          {trap ? (
            <span
              data-testid="trap-status"
              data-status={savedTrap?.status ?? "draft"}
              className={cn("text-xs font-medium", savedTrap?.status === "rejected" ? "text-[var(--color-error)]" : "text-[var(--color-warning)]")}
            >
              {savedTrap?.status === "rejected" ? "Rejected — regenerate or remove" : "Check before publishing"}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          A new examiner-style question on the same concept, with the most tempting wrong option and how to avoid it. It is stored only on this post — the Question Bank and the
          original answer key are never changed. An independent blind re-solve checks the answer.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" data-testid="ai-trap" onClick={() => askCost({ feature: "ig_trap", context: { postId: post.id }, legacyProvider: provider !== "default" }, (quoteId) => act(() => aiTrapAction({ ...base(), instruction: trapInstr, quoteId }), (r) => onPost(r.post, r.summary)))}>
            <Sparkles className="h-4 w-4" aria-hidden /> {trap ? "Regenerate trap question" : "Generate Examiner Trap"}
          </Button>
          {trap && !draft.design.modules.includes("TRAP") ? (
            <Button type="button" variant="outline" onClick={() => onAddModule("TRAP")} data-testid="add-trap-slide">
              Add the trap slide
            </Button>
          ) : null}
        </div>
        <Input value={trapInstr} onChange={(e) => setTrapInstr(e.target.value)} placeholder='Optional instruction, e.g. "make it a clinical vignette"' />
        {trap ? (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-xs">
              {`Question (${trap.question.length}/${TRAP_LIMITS.question} recommended — longer text continues on the next slide)`}
              <Textarea rows={3} value={trap.question} onChange={(e) => setTrap({ question: e.target.value })} data-testid="trap-question" />
            </label>
            {trap.options.map((o, i) => (
              <label key={o.label} className="flex items-center gap-2 text-xs">
                <span className="w-5 font-semibold">{o.label}</span>
                <Input value={o.text} onChange={(e) => setTrap({ options: trap.options.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)) })} />
              </label>
            ))}
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-xs">
                Correct answer
                <SelectNative value={trap.correct} onChange={(e) => setTrap({ correct: e.target.value })}>
                  {trap.options.map((o) => (
                    <option key={o.label} value={o.label}>
                      {o.label}
                    </option>
                  ))}
                </SelectNative>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                Most tempting wrong option
                <SelectNative value={trap.tempting} onChange={(e) => setTrap({ tempting: e.target.value })}>
                  {trap.options.map((o) => (
                    <option key={o.label} value={o.label}>
                      {o.label}
                    </option>
                  ))}
                </SelectNative>
              </label>
            </div>
            <label className="flex flex-col gap-1 text-xs">
              {`Why it traps you (${trap.trapExplanation.length}/${TRAP_LIMITS.trapExplanation} recommended)`}
              <Textarea rows={2} value={trap.trapExplanation} onChange={(e) => setTrap({ trapExplanation: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              {`How to avoid it (${trap.avoidTip.length}/${TRAP_LIMITS.avoidTip} recommended)`}
              <Textarea rows={2} value={trap.avoidTip} onChange={(e) => setTrap({ avoidTip: e.target.value })} />
            </label>
            {trapProblems.length ? (
              <ul className="text-xs text-[var(--color-error)]">
                {trapProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
            {savedTrap?.checks.length ? <CheckList checks={savedTrap.checks} /> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => onEditContent({ trap: null })}>
                Remove trap
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <MedicalImagePanel
        post={post}
        draft={draft}
        base={base}
        act={act}
        askCost={askCost}
        onPost={onPost}
        onEditContent={onEditContent}
        onAddModule={onAddModule}
        onRemoveModule={onRemoveModule}
        defaultQuery={post.snapshot.topicName ?? post.snapshot.subjectName}
      />
    </fieldset>
  );
}
