"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import type { OpenAiPublicConfig } from "@/lib/openai-config";
import { saveOpenAiConfigAction, testOpenAiConnectionAction, type SettingsFormState, type TestConnectionState } from "./actions";
import { SubmitButton, TestButton, StatusBadge, TestResult, SaveFeedback } from "./shared-controls";

/** Fallback provider — same encrypted-storage pattern as Gemini (lib/openai-config.ts, Setting.key = "api.openai"). Selecting it as active/fallback happens in AiGeneralSettingsCard. */
export function OpenAiCard({ openai }: { openai: OpenAiPublicConfig }) {
  const [saveState, saveAction] = useActionState<SettingsFormState, FormData>(saveOpenAiConfigAction, {});
  const [testState, testAction] = useActionState<TestConnectionState, FormData>(testOpenAiConnectionAction, {
    result: openai.lastTest ?? undefined,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>OpenAI</CardTitle>
          <StatusBadge configured={openai.configured} enabled={openai.enabled} />
        </div>
        <CardDescription>
          Fallback (or active) provider for Ask AI explanations and question variants. The key is encrypted at rest and
          never sent to the browser.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={saveAction} className="flex flex-col gap-4">
          <div className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-[var(--color-foreground)]">Enabled</p>
              <p className="text-xs text-[var(--color-muted-foreground)]">Allow AI explanation/variant generation to use OpenAI.</p>
            </div>
            <Switch name="enabled" defaultChecked={openai.enabled} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="openai-api-key">
              API Key {openai.apiKeyConfigured ? <span className="text-[var(--color-muted-foreground)]">(configured — leave blank to keep)</span> : null}
            </Label>
            <Input
              id="openai-api-key"
              name="apiKey"
              type="password"
              autoComplete="off"
              placeholder={openai.apiKeyConfigured ? "••••••••••••••••" : "Paste OpenAI API key"}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="openai-model">Model</Label>
            <Input id="openai-model" name="model" defaultValue={openai.model} placeholder="gpt-4o-mini" />
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
      </CardContent>
    </Card>
  );
}
