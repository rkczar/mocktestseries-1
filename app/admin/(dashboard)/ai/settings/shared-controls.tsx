"use client";

import { type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SettingsFormState, TestConnectionState } from "./actions";

/** Shared by every provider settings card (Gemini/OpenAI) and general AI settings — kept in one place so the three cards look and behave identically. */

export function SubmitButton({ children, pendingLabel }: { children: ReactNode; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

export function TestButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending}>
      {pending ? "Testing…" : "Test Connection"}
    </Button>
  );
}

export function StatusBadge({ configured, enabled }: { configured: boolean; enabled: boolean }) {
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

export function TestResult({ state }: { state: TestConnectionState }) {
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

export function SaveFeedback({ state }: { state: SettingsFormState }) {
  if (state.error) return <p className="text-xs text-[var(--color-error)]">{state.error}</p>;
  if (state.success) return <p className="text-xs text-[var(--color-success)]">Saved.</p>;
  return null;
}
