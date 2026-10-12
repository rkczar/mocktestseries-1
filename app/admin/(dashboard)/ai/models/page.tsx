import Link from "next/link";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listCatalog } from "@/lib/ai-engine/catalog";
import { getOpenRouterConfig } from "@/lib/ai-engine/settings";
import { ModelRowControls, SyncModelsButton } from "@/components/admin/ai/model-controls";
import { formatIst } from "@/lib/ist-time";
import { perMillion, imageMaxUsd, formatUsd } from "@/lib/ai-engine/config";
import { toPriced } from "@/lib/ai-engine/catalog";
import { IMAGE_MEGAPIXELS } from "@/lib/ai-engine/router";
import { ModelEvaluation } from "@/components/admin/ai/model-eval";
import { listEvaluations } from "@/lib/ai-engine/eval";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "AI Models — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

const PAGE = 50;

/**
 * Admin → AI → Models: the OpenRouter catalog (prices from the Models API at
 * the last sync — never hard-coded). Approve models for routing, mark the
 * ones allowed for medical content, disable any. Only approved models are ever
 * used by the router.
 */
export default async function AiModelsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!(await hasPermission(PERMISSIONS.AI_ENGINE_VIEW))) return <RestrictedCard title="AI Models" />;
  const canManage = await hasPermission(PERMISSIONS.AI_ENGINE_MANAGE);
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const kind = sp.kind === "image" || sp.kind === "text" ? sp.kind : "all";
  const status = sp.status === "approved" || sp.status === "medical" ? sp.status : "all";
  const capability = sp.cap === "structured" || sp.cap === "reasoning" ? sp.cap : "any";
  const maxPrompt = sp.maxIn && Number.isFinite(Number(sp.maxIn)) ? Number(sp.maxIn) : null;
  const q = (sp.q ?? "").slice(0, 60);
  const vendor = sp.vendor && /^[a-z0-9._-]{1,60}$/.test(sp.vendor) ? sp.vendor : "";
  const [{ rows, total, vendors }, or, runs, approvedText] = await Promise.all([
    listCatalog({ q: q || undefined, vendor: vendor || undefined, kind, status, maxPromptPerM: maxPrompt, capability, take: PAGE, skip: (page - 1) * PAGE }),
    getOpenRouterConfig(),
    listEvaluations(),
    prisma.aiModel.findMany({ where: { approved: true, disabled: false, isImageModel: false, missingSince: null }, select: { id: true }, orderBy: { id: "asc" } }),
  ]);
  const qs = (patch: Record<string, string | number | null>) => {
    const p = new URLSearchParams();
    const merged: Record<string, string | number | null> = { q, vendor, kind: kind === "all" ? null : kind, status: status === "all" ? null : status, cap: capability === "any" ? null : capability, maxIn: maxPrompt, page: null, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v !== null && v !== "" && v !== undefined) p.set(k, String(v));
    return `/admin/ai/models${p.toString() ? `?${p}` : ""}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Models</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          OpenRouter catalog. Prices are copied from the OpenRouter Models API at each sync (USD per million tokens; image models: price per image line). Only <strong>approved</strong> models can be
          used; medical features (explanations, variants, carousel, traps, diagrams, medical images) only use <strong>medically approved</strong> ones.
        </p>
      </div>
      <ModelEvaluation models={approvedText.map((m) => m.id)} runs={runs} canManage={canManage} openRouterEnabled={or.enabled} />
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Catalog</CardTitle>
            <CardDescription data-testid="catalog-sync-info">{or.lastSyncAt ? `${or.lastSyncSummary ?? ""} · last sync ${formatIst(new Date(or.lastSyncAt))}` : "Not synced yet."}</CardDescription>
          </div>
          {canManage ? <SyncModelsButton /> : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form className="flex flex-wrap items-end gap-2 text-xs" action="/admin/ai/models" data-testid="model-filters">
            <label className="flex flex-col gap-1">
              Search
              <input name="q" defaultValue={q} className="h-8 rounded-md border border-[var(--color-border)] bg-transparent px-2" placeholder="gemini, claude, qwen…" />
            </label>
            <label className="flex flex-col gap-1">
              Provider
              <select name="vendor" defaultValue={vendor} className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2">
                <option value="">All</option>
                {vendors.map((v) => (
                  <option key={v.vendor} value={v.vendor}>{`${v.vendor} (${v.count})`}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Type
              <select name="kind" defaultValue={kind === "all" ? "" : kind} className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2">
                <option value="">Text + image</option>
                <option value="text">Text output</option>
                <option value="image">Image generation</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Status
              <select name="status" defaultValue={status === "all" ? "" : status} className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2">
                <option value="">Any</option>
                <option value="approved">Approved</option>
                <option value="medical">Medically approved</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Capability
              <select name="cap" defaultValue={capability === "any" ? "" : capability} className="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-2">
                <option value="">Any</option>
                <option value="structured">Structured output (JSON)</option>
                <option value="reasoning">Reasoning</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Max input $/M
              <input name="maxIn" type="number" step="0.01" min="0" defaultValue={maxPrompt ?? ""} className="h-8 w-24 rounded-md border border-[var(--color-border)] bg-transparent px-2" />
            </label>
            <button type="submit" className="h-8 rounded-md border border-[var(--color-border)] px-3">
              Filter
            </button>
          </form>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm" data-testid="model-table">
              <thead className="text-xs text-[var(--color-muted-foreground)]">
                <tr>
                  <th className="py-1 pr-3 font-medium">Model</th>
                  <th className="py-1 pr-3 font-medium">Type</th>
                  <th className="py-1 pr-3 font-medium">Context</th>
                  <th className="py-1 pr-3 font-medium">Input $/M</th>
                  <th className="py-1 pr-3 font-medium">Output $/M</th>
                  <th className="py-1 pr-3 font-medium">Image</th>
                  <th className="py-1 pr-3 font-medium">Capabilities</th>
                  <th className="py-1 font-medium">Approval</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const img = m.isImageModel ? imageMaxUsd(toPriced(m), IMAGE_MEGAPIXELS) : null;
                  const structured = m.supportedParameters.some((p) => p === "response_format" || p === "structured_outputs");
                  return (
                    <tr key={m.id} className="border-t border-[var(--color-border)] align-top" data-model={m.id}>
                      <td className="py-2 pr-3">
                        <p className="break-all font-mono text-xs">{m.id}</p>
                        <p className="text-xs text-[var(--color-muted-foreground)]">{m.name}</p>
                        {m.missingSince ? <p className="text-xs text-[var(--color-error)]">No longer listed by OpenRouter</p> : null}
                        {m.expirationDate ? <p className="text-xs text-[var(--color-warning)]">{`Expires ${m.expirationDate}`}</p> : null}
                      </td>
                      <td className="py-2 pr-3 text-xs">{m.isImageModel ? "Image" : m.outputModalities.includes("image") ? "Text + image" : "Text"}</td>
                      <td className="py-2 pr-3 text-xs">{m.contextLength ? m.contextLength.toLocaleString("en-IN") : "—"}</td>
                      <td className="py-2 pr-3 text-xs">{m.promptPrice === null ? (m.isImageModel ? "—" : "variable") : perMillion(m.promptPrice)}</td>
                      <td className="py-2 pr-3 text-xs">{m.completionPrice === null ? (m.isImageModel ? "—" : "variable") : perMillion(m.completionPrice)}</td>
                      <td className="py-2 pr-3 text-xs">
                        {m.isImageModel
                          ? m.imageUnit
                            ? `$${m.imageUnitCostUsd} / ${m.imageUnit}${img !== null ? ` ≈ ${formatUsd(img)} per image` : " (set units per image)"}`
                            : "price not loaded"
                          : "—"}
                      </td>
                      <td className="py-2 pr-3 text-xs">{[structured ? "JSON" : null, m.supportedParameters.includes("reasoning") ? "reasoning" : null, m.inputModalities.includes("image") ? "vision" : null].filter(Boolean).join(" · ") || "—"}</td>
                      <td className="py-2">
                        <ModelRowControls
                          canManage={canManage}
                          model={{ id: m.id, approved: m.approved, medicallyApproved: m.medicallyApproved, disabled: m.disabled, isImageModel: m.isImageModel, imageUnit: m.imageUnit, imageUnitsPerImage: m.imageUnitsPerImage, notes: m.notes }}
                        />
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-4 text-[var(--color-muted-foreground)]">
                      {total === 0 && !q && !vendor ? "No models yet — click Sync models." : "No models match these filters."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
            <span>{`${total} model(s) · page ${page} of ${Math.max(1, Math.ceil(total / PAGE))}`}</span>
            <span className="flex gap-3">
              {page > 1 ? <Link href={qs({ page: page - 1 })}>← Previous</Link> : null}
              {page * PAGE < total ? <Link href={qs({ page: page + 1 })}>Next →</Link> : null}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
