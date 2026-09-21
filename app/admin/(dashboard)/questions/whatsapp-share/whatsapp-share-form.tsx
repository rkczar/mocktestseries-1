"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { WhatsAppShareConfig } from "@/lib/whatsapp-share-config";
import { WHATSAPP_SHARE_PLACEHOLDERS, renderWhatsAppShareText } from "@/lib/whatsapp-share-template";
import { saveWhatsAppShareConfigAction, type WhatsAppShareFormState } from "./actions";

const PREVIEW_VALUES = {
  exam: "NEET UG",
  subject: "Physics",
  question: "A body of mass 2 kg is thrown vertically upward with a velocity of 20 m/s. What is its kinetic energy at the highest point?",
  website_url: "https://mocktestseries.in",
};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </Button>
  );
}

export function WhatsAppShareForm({ config, canManage }: { config: WhatsAppShareConfig; canManage: boolean }) {
  const [state, formAction] = useActionState<WhatsAppShareFormState, FormData>(saveWhatsAppShareConfigAction, {});
  const [template, setTemplate] = useState(config.template);
  const [showPreview, setShowPreview] = useState(false);

  const preview = useMemo(() => renderWhatsAppShareText(template, PREVIEW_VALUES), [template]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Question WhatsApp Share</CardTitle>
        <CardDescription>
          Controls the WhatsApp Share action students see on the Review Answers page. Disabled hides it entirely.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          <div className="flex items-center justify-between rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-[var(--color-foreground)]">Enabled</p>
              <p className="text-xs text-[var(--color-muted-foreground)]">Show the WhatsApp Share button on the student Review page.</p>
            </div>
            <Switch name="enabled" defaultChecked={config.enabled} disabled={!canManage} />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="whatsapp-template" className="text-sm font-medium text-[var(--color-foreground)]">
              Message Template
            </label>
            <Textarea
              id="whatsapp-template"
              name="template"
              rows={6}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              disabled={!canManage}
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Placeholders: {WHATSAPP_SHARE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? "Hide Preview" : "Preview Message"}
            </Button>
            {showPreview ? (
              <pre className="whitespace-pre-wrap rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm text-[var(--color-foreground)]">
                {preview}
              </pre>
            ) : null}
          </div>

          {canManage ? (
            <CardFooter className="flex-wrap items-center gap-3 p-0">
              <SubmitButton />
              {state.error ? <p className="text-xs text-[var(--color-error)]">{state.error}</p> : null}
              {state.success ? <p className="text-xs text-[var(--color-success)]">Saved.</p> : null}
            </CardFooter>
          ) : (
            <p className="text-xs text-[var(--color-muted-foreground)]">View only — MASTER_ADMIN can change this setting.</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
