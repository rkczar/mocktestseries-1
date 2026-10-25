"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SelectNative } from "@/components/ui/select-native";
import { setApprovedSpeechModelsAction, syncVoiceCatalogAction } from "@/app/admin/(dashboard)/video-studio/actions";
import { formatInr } from "@/lib/ai-engine/config";
import type { SpeechModel, VoiceCatalog, VoiceSupport } from "@/lib/video-studio/voices";

const SUPPORT: Record<VoiceSupport, { label: string; v: "success" | "info" | "neutral" }> = {
  locale: { label: "Dedicated voices", v: "success" },
  multilingual: { label: "Multilingual — check with a preview", v: "info" },
  none: { label: "Not supported", v: "neutral" },
};

function price(m: SpeechModel, fx: number | null): string {
  if (m.unitPriceUsd === null || m.unit === "unknown") return "Unknown (cannot be estimated)";
  if (m.unitPriceUsd === 0) return "Free";
  if (m.unit === "character") return `${fx ? formatInr(m.unitPriceUsd * 1000 * fx, 2) : `$${(m.unitPriceUsd * 1000).toFixed(4)}`} per 1,000 characters`;
  return `${fx ? formatInr(m.unitPriceUsd * 60 * fx, 2) : `$${(m.unitPriceUsd * 60).toFixed(4)}`} per minute of audio`;
}

/**
 * Voice Studio: OpenRouter's speech models and their voices, synced with a
 * free catalog read. A Master Admin approves which models the studio may use;
 * Auto Configure only proposes approved, priced models. OpenAI TTS is not in
 * OpenRouter's speech catalog and is not offered.
 */
export function VoiceStudio({ catalog, canManage, fxRate }: { catalog: VoiceCatalog; canManage: boolean; fxRate: number | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<"all" | "hi" | "en">("hi");
  const [approved, setApproved] = useState<string[]>(catalog.approvedModels);
  const dirty = JSON.stringify([...approved].sort()) !== JSON.stringify([...catalog.approvedModels].sort());
  const models = useMemo(() => catalog.models.filter((m) => lang === "all" || m.languages[lang] !== "none"), [catalog.models, lang]);

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Failed.");
      else router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Voice Studio</CardTitle>
          <CardDescription>
            Speech models available through OpenRouter (the AI Engine&apos;s existing key, budgets and privacy settings). Prices come from OpenRouter&apos;s catalog: most are per character of text. OpenAI TTS is not offered — it is not in OpenRouter&apos;s speech catalog.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          <span data-testid="catalog-synced">{catalog.syncedAt ? `Synced ${new Date(catalog.syncedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} · ${catalog.models.length} models` : "Not synced yet"}</span>
          {catalog.syncError ? <span className="text-[var(--color-error)]">Last sync failed: {catalog.syncError}</span> : null}
          {canManage ? (
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => act(syncVoiceCatalogAction)} data-testid="sync-voices">
              <RefreshCw className="h-4 w-4" aria-hidden /> Sync voices (free)
            </Button>
          ) : null}
          <SelectNative aria-label="Language filter" value={lang} onChange={(e) => setLang(e.target.value as typeof lang)} className="h-8 w-48">
            <option value="hi">Hindi / Hinglish</option>
            <option value="en">English</option>
            <option value="all">All models</option>
          </SelectNative>
        </CardContent>
      </Card>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        Voice previews are short paid speech requests. They arrive with the voice generation stage and will show their exact price before playing — no preview is generated automatically.
      </p>
      {error ? <p role="alert" className="text-sm text-[var(--color-error)]">{error}</p> : null}
      {catalog.models.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No speech models yet. {canManage ? "Click “Sync voices”." : "A Master Admin can sync the list."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" data-testid="speech-models">
            <thead>
              <tr className="text-left text-xs text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-2 font-medium">Approved</th>
                <th className="py-2 pr-2 font-medium">Model</th>
                <th className="py-2 pr-2 font-medium">Hindi</th>
                <th className="py-2 pr-2 font-medium">English</th>
                <th className="py-2 pr-2 font-medium">Price</th>
                <th className="py-2 font-medium">Voices</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {models.map((m) => (
                <tr key={m.id} data-model={m.id}>
                  <td className="py-2 pr-2 align-top">
                    <input
                      type="checkbox"
                      aria-label={`Approve ${m.name}`}
                      checked={approved.includes(m.id)}
                      disabled={!canManage || pending || m.unit === "unknown"}
                      onChange={(e) => setApproved((cur) => (e.target.checked ? [...cur, m.id] : cur.filter((x) => x !== m.id)))}
                    />
                  </td>
                  <td className="py-2 pr-2 align-top">
                    <p className="font-medium">{m.name}</p>
                    <p className="text-xs text-[var(--color-muted-foreground)]">{m.id}</p>
                  </td>
                  <td className="py-2 pr-2 align-top"><Badge variant={SUPPORT[m.languages.hi].v}>{SUPPORT[m.languages.hi].label}</Badge></td>
                  <td className="py-2 pr-2 align-top"><Badge variant={SUPPORT[m.languages.en].v}>{SUPPORT[m.languages.en].label}</Badge></td>
                  <td className="py-2 pr-2 align-top text-xs">{price(m, fxRate)}</td>
                  <td className="py-2 align-top text-xs text-[var(--color-muted-foreground)]">
                    {m.voices.length ? `${m.voices.filter((v) => /hi-IN-|^h[fm]_/i.test(v)).join(", ") || m.voices.slice(0, 6).join(", ")}${m.voices.length > 6 ? ` … (${m.voices.length})` : ""}` : "Provider default"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canManage && dirty ? (
        <div>
          <Button type="button" disabled={pending} onClick={() => act(() => setApprovedSpeechModelsAction(approved))} data-testid="save-approvals">
            Save approvals
          </Button>
        </div>
      ) : null}
    </div>
  );
}
