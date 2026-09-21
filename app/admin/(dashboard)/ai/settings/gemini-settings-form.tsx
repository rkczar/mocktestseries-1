"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import type { GeminiPublicConfig } from "@/lib/gemini-config";
import { saveGeminiConfigAction, testGeminiConnectionAction, type SettingsFormState, type TestConnectionState } from "./actions";
import { SubmitButton, TestButton, StatusBadge, TestResult, SaveFeedback } from "./shared-controls";
import { GeminiModelPoolCard } from "./gemini-model-pool-form";

/**
 * Moved here from Settings → Authentication (where it sat oddly among
 * Google OAuth / MSG91 SMS login providers, despite having nothing to do
 * with student authentication) — same underlying storage
 * (`Setting.key = "api.gemini"`, encrypted at rest, lib/gemini-config.ts),
 * just relocated to live with the rest of the AI module it actually
 * configures. This key is what powers Ask AI explanations (lib/ai-explanation.ts)
 * and AI01–AI05 question variants (lib/ai-variant.ts).
 */
export function GeminiCard({ gemini, canManagePool }: { gemini: GeminiPublicConfig; canManagePool: boolean }) {
  const [saveState, saveAction] = useActionState<SettingsFormState, FormData>(saveGeminiConfigAction, {});
  const [testState, testAction] = useActionState<TestConnectionState, FormData>(testGeminiConnectionAction, {
    result: gemini.lastTest ?? undefined,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Gemini AI</CardTitle>
          <StatusBadge configured={gemini.configured} enabled={gemini.enabled} />
        </div>
        <CardDescription>
          Powers Ask AI explanations and AI-generated question variants (AI01–AI05). The key is encrypted at rest and
          never sent to the browser.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={saveAction} className="flex flex-col gap-4">
          <div className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-[var(--color-foreground)]">Enabled</p>
              <p className="text-xs text-[var(--color-muted-foreground)]">Allow AI explanation/variant generation to use Gemini.</p>
            </div>
            <Switch name="enabled" defaultChecked={gemini.enabled} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gemini-api-key">
              API Key {gemini.apiKeyConfigured ? <span className="text-[var(--color-muted-foreground)]">(configured — leave blank to keep)</span> : null}
            </Label>
            <Input
              id="gemini-api-key"
              name="apiKey"
              type="password"
              autoComplete="off"
              placeholder={gemini.apiKeyConfigured ? "••••••••••••••••" : "Paste Gemini API key"}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gemini-model">Model (bootstrap only)</Label>
            <Input id="gemini-model" name="model" defaultValue={gemini.model} placeholder="gemini-flash-latest" />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Used only until a Model Pool is configured below — once a pool exists, Primary + Fallback there control which
              model(s) generation actually uses.
            </p>
          </div>

          <CardFooter className="flex-wrap items-center gap-3 p-0">
            <SubmitButton pendingLabel="Saving…">Save Configuration</SubmitButton>
            <SaveFeedback state={saveState} />
          </CardFooter>
        </form>

        <form action={testAction} className="mt-3 flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
          <div className="flex items-center gap-3">
            <TestButton />
            <TestResult state={testState} />
          </div>
        </form>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <GeminiModelPoolCard gemini={gemini} canManage={canManagePool} />
        </div>
      </CardContent>
    </Card>
  );
}
