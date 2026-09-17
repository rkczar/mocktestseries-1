"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import type { GeminiPublicConfig } from "@/lib/gemini-config";
import { saveGeminiConfigAction, testGeminiConnectionAction, type SettingsFormState, type TestConnectionState } from "./actions";

function SubmitButton({ children, pendingLabel }: { children: ReactNode; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

function TestButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending}>
      {pending ? "Testing…" : "Test Connection"}
    </Button>
  );
}

function StatusBadge({ configured, enabled }: { configured: boolean; enabled: boolean }) {
  if (!configured) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-warning)]/15 px-2.5 py-1 text-xs font-medium text-[var(--color-warning)]">
        <AlertCircle className="h-3.5 w-3.5" aria-hidden /> Not Configured
      </span>
    );
  }
  if (!enabled) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-muted-foreground)]/15 px-2.5 py-1 text-xs font-medium text-[var(--color-muted-foreground)]">
        Disabled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-success)]/15 px-2.5 py-1 text-xs font-medium text-[var(--color-success)]">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Connected
    </span>
  );
}

function TestResult({ state }: { state: TestConnectionState }) {
  if (!state.result) return null;
  const { ok, message, at } = state.result;
  return (
    <p className={`flex items-center gap-1.5 text-xs ${ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      {message}
      <span className="text-[var(--color-muted-foreground)]">· {new Date(at).toLocaleString()}</span>
    </p>
  );
}

function SaveFeedback({ state }: { state: SettingsFormState }) {
  if (state.error) return <p className="text-xs text-[var(--color-error)]">{state.error}</p>;
  if (state.success) return <p className="text-xs text-[var(--color-success)]">Saved.</p>;
  return null;
}

/**
 * Moved here from Settings → Authentication (where it sat oddly among
 * Google OAuth / MSG91 SMS login providers, despite having nothing to do
 * with student authentication) — same underlying storage
 * (`Setting.key = "api.gemini"`, encrypted at rest, lib/gemini-config.ts),
 * just relocated to live with the rest of the AI module it actually
 * configures. This key is what powers Ask AI explanations (lib/ai-explanation.ts)
 * and AI01–AI05 question variants (lib/ai-variant.ts).
 */
export function GeminiCard({ gemini }: { gemini: GeminiPublicConfig }) {
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
            <Label htmlFor="gemini-model">Model</Label>
            <Input id="gemini-model" name="model" defaultValue={gemini.model} placeholder="gemini-2.5-flash" />
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
