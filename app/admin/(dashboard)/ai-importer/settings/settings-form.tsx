"use client";

import Link from "next/link";
import { useId, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SELECTION_TASKS, SELECTION_TASK_LABELS, type ImporterSettings } from "@/lib/ai-import/config";
import type { ImporterCatalog, ImporterModelOption, RequestCost } from "@/lib/ai-import/model-options";
import type { ModelPlan } from "@/lib/ai-import/selection-types";
import { importerModelsAction, refreshRoutesAction, saveSettingsAction } from "../actions";

type Slot = "extract" | "fallback" | "verify" | "classify" | "key";
type CostKey = "extract" | "verify" | "solve" | "classify" | "key";

const inr = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v < 0.01 ? `₹${v.toFixed(4)}` : `₹${v.toFixed(2)}`);
const perM = (v: number | null) => (v === null ? "?" : `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`);

/** Why a selected model cannot be used in a slot (null = fine / not set). */
function slotProblem(options: ImporterModelOption[], id: string | null, vision: boolean): string | null {
  if (!id) return null;
  const m = options.find((o) => o.id === id);
  if (!m) return "not in the synced model catalog";
  if (!m.approved) return "not approved in AI → Models";
  return vision ? m.visionProblem : m.problem;
}

function ProviderStatus({ catalog, aiEnabled, problems }: { catalog: ImporterCatalog; aiEnabled: boolean; problems: string[] }) {
  const p = catalog.provider;
  const provider =
    p.status === "NOT_CONFIGURED"
      ? { tone: "error" as const, text: "Not configured — no OpenRouter API key is installed (Admin → AI → Providers)." }
      : p.status === "DISABLED"
        ? { tone: "warning" as const, text: "Key installed, but OpenRouter is switched off (Admin → AI → Providers)." }
        : p.status === "UNTESTED"
          ? { tone: "warning" as const, text: "Key installed and enabled; the connection has not been tested yet." }
          : p.status === "ERROR"
            ? { tone: "error" as const, text: `Key installed, but the last connection test failed${p.lastTestMessage ? ` (${p.lastTestMessage})` : ""}.` }
            : { tone: "success" as const, text: `Connected${p.lastTestAt ? ` (tested ${p.lastTestAt.slice(0, 10)})` : ""}.` };
  const rows: { label: string; tone: "success" | "warning" | "error" | "neutral"; text: string; id: string }[] = [
    { id: "provider", label: "OpenRouter", tone: provider.tone, text: provider.text },
    { id: "paid", label: "Paid AI for the importer", tone: aiEnabled ? "warning" : "neutral", text: aiEnabled ? "ON — AI requests run after a job's estimate is confirmed, inside the limits below." : "OFF — no AI request is sent. Local parsing, review and import still work." },
    ...(p.emergencyStop ? [{ id: "stop", label: "AI emergency stop", tone: "error" as const, text: "ON — every AI request is refused (Admin → AI → Budgets)." }] : []),
    {
      id: "catalog",
      label: "Model metadata",
      tone: catalog.catalog.models === 0 ? "error" : catalog.catalog.usableVision === 0 ? "warning" : "success",
      text:
        catalog.catalog.models === 0
          ? "Unavailable — the model catalog is empty. Sync it in AI → Models (a free, read-only request to OpenRouter)."
          : `${catalog.catalog.models} models synced${catalog.catalog.lastSyncAt ? ` (last sync ${catalog.catalog.lastSyncAt.slice(0, 10)})` : ""}; ${catalog.catalog.approved} approved, ${catalog.catalog.usableVision} of them can read page images.${catalog.catalog.usableVision === 0 ? " Approve a vision model in AI → Models to choose an extraction model." : ""}`,
    },
    {
      id: "routes",
      label: "Provider routes",
      tone: !catalog.routes.fetchedAt ? "error" : catalog.routes.stale || catalog.routes.zdrOk === false || catalog.routes.models.some((m) => !m.ok) ? "warning" : "success",
      text: !catalog.routes.fetchedAt
        ? "Not read yet — use Refresh provider routes (free, read-only OpenRouter requests). Until then no model can be chosen automatically."
        : `Read ${catalog.routes.fetchedAt.slice(0, 16).replace("T", " ")} UTC for ${catalog.routes.models.length} approved model${catalog.routes.models.length === 1 ? "" : "s"}${catalog.routes.models.some((m) => !m.ok) ? ` (${catalog.routes.models.filter((m) => !m.ok).length} could not be read)` : ""}; Zero-Data-Retention list ${catalog.routes.zdrOk ? "read" : `NOT read${catalog.routes.zdrError ? ` (${catalog.routes.zdrError})` : ""}`}.${catalog.routes.stale ? " Older than 6 h: a job confirmation reads them again first." : ""}`,
    },
    {
      id: "fx",
      label: "Prices in rupees",
      tone: catalog.fx.rate === null ? "error" : catalog.fx.stale ? "warning" : "success",
      text: catalog.fx.rate === null ? `Unavailable — ${catalog.fx.unavailableReason ?? "no USD→INR rate"}. AI requests are refused until a rate is available.` : `USD→INR ${catalog.fx.rate.toFixed(2)} (${catalog.fx.source ?? "rate"}${catalog.fx.rateDate ? `, ${catalog.fx.rateDate}` : ""})${catalog.fx.stale ? " — stale" : ""}.`,
    },
    {
      id: "key",
      label: "Shared key credit",
      tone: p.keyInstalled && p.keyLimitUsd === null && p.keyStatusAt ? "warning" : "neutral",
      text: !p.keyInstalled
        ? "—"
        : p.keyStatusAt
          ? p.keyLimitUsd === null
            ? `No credit limit on the key (as of ${p.keyStatusAt.slice(0, 10)}): importer requests are refused while an Ask AI reserve is set, because the reserve cannot be guaranteed.`
            : `Limit $${p.keyLimitUsd.toFixed(2)}, $${(p.keyRemainingUsd ?? 0).toFixed(2)} left as of ${p.keyStatusAt.slice(0, 10)}. Read again before every importer request.`
          : "Not read yet — it is read before every importer request.",
    },
  ];
  return (
    <Card data-testid="provider-status">
      <CardHeader>
        <CardTitle>Provider and configuration status</CardTitle>
        <CardDescription>No API key, or any part of one, is shown here.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[12rem_1fr]">
          {rows.map((r) => (
            <div key={r.id} className="contents" data-testid={`status-${r.id}`} data-tone={r.tone}>
              <dt className="font-medium text-[var(--color-foreground)]">{r.label}</dt>
              <dd className="flex items-start gap-2 text-[var(--color-muted-foreground)]">
                <Badge variant={r.tone === "neutral" ? "neutral" : r.tone}>{r.tone === "success" ? "OK" : r.tone === "error" ? "Problem" : r.tone === "warning" ? "Check" : "Info"}</Badge>
                <span>{r.text}</span>
              </dd>
            </div>
          ))}
        </dl>
        {problems.length > 0 && (
          <div className="mt-2 rounded-[var(--radius-card)] border border-[var(--color-error)] p-3 text-[var(--color-error)]" role="alert" data-testid="status-invalid">
            <strong>Invalid configuration:</strong>
            <ul className="mt-1 list-disc pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Searchable model list (keyboard: type to filter, arrows + Enter, Escape closes). */
function ModelPicker({ id, label, help, value, options, vision, cost, capInr, allowNone, onChange, disabled }: {
  id: string;
  label: string;
  help: string;
  value: string | null;
  options: ImporterModelOption[];
  vision: boolean;
  cost: CostKey;
  capInr: number;
  allowNone: string;
  onChange: (v: string | null) => void;
  disabled: boolean;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const selected = value ? options.find((o) => o.id === value) ?? null : null;
  const problem = slotProblem(options, value, vision);
  const usable = (o: ImporterModelOption) => o.approved && (vision ? o.visionProblem : o.problem) === null;
  const why = (o: ImporterModelOption) => (!o.approved ? "Not approved — approve it in AI → Models" : ((vision ? o.visionProblem : o.problem) ?? ""));
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const relevant = options.filter((o) => !vision || o.vision);
    const hits = q ? relevant.filter((o) => o.id.toLowerCase().includes(q) || o.name.toLowerCase().includes(q)) : relevant.filter((o) => o.approved);
    return [...hits.filter(usable), ...hits.filter((o) => !usable(o))].slice(0, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, query, vision]);
  const pick = (o: ImporterModelOption | null) => {
    if (o && !usable(o)) return;
    onChange(o?.id ?? null);
    setOpen(false);
    setQuery("");
  };
  const c = selected?.costs?.[cost] ?? null;
  return (
    <div className="flex flex-col gap-1.5" data-testid={id}>
      <Label htmlFor={`${id}-search`}>{label}</Label>
      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid={`${id}-current`}>
        <span className="text-[var(--color-muted-foreground)]">Selected:</span>
        {value ? (
          <span className={problem ? "text-[var(--color-error)]" : "font-medium text-[var(--color-foreground)]"}>
            {selected?.name ?? value} <code className="text-xs">{value}</code>
            {problem && ` — ${problem}`}
          </span>
        ) : (
          <span className="italic text-[var(--color-muted-foreground)]">{allowNone}</span>
        )}
        {!disabled && value && (
          <Button type="button" variant="ghost" size="compact" onClick={() => pick(null)} data-testid={`${id}-clear`}>
            Clear
          </Button>
        )}
      </div>
      {c && (
        <p className="text-xs text-[var(--color-muted-foreground)]" data-testid={`${id}-cost`}>
          Estimate per request: about {inr(c.typicalInr)}; conservative maximum {inr(c.maxInr)}
          {c.maxInr !== null && c.maxInr > capInr && <strong className="text-[var(--color-error)]"> — above the ₹{capInr} per-request limit, so these requests would be refused</strong>}.
        </p>
      )}
      {!disabled && (
        <div className="relative">
          <Input
            id={`${id}-search`}
            type="search"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            placeholder={vision ? "Search vision models by name or ID…" : "Search models by name or ID…"}
            value={query}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
                setActive((a) => Math.min(a + 1, list.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter" && open && list[active]) {
                e.preventDefault();
                pick(list[active]);
              } else if (e.key === "Escape") setOpen(false);
            }}
            data-testid={`${id}-search`}
          />
          {open && (
            <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-1 shadow-lg" data-testid={`${id}-list`}>
              {list.length === 0 && (
                <li className="p-2 text-sm text-[var(--color-muted-foreground)]" data-testid={`${id}-empty`}>
                  {query ? "No model matches." : vision ? "No approved model can read page images. Approve one in AI → Models, or search the catalog." : "No approved model. Approve one in AI → Models, or search the catalog."}
                </li>
              )}
              {list.map((o, i) => {
                const ok = usable(o);
                const rc = o.costs?.[cost] ?? null;
                return (
                  <li
                    key={o.id}
                    role="option"
                    aria-selected={o.id === value}
                    aria-disabled={!ok}
                    className={`cursor-pointer rounded px-2 py-1.5 text-sm ${i === active ? "bg-[color-mix(in_srgb,var(--color-foreground)_8%,transparent)]" : ""} ${ok ? "" : "cursor-not-allowed opacity-60"}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(o)}
                    data-testid="model-option"
                    data-model-id={o.id}
                    data-usable={ok ? "true" : "false"}
                  >
                    <div className="flex flex-wrap items-center gap-x-2">
                      <span className="font-medium text-[var(--color-foreground)]">{o.name}</span>
                      {o.vision && <Badge variant="info">vision</Badge>}
                      {o.id === value && <Badge variant="primary">selected</Badge>}
                    </div>
                    <div className="text-xs text-[var(--color-muted-foreground)]">
                      <code>{o.id}</code> · in {perM(o.promptPerM)} / out {perM(o.completionPerM)} per M tokens
                      {o.imagePrice ? ` · image ${o.imagePrice}` : ""}
                      {o.requestPrice ? ` · $${o.requestPrice}/request` : ""}
                      {rc && ok ? ` · max ${inr(rc.maxInr)} per request` : ""}
                    </div>
                    {!ok && <div className="text-xs text-[var(--color-error)]">{why(o)}</div>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      <p className="text-xs text-[var(--color-muted-foreground)]">{help}</p>
    </div>
  );
}

const money = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `$${(v * 1e6).toFixed(v * 1e6 < 0.1 ? 3 : 2)}`);

/** The model chosen per task (automatic or manual), why, its prices, costs and privacy route. */
function SelectionTable({ plan, aiEnabled }: { plan: ModelPlan; aiEnabled: boolean }) {
  return (
    <div className="flex flex-col gap-3" data-testid="selection">
      {plan.problems.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-[var(--color-warning)]" data-testid="selection-problems">
          {plan.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="text-xs text-[var(--color-muted-foreground)]">
            <tr>
              <th className="py-1 pr-2 font-medium">Task</th>
              <th className="py-1 pr-2 font-medium">Selected model and reason</th>
              <th className="py-1 pr-2 font-medium">Current price (per M tokens)</th>
              <th className="py-1 pr-2 font-medium">Per request</th>
              <th className="py-1 pr-2 font-medium">Image input</th>
              <th className="py-1 pr-2 font-medium">Privacy route</th>
            </tr>
          </thead>
          <tbody>
            {SELECTION_TASKS.map((t) => {
              const c = plan.tasks[t];
              return (
                <tr key={t} className="border-t border-[var(--color-border)] align-top" data-testid={`sel-${t}`} data-model={c.model ?? ""}>
                  <td className="py-1.5 pr-2 font-medium text-[var(--color-foreground)]">{SELECTION_TASK_LABELS[t]}</td>
                  <td className="py-1.5 pr-2 [overflow-wrap:anywhere]">
                    {c.model ? <code className="text-xs font-semibold" data-testid={`sel-${t}-model`}>{c.model}</code> : <span className={aiEnabled ? "text-[var(--color-error)]" : "italic text-[var(--color-muted-foreground)]"} data-testid={`sel-${t}-model`}>None — this task does not run</span>}
                    <span className="block text-xs text-[var(--color-muted-foreground)]" data-testid={`sel-${t}-reason`}>{c.reason}</span>
                  </td>
                  <td className="py-1.5 pr-2 text-xs">{c.price ? <>in {money(c.price.prompt)} · out {money(c.price.completion)}{c.vision && c.price.image ? ` · image ${money(c.price.image)}` : ""}{c.price.request ? ` · $${c.price.request}/request` : ""}</> : "—"}</td>
                  <td className="py-1.5 pr-2 text-xs" data-testid={`sel-${t}-cost`}>{c.model ? <>about {inr(c.typicalInr)}<span className="block">max {inr(c.maxInr)}</span></> : "—"}</td>
                  <td className="py-1.5 pr-2 text-xs">{c.vision ? (c.model ? "Required — supported" : "Required") : "Not needed"}</td>
                  <td className="py-1.5 pr-2 text-xs [overflow-wrap:anywhere]" data-testid={`sel-${t}-privacy`}>
                    {!c.model ? "—" : c.privacy.zdrRequired ? <>ZDR routes: {c.routes.join(", ")}<span className="block text-[var(--color-muted-foreground)]">On OpenRouter&apos;s public ZDR list; ZDR is also required on every request.</span></> : <>ZDR not required{c.privacy.dataCollection === "deny" ? "; providers that store or train on prompts are excluded by OpenRouter per request" : ""}.</>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {SELECTION_TASKS.map((t) => {
        const rows = plan.tasks[t].candidates;
        if (!rows.length) return null;
        return (
          <details key={t} className="text-xs" data-testid={`sel-candidates-${t}`}>
            <summary className="cursor-pointer text-[var(--color-muted-foreground)]">
              {SELECTION_TASK_LABELS[t]}: {rows.filter((r) => r.eligible).length} eligible of {rows.length} evaluated — why each model was or was not chosen
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5 pl-4">
              {rows.map((r) => (
                <li key={r.id} data-testid="sel-candidate" data-model-id={r.id} data-eligible={r.eligible ? "true" : "false"}>
                  <code>{r.id}</code> — {r.eligible ? <span className="text-[var(--color-success)]">eligible, up to {inr(r.maxInr)} per request</span> : <span className="text-[var(--color-error)]">{r.reason}</span>}
                </li>
              ))}
            </ul>
          </details>
        );
      })}
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Prices are OpenRouter&apos;s current published prices — the highest over the catalog price and every provider route the model may be served by. The maximum per request assumes the full output limit, the longest page text and one page image, with the price margin. The choice is made again with fresh routes when a job is confirmed and is then fixed for that job; the worker never switches to a more expensive model unless allowed below.
      </p>
    </div>
  );
}

function CostTable({ catalog, s }: { catalog: ImporterCatalog; s: ImporterSettings }) {
  const get = (id: string | null) => (id ? catalog.options.find((o) => o.id === id) ?? null : null);
  const keyModel = s.models.key ?? s.models.extract;
  const sameModel = !!s.models.extract && s.models.verify === s.models.extract;
  const rows: { label: string; model: string | null; c: RequestCost | null; note?: string; id: string }[] = [
    { id: "extract", label: "Extraction, per page", model: s.models.extract, c: get(s.models.extract)?.costs?.extract ?? null },
    { id: "verify", label: "Verification second read, per scanned / low-confidence page", model: sameModel ? null : s.models.verify, c: sameModel ? null : (get(s.models.verify)?.costs?.verify ?? null), note: sameModel ? "Not run: same model as extraction" : undefined },
    ...(s.verification.independentAnswer ? [{ id: "solve", label: "Verification answer opinion, per question", model: s.models.verify, c: get(s.models.verify)?.costs?.solve ?? null }] : []),
    { id: "classify", label: "Topic classification, per 20 questions", model: s.models.classify, c: get(s.models.classify)?.costs?.classify ?? null },
    { id: "key", label: "Scanned answer-key page", model: keyModel, c: get(keyModel)?.costs?.key ?? null },
  ];
  return (
    <div className="overflow-x-auto" data-testid="cost-table">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th className="py-1 pr-2 font-medium">Request</th>
            <th className="py-1 pr-2 font-medium">Model</th>
            <th className="py-1 pr-2 font-medium">Estimate (typical)</th>
            <th className="py-1 pr-2 font-medium">Conservative maximum</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-[var(--color-border)] align-top" data-testid={`cost-${r.id}`}>
              <td className="py-1.5 pr-2">{r.label}</td>
              <td className="py-1.5 pr-2 [overflow-wrap:anywhere]">{r.note ?? (r.model ? <code className="text-xs">{r.model}</code> : <span className="italic text-[var(--color-muted-foreground)]">Not set — not run</span>)}</td>
              <td className="py-1.5 pr-2">{r.c ? inr(r.c.typicalInr) : "—"}</td>
              <td className="py-1.5 pr-2">
                {r.c ? inr(r.c.maxInr) : "—"}
                {r.c && r.c.maxInr === null && <span className="block text-xs text-[var(--color-error)]">No exchange rate: requests are refused.</span>}
                {r.c && r.c.maxInr !== null && r.c.maxInr > s.budget.maxRequestInr && <span className="block text-xs text-[var(--color-error)]" data-testid="cost-over-cap">Above the ₹{s.budget.maxRequestInr} per-request limit: refused.</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
        These are <strong>estimates</strong> from OpenRouter&apos;s published prices, not charges. The maximum assumes the full output limit, the longest page text and {catalog.imageTokens.toLocaleString("en-IN")} tokens per page image (plus the model&apos;s image price), with a {Math.round((catalog.priceMargin - 1) * 100)}% margin. The server reserves this maximum before each request and refuses the request if it cannot be priced or would break a limit. Actual costs appear in the AI Cost Center.
      </p>
    </div>
  );
}

const num = (v: string) => (v.trim() === "" ? NaN : Number(v));

export function SettingsForm({ initial, catalog: initialCatalog, canManage }: { initial: ImporterSettings; catalog: ImporterCatalog; canManage: boolean }) {
  const router = useRouter();
  const [s, setS] = useState<ImporterSettings>(initial);
  const [catalog, setCatalog] = useState(initialCatalog);
  const [loading, startLoading] = useTransition();
  const [loadError, setLoadError] = useState<string | null>(null);
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
  const options = catalog.options;
  const manual = s.selection.mode === "manual";
  const slots = [
    ["Extraction model", s.models.extract, true],
    ["Fallback extraction model", s.models.extractFallbacks[0] ?? null, true],
    ["Verification model", s.models.verify, true],
    ["Topic classification model", s.models.classify, false],
    ["Answer-key reading model", s.models.key, true],
  ] as const;
  const problems = [
    // Manual model fields are only checked when the manual override is in use.
    ...(!manual
      ? []
      : slots
          .map(([label, id, vision]) => {
            const p = slotProblem(options, id, vision);
            return p ? `${label}: ${id} — ${p}.` : null;
          })
          .filter((x): x is string => !!x)),
    ...(s.aiEnabled && !catalog.plan.tasks.extract.model ? [`Paid AI is on, but no page-reading model can be used: ${catalog.plan.tasks.extract.reason}`] : []),
  ];
  const reload = (refresh = false) =>
    startLoading(async () => {
      setLoadError(null);
      try {
        const r = refresh ? await refreshRoutesAction(s) : await importerModelsAction(s);
        if (r.ok) setCatalog(r.data);
        else setLoadError(r.error);
      } catch {
        setLoadError("the server could not be reached");
      }
    });
  const picker = (slot: Slot, label: string, value: string | null, vision: boolean, cost: CostKey, onChange: (v: string | null) => void, help: string, allowNone: string) => (
    <ModelPicker id={`m-${slot}`} label={label} value={value} options={options} vision={vision} cost={cost} capInr={s.budget.maxRequestInr} onChange={onChange} disabled={d} help={help} allowNone={allowNone} />
  );
  const sameModel = !!s.models.extract && s.models.verify === s.models.extract;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (problems.some((p) => !p.startsWith("Paid AI is on"))) {
          setMsg({ ok: false, text: "Not saved: fix the invalid model selection shown in the status panel first." });
          return;
        }
        start(async () => {
          const r = await saveSettingsAction(s);
          if (r.ok) {
            setS(r.data);
            setMsg({ ok: true, text: `Settings saved at ${new Date().toLocaleTimeString("en-IN")}.` });
            router.refresh();
          } else setMsg({ ok: false, text: r.error });
        });
      }}
      data-testid="settings-form"
    >
      <ProviderStatus catalog={catalog} aiEnabled={s.aiEnabled} problems={problems} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button type="button" variant="outline" size="sm" onClick={() => reload()} disabled={loading} data-testid="models-reload">
          {loading ? "Loading…" : "Reload status and selection"}
        </Button>
        {canManage && (
          <Button type="button" variant="outline" size="sm" onClick={() => reload(true)} disabled={loading} data-testid="routes-refresh">
            Refresh provider routes
          </Button>
        )}
        {loadError && (
          <span className="text-[var(--color-error)]" role="alert" data-testid="models-error">
            Could not load the model list: {loadError}{" "}
            <button type="button" className="underline" onClick={() => reload()} data-testid="models-retry">
              Retry
            </button>
          </span>
        )}
        <Link className="text-xs underline text-[var(--color-muted-foreground)]" href="/admin/ai/models">
          Approve or sync models in AI → Models
        </Link>
      </div>

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
        </CardContent>
      </Card>

      <Card data-testid="selection-card">
        <CardHeader>
          <CardTitle>Model selection</CardTitle>
          <CardDescription>Automatic (default): for each task the importer uses the cheapest approved model that can do it, is available on OpenRouter, meets the privacy settings and fits the per-request limit — judged by its conservative maximum cost, not the average. No model has to be picked per import.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 text-sm" role="radiogroup" aria-label="Model selection">
            <label className="flex items-center gap-2">
              <input type="radio" name="sel" checked={!manual} onChange={() => setS({ ...s, selection: { mode: "auto" } })} disabled={d} data-testid="sel-auto" />
              <span><strong>Automatic</strong> — cheapest suitable approved model per task (recommended)</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="sel" checked={manual} onChange={() => setS({ ...s, selection: { mode: "manual" } })} disabled={d} data-testid="sel-manual" />
              <span><strong>Manual override</strong> — an administrator chooses each model (same checks; refused if unsuitable)</span>
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={s.budget.allowPricierFallback} onChange={(e) => set("budget", { allowPricierFallback: e.target.checked })} disabled={d} data-testid="b-pricier" />
            <span>Allow a MORE EXPENSIVE model to take over when a job&apos;s selected model becomes unavailable (still inside every budget). Off: the job stops and says why. A cheaper or equally priced replacement is always allowed and recorded.</span>
          </label>
          <SelectionTable plan={catalog.plan} aiEnabled={s.aiEnabled} />
        </CardContent>
      </Card>

      {manual && <Card data-testid="manual-models">
        <CardHeader>
          <CardTitle>Manual override models</CardTitle>
          <CardDescription>Only models approved in AI → Models with a fixed published price can be selected. Search to see the rest of the catalog and why a model cannot be used.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {catalog.catalog.models === 0 && (
            <p className="text-sm text-[var(--color-warning)]" data-testid="models-empty">
              The model catalog is empty, so no model can be chosen. Sync it in AI → Models first.
            </p>
          )}
          <div className="grid gap-5 md:grid-cols-2">
            {picker("extract", "Extraction model (vision)", s.models.extract, true, "extract", (v) => set("models", { extract: v, extractFallbacks: s.models.extractFallbacks.filter((f) => f !== v) }), "Reads scanned pages, formulas and figure positions — one request per page that needs AI.", "None — AI extraction is off")}
            <div className="flex flex-col gap-2">
              {picker("verify", "Independent verification model (vision)", s.models.verify, true, "verify", (v) => set("models", { verify: v }), "Second read of scanned / low-confidence pages, and the optional answer opinion. Pick a different model (ideally another vendor) for a real independent check.", "None — no second read")}
              {sameModel && (
                <p className="rounded-[var(--radius-card)] border border-[var(--color-warning)] p-2 text-xs text-[var(--color-warning)]" data-testid="verify-same">
                  Extraction and verification use the same model, so the second read is skipped (a model re-reading its own page is not an independent check). The answer opinion, if switched on, still uses it.
                </p>
              )}
            </div>
            {picker("fallback", "Fallback extraction model (vision, optional)", s.models.extractFallbacks[0] ?? null, true, "extract", (v) => set("models", { extractFallbacks: v ? [v] : [] }), "Tried only when the extraction model is unavailable. Must not cost more than the extraction model; leave empty for the pilot.", "None — no fallback")}
            {picker("classify", "Topic classification model", s.models.classify, false, "classify", (v) => set("models", { classify: v }), "Maps questions to the exam's existing topics (ids only).", "None — topics are chosen in review")}
            {picker("key", "Answer-key reading model (vision)", s.models.key, true, "key", (v) => set("models", { key: v }), "Scanned answer keys only.", "Same as the extraction model")}
          </div>
          <div>
            <h3 className="mb-1 text-sm font-semibold text-[var(--color-foreground)]">Cost per request (estimates)</h3>
            <CostTable catalog={catalog} s={s} />
          </div>
        </CardContent>
      </Card>}

      <Card>
        <CardHeader>
          <CardTitle>Privacy</CardTitle>
          <CardDescription>Sent with every importer request as an OpenRouter provider requirement. OpenRouter routes only to providers whose policy matches; it cannot verify a provider&apos;s internal practice. Account-level settings (prompt logging, training providers) are set in the OpenRouter account itself and cannot be read from here.</CardDescription>
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
            <input type="checkbox" checked={s.privacy.zdr} onChange={(e) => set("privacy", { zdr: e.target.checked })} disabled={d} data-testid="privacy-zdr" />
            Zero-Data-Retention routes only (recommended; fewer models — automatic selection only considers models with a ZDR route on OpenRouter&apos;s public list)
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Budgets and limits</CardTitle>
          <CardDescription>Hard limits, checked by the server inside one lock before every AI request (parallel pages and other jobs included). A job pauses instead of exceeding any of them; retries and verification calls count against the same limits. During the pilot the server never allows more than the ceilings fixed in code (shown under each field), whatever is entered here.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {field("b-total", "All-time importer budget (₹)", s.budget.totalInr, (n) => set("budget", { totalInr: n }), `Never resets, so a new month adds nothing. Pilot ceiling ₹${catalog.pilot.totalInr}.`)}
          {field("b-month", "Monthly importer budget (₹)", s.budget.monthlyInr, (n) => set("budget", { monthlyInr: n }), `Resets each IST month (the all-time budget still applies). Pilot ceiling ₹${catalog.pilot.monthlyInr}.`)}
          {field("b-maxjob", "Hard limit per job (₹)", s.budget.maxJobInr, (n) => set("budget", { maxJobInr: n }), `No job budget can be set above this at confirm or resume. Pilot ceiling ₹${catalog.pilot.maxJobInr}.`)}
          {field("b-job", "Default job budget (₹)", s.budget.defaultJobCapInr, (n) => set("budget", { defaultJobCapInr: n }), "Offered on New Import; never above the hard limit.")}
          {field("b-req", "Maximum per AI request (₹)", s.budget.maxRequestInr, (n) => set("budget", { maxRequestInr: n }), `A request whose conservative maximum is higher is refused. Pilot ceiling ₹${catalog.pilot.maxRequestInr}.`)}
          {field("b-key", "Keep on the shared OpenRouter key for Ask AI ($)", s.budget.keyReserveUsd, (n) => set("budget", { keyReserveUsd: n }), `An importer request is refused if it could leave less than this on the key. At least $${catalog.pilot.minKeyReserveUsd}.`)}
          <label className="flex items-center gap-2 self-end text-sm sm:col-span-3">
            <input type="checkbox" checked={s.budget.retryTransient} onChange={(e) => set("budget", { retryTransient: e.target.checked })} disabled={d} data-testid="b-retry" />
            Retry a request once after a temporary provider error (counts against the same budgets)
          </label>
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
      {msg && (
        <p className={`text-sm ${msg.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`} role={msg.ok ? "status" : "alert"} data-testid="settings-msg">
          {msg.text}
        </p>
      )}
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
