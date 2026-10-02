"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { EmailTemplateKey } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { RichEditor } from "./rich-editor";
import { previewEmailAction, resetTemplateAction, saveTemplateAction, setTemplateEnabledAction } from "./actions";

export interface TemplateRow {
  key: EmailTemplateKey;
  label: string;
  description: string;
  category: "TRANSACTIONAL" | "PROMOTIONAL";
  critical: boolean;
  automatic: boolean;
  enabled: boolean;
  customized: boolean;
  updatedAt: string | null;
  subject: string;
  heading: string;
  bodyHtml: string;
  ctaText: string | null;
  ctaUrl: string | null;
}

const VARIABLE_HELP =
  "{{studentName}} {{email}} {{studentId}} {{examName}} {{testName}} {{productName}} {{amount}} {{orderNumber}} {{invoiceNumber}} {{paymentId}} {{loginUrl}} {{resetUrl}} {{dashboardUrl}} {{invoiceUrl}} {{siteUrl}} {{supportEmail}}";

export function TemplatesPanel({ templates, canManage }: { templates: TemplateRow[]; canManage: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(t: TemplateRow, enabled: boolean) {
    setError(null);
    startTransition(async () => {
      const r = await setTemplateEnabledAction(t.key, enabled);
      if (!r.ok) setError(r.error);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Templates</CardTitle>
        <CardDescription>
          Automatic emails use these templates when their event happens. A disabled template is never sent (its events are logged as
          skipped). Variables: <span className="font-mono text-xs">{VARIABLE_HELP}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? <p className="text-sm text-[var(--color-error)]" role="alert">{error}</p> : null}
        <ul className="flex flex-col divide-y divide-[var(--color-border)]">
          {templates.map((t) => (
            <li key={t.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {t.label} <span className="font-mono text-xs text-[var(--color-muted-foreground)]">{t.key}</span>
                  <Badge variant={t.category === "TRANSACTIONAL" ? "info" : "primary"}>{t.category === "TRANSACTIONAL" ? "Transactional" : "Promotional"}</Badge>
                  {t.automatic ? <Badge>Automatic</Badge> : <Badge>Compose</Badge>}
                  {t.customized ? <Badge variant="warning">Edited</Badge> : null}
                </p>
                <p className="text-xs text-[var(--color-muted-foreground)]">{t.description}</p>
                <p className="truncate text-xs text-[var(--color-muted-foreground)]">Subject: {t.subject || "(set in Compose)"}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <label className="flex items-center gap-2 text-xs">
                  <Switch checked={t.enabled} onCheckedChange={(v) => toggle(t, v)} disabled={!canManage || pending} aria-label={`${t.label} enabled`} />
                  {t.enabled ? "Enabled" : "Disabled"}
                </label>
                <Button size="sm" variant="outline" onClick={() => setEditing(t)}>
                  {canManage ? "Edit" : "View"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          {editing ? <TemplateEditor key={editing.key} template={editing} canManage={canManage} onDone={() => { setEditing(null); router.refresh(); }} /> : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function TemplateEditor({ template, canManage, onDone }: { template: TemplateRow; canManage: boolean; onDone: () => void }) {
  const [subject, setSubject] = useState(template.subject);
  const [heading, setHeading] = useState(template.heading);
  const [bodyHtml, setBodyHtml] = useState(template.bodyHtml);
  const [ctaText, setCtaText] = useState(template.ctaText ?? "");
  const [ctaUrl, setCtaUrl] = useState(template.ctaUrl ?? "");
  const [enabled, setEnabled] = useState(template.enabled);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const content = { subject, heading, bodyHtml, ctaText, ctaUrl };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="pr-6 text-base font-semibold">{template.label}</p>
        <p className="text-xs text-[var(--color-muted-foreground)]">{template.description}</p>
        {template.critical ? (
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">Critical account email: sent even to students who unsubscribed from announcements.</p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tpl-subject">Subject</Label>
        <Input id="tpl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} disabled={!canManage} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tpl-heading">Heading</Label>
        <Input id="tpl-heading" value={heading} onChange={(e) => setHeading(e.target.value)} maxLength={200} disabled={!canManage} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Body</Label>
        <RichEditor value={bodyHtml} onChange={setBodyHtml} disabled={!canManage} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tpl-cta-text">Button text</Label>
          <Input id="tpl-cta-text" value={ctaText} onChange={(e) => setCtaText(e.target.value)} maxLength={60} disabled={!canManage} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tpl-cta-url">Button URL</Label>
          <Input id="tpl-cta-url" value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="{{dashboardUrl}} or /student/dashboard" disabled={!canManage} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!canManage} /> Enabled
      </label>
      {error ? <p className="text-sm text-[var(--color-error)]" role="alert">{error}</p> : null}
      {preview ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">Subject: {preview.subject}</p>
          <iframe title="Template preview" sandbox="" srcDoc={preview.html} className="h-[50vh] w-full rounded border border-[var(--color-border)] bg-white" />
        </div>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const r = await previewEmailAction(content, { promotional: template.category === "PROMOTIONAL" });
              if (r.ok) setPreview({ subject: r.subject, html: r.html });
              else setError(r.error);
            })
          }
        >
          Preview
        </Button>
        {canManage && template.customized ? (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => {
              if (!window.confirm("Reset this template to the built-in default? Your edits will be lost.")) return;
              startTransition(async () => {
                const r = await resetTemplateAction(template.key);
                if (r.ok) onDone();
                else setError(r.error);
              });
            }}
          >
            Reset to default
          </Button>
        ) : null}
        {canManage ? (
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const r = await saveTemplateAction(template.key, content, enabled);
                if (r.ok) onDone();
                else setError(r.error);
              })
            }
          >
            Save template
          </Button>
        ) : null}
      </div>
    </div>
  );
}
