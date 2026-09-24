"use client";

import { useActionState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SelectNative } from "@/components/ui/select-native";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import type { AiSettings } from "@/lib/ai-settings";
import { saveAiSettingsAction, type SettingsFormState } from "./actions";
import { SubmitButton, SaveFeedback } from "./shared-controls";

export function AiGeneralSettingsCard({ settings }: { settings: AiSettings }) {
  const [saveState, saveAction] = useActionState<SettingsFormState, FormData>(saveAiSettingsAction, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>Which provider answers Ask AI, student daily limits, and what a generated explanation includes.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={saveAction} className="flex flex-col gap-5">
          <div className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-[var(--color-foreground)]">Ask AI Enabled</p>
              <p className="text-xs text-[var(--color-muted-foreground)]">Master switch — off blocks every new generation and cache read.</p>
            </div>
            <Switch name="askAiEnabled" defaultChecked={settings.askAiEnabled} />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="activeProvider">Active Provider</Label>
              <SelectNative id="activeProvider" name="activeProvider" defaultValue={settings.activeProvider}>
                <option value="gemini">Gemini</option>
                <option value="openai">OpenAI</option>
              </SelectNative>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fallbackProvider">Fallback Provider</Label>
              <SelectNative id="fallbackProvider" name="fallbackProvider" defaultValue={settings.fallbackProvider}>
                <option value="none">None</option>
                <option value="gemini">Gemini</option>
                <option value="openai">OpenAI</option>
              </SelectNative>
            </div>
          </div>
          <p className="-mt-3 text-xs text-[var(--color-muted-foreground)]">
            Used only when both providers below have a configured, enabled API key. If the active provider fails mid-request, the fallback is tried automatically.
          </p>

          <div>
            <p className="mb-2 text-sm font-medium text-[var(--color-foreground)]">Student Access</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="freeDailyLimit">Free Plan Daily AI Limit</Label>
                <Input id="freeDailyLimit" name="freeDailyLimit" type="number" min={1} defaultValue={settings.freeDailyLimit} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="paidDailyLimit">Paid Plan Daily AI Limit</Label>
                <Input id="paidDailyLimit" name="paidDailyLimit" type="number" min={1} defaultValue={settings.paidDailyLimit ?? 10} disabled={settings.paidDailyLimit === null} />
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
              <p className="text-sm text-[var(--color-foreground)]">Paid plan is unlimited</p>
              <Switch name="paidUnlimited" defaultChecked={settings.paidDailyLimit === null} />
            </div>
            <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
              Enforced server-side: students with an active entitlement to a PAID product (Payments → Products) get the Paid limit; everyone else gets the Free limit. Ask AI, Examiner Traps and AI Trap questions share this one quota.
            </p>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-[var(--color-foreground)]">Generation</p>
            <div className="flex flex-col gap-2">
              {[
                { name: "generateOptionAnalysis", label: "Generate option analysis (why other options are wrong)", checked: settings.generateOptionAnalysis },
                { name: "generatePointsToRemember", label: "Generate points to remember", checked: settings.generatePointsToRemember },
                { name: "generateMemoryTrick", label: "Generate memory trick", checked: settings.generateMemoryTrick },
                { name: "generateExaminerTraps", label: "Generate examiner traps & trap words", checked: settings.generateExaminerTraps },
              ].map((t) => (
                <div key={t.name} className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
                  <p className="text-sm text-[var(--color-foreground)]">{t.label}</p>
                  <Switch name={t.name} defaultChecked={t.checked} />
                </div>
              ))}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="maxRelatedQuestions">Maximum Related Questions</Label>
                <Input id="maxRelatedQuestions" name="maxRelatedQuestions" type="number" min={0} max={5} defaultValue={settings.maxRelatedQuestions} />
              </div>
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-[var(--color-foreground)]">Homepage Demo</p>
            <div className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
              <p className="text-sm text-[var(--color-foreground)]">Enable AI Demo on homepage</p>
              <Switch name="homepageDemoEnabled" defaultChecked={settings.homepageDemoEnabled} />
            </div>
            <div className="mt-2 flex flex-col gap-1.5">
              <Label htmlFor="homepageDemoMaxQuestions">Auto-select fallback count (used only when no questions are hand-picked below)</Label>
              <Input id="homepageDemoMaxQuestions" name="homepageDemoMaxQuestions" type="number" min={1} max={10} defaultValue={settings.homepageDemoMaxQuestions} />
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Hand-pick specific questions in &quot;Homepage AI Demo Questions&quot; below for full control — max 10 either way.
              </p>
            </div>
          </div>

          <CardFooter className="flex-wrap items-center gap-3 p-0">
            <SubmitButton pendingLabel="Saving…">Save Settings</SubmitButton>
            <SaveFeedback state={saveState} />
          </CardFooter>
        </form>
      </CardContent>
    </Card>
  );
}
