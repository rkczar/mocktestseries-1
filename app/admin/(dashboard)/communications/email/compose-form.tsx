"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { EmailAudience, EmailTemplateKey } from "@prisma/client";
import { X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { RichEditor } from "./rich-editor";
import { audienceCountAction, previewEmailAction, queueCampaignAction, saveCampaignDraftAction, searchStudentsAction } from "./actions";

export interface ComposeTemplate {
  key: EmailTemplateKey;
  label: string;
  subject: string;
  heading: string;
  bodyHtml: string;
  ctaText: string | null;
  ctaUrl: string | null;
}

export interface ComposeDraft {
  id: string;
  name: string;
  templateKey: EmailTemplateKey;
  subject: string;
  heading: string;
  bodyHtml: string;
  ctaText: string | null;
  ctaUrl: string | null;
  audience: EmailAudience;
  examId: string | null;
  students: StudentPick[];
}

interface StudentPick {
  id: string;
  name: string;
  email: string | null;
  mobile?: string | null;
  studentId?: string;
}

interface Counts {
  matching: number;
  sendable: number;
  excluded: number;
}

const AUDIENCES: { value: EmailAudience; label: string }[] = [
  { value: "INDIVIDUAL", label: "Individual student" },
  { value: "SELECTED", label: "Selected students" },
  { value: "ALL", label: "All students" },
  { value: "PAID", label: "Paid students (active paid access)" },
  { value: "FREE", label: "Free students" },
  { value: "EXAM", label: "Exam-wise students" },
];

export function ComposeForm({
  templates,
  exams,
  draft,
  from,
  replyTo,
  sendingReady,
  sendingProblem,
  canManage,
}: {
  templates: ComposeTemplate[];
  exams: { id: string; name: string }[];
  draft: ComposeDraft | null;
  from: string;
  replyTo: string;
  sendingReady: boolean;
  sendingProblem: string | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const initial = draft ?? { ...templates[0], name: "", templateKey: templates[0].key, audience: "ALL" as EmailAudience, examId: null, students: [] };
  const [campaignId, setCampaignId] = useState<string | null>(draft?.id ?? null);
  const [name, setName] = useState(initial.name);
  const [templateKey, setTemplateKey] = useState<EmailTemplateKey>(initial.templateKey);
  const [subject, setSubject] = useState(initial.subject);
  const [heading, setHeading] = useState(initial.heading);
  const [bodyHtml, setBodyHtml] = useState(initial.bodyHtml);
  const [ctaText, setCtaText] = useState(initial.ctaText ?? "");
  const [ctaUrl, setCtaUrl] = useState(initial.ctaUrl ?? "");
  const [audience, setAudience] = useState<EmailAudience>(initial.audience);
  const [examId, setExamId] = useState<string>(initial.examId ?? exams[0]?.id ?? "");
  const [students, setStudents] = useState<StudentPick[]>(initial.students);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StudentPick[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [confirm, setConfirm] = useState<{ counts: Counts; preview: { subject: string; html: string } } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const sendingRef = useRef(false);

  const content = { subject, heading, bodyHtml, ctaText, ctaUrl };
  const audienceSpec = { audience, examId: audience === "EXAM" ? examId : null, studentIds: students.map((s) => s.id) };

  // Live recipient count (server-side; the confirmation step re-counts).
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await audienceCountAction({ audience, examId: audience === "EXAM" ? examId : null, studentIds: students.map((s) => s.id) });
      if (!cancelled) setCounts(r.ok ? r.counts : null);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [audience, examId, students]);

  // Student search by name / email / mobile / User ID.
  useEffect(() => {
    if (query.trim().length < 2) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await searchStudentsAction(query);
      if (!cancelled && r.ok) setResults(r.students);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  function applyTemplate(key: EmailTemplateKey) {
    const t = templates.find((x) => x.key === key);
    if (!t) return;
    setTemplateKey(key);
    setSubject(t.subject);
    setHeading(t.heading);
    setBodyHtml(t.bodyHtml);
    setCtaText(t.ctaText ?? "");
    setCtaUrl(t.ctaUrl ?? "");
  }

  function pick(s: StudentPick) {
    if (audience === "INDIVIDUAL") setStudents([s]);
    else if (!students.some((x) => x.id === s.id)) setStudents([...students, s]);
    setQuery("");
    setResults([]);
  }

  function showPreview() {
    setError(null);
    startTransition(async () => {
      const r = await previewEmailAction(content, { promotional: true, studentId: students[0]?.id ?? null });
      if (r.ok) setPreview({ subject: r.subject, html: r.html });
      else setError(r.error);
    });
  }

  function save(thenReview: boolean) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const r = await saveCampaignDraftAction({ name, templateKey, ...content, ...audienceSpec }, campaignId);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setCampaignId(r.campaignId);
      if (thenReview) {
        setConfirmed(false);
        setConfirm({ counts: r.counts, preview: r.preview });
      } else {
        setNotice("Draft saved. You can find it under Campaigns.");
        router.refresh();
      }
    });
  }

  function send() {
    if (!confirm || !campaignId || sendingRef.current) return;
    sendingRef.current = true;
    setError(null);
    startTransition(async () => {
      const r = await queueCampaignAction(campaignId, confirm.counts.sendable);
      sendingRef.current = false;
      if (!r.ok) {
        setError(r.error);
        setConfirm(null);
        return;
      }
      setConfirm(null);
      setNotice(`Queued ${r.queued} email${r.queued === 1 ? "" : "s"}. Delivery runs in the background; follow it under Campaigns and Email Logs.`);
      // Start a fresh compose so the sent campaign can't be re-sent from this form.
      setCampaignId(null);
      router.refresh();
    });
  }

  const readOnly = !canManage;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Compose email</CardTitle>
        <CardDescription>
          Emails from this form are announcements: students who unsubscribed are skipped automatically. Bulk email is queued and sent
          in the background, never inside this request.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {readOnly ? <p className="text-sm text-[var(--color-muted-foreground)]">Read-only: only a Master Admin can compose and send email.</p> : null}
        {!sendingReady ? (
          <p className="rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-sm text-[var(--color-warning)]">
            {sendingProblem ?? "Sending is not available yet."} You can still write and save drafts.
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>From</Label>
            <Input value={from} readOnly disabled />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Reply-To</Label>
            <Input value={replyTo} readOnly disabled />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="em-template">Start from template</Label>
            <SelectNative id="em-template" value={templateKey} onChange={(e) => applyTemplate(e.target.value as EmailTemplateKey)} disabled={readOnly}>
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="em-name">Campaign name (internal)</Label>
            <Input id="em-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the subject" maxLength={120} disabled={readOnly} />
          </div>
        </div>

        <fieldset className="flex flex-col gap-3 rounded-md border border-[var(--color-border)] p-4" disabled={readOnly}>
          <legend className="px-1 text-sm font-medium">Recipients</legend>
          <SelectNative
            aria-label="Audience"
            value={audience}
            onChange={(e) => {
              const next = e.target.value as EmailAudience;
              setAudience(next);
              if (next === "INDIVIDUAL") setStudents(students.slice(0, 1));
            }}
          >
            {AUDIENCES.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </SelectNative>
          {audience === "EXAM" ? (
            <SelectNative aria-label="Exam" value={examId} onChange={(e) => setExamId(e.target.value)}>
              {exams.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </SelectNative>
          ) : null}
          {audience === "INDIVIDUAL" || audience === "SELECTED" ? (
            <div className="flex flex-col gap-2">
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, email, mobile or User ID" aria-label="Search students" />
              {query.trim().length >= 2 && results.length > 0 ? (
                <ul className="max-h-56 overflow-y-auto rounded-md border border-[var(--color-border)] text-sm">
                  {results.map((s) => (
                    <li key={s.id}>
                      <button type="button" onClick={() => pick(s)} className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-[color-mix(in_srgb,var(--color-foreground)_6%,transparent)]">
                        <span>
                          {s.name} <span className="text-xs text-[var(--color-muted-foreground)]">{s.studentId}</span>
                        </span>
                        <span className="text-xs text-[var(--color-muted-foreground)]">
                          {s.email ?? "No email"} {s.mobile ? `· ${s.mobile}` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {students.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {students.map((s) => (
                    <span key={s.id} className="flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs">
                      {s.name} {s.email ? `(${s.email})` : "(no email)"}
                      <button type="button" aria-label={`Remove ${s.name}`} onClick={() => setStudents(students.filter((x) => x.id !== s.id))}>
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {counts
              ? `${counts.sendable} recipient${counts.sendable === 1 ? "" : "s"}${counts.excluded ? ` (${counts.excluded} unsubscribed or suppressed, skipped)` : ""}. Only active students with an email address are included.`
              : "Counting recipients…"}
          </p>
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="em-subject">Subject</Label>
          <Input id="em-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} disabled={readOnly} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="em-heading">Heading</Label>
          <Input id="em-heading" value={heading} onChange={(e) => setHeading(e.target.value)} maxLength={200} disabled={readOnly} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Email body</Label>
          <RichEditor key={`${templateKey}-${draft?.id ?? "new"}`} value={bodyHtml} onChange={setBodyHtml} disabled={readOnly} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="em-cta-text">Button text (optional)</Label>
            <Input id="em-cta-text" value={ctaText} onChange={(e) => setCtaText(e.target.value)} maxLength={60} disabled={readOnly} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="em-cta-url">Button URL (optional)</Label>
            <Input id="em-cta-url" value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="https://… or /student/dashboard" disabled={readOnly} />
          </div>
        </div>

        {error ? <p className="text-sm text-[var(--color-error)]" role="alert">{error}</p> : null}
        {notice ? <p className="text-sm text-[var(--color-success)]" role="status">{notice}</p> : null}

        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={showPreview} disabled={pending}>
              Preview
            </Button>
            <Button type="button" variant="secondary" onClick={() => save(false)} disabled={pending}>
              Save draft
            </Button>
            <Button type="button" onClick={() => save(true)} disabled={pending || !sendingReady}>
              Review and send…
            </Button>
          </div>
        ) : null}
      </CardContent>

      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-2xl">
          <p className="pr-6 text-sm font-medium">Subject: {preview?.subject || "(empty)"}</p>
          <p className="text-xs text-[var(--color-muted-foreground)]">Preview with sample values{students[0] ? ` for ${students[0].name}` : ""}.</p>
          {preview ? <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="mt-3 h-[60vh] w-full rounded border border-[var(--color-border)] bg-white" /> : null}
        </DialogContent>
      </Dialog>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && !pending && setConfirm(null)}>
        <DialogContent className="max-w-2xl">
          {confirm ? (
            <div className="flex flex-col gap-3">
              <p className="pr-6 text-base font-semibold">Confirm sending</p>
              <p className="text-sm">
                <strong>{confirm.counts.sendable}</strong> recipient{confirm.counts.sendable === 1 ? "" : "s"}
                {confirm.counts.excluded ? ` (${confirm.counts.excluded} unsubscribed or suppressed will be skipped)` : ""}.
              </p>
              <p className="text-sm">Subject: {confirm.preview.subject}</p>
              <iframe title="Final email preview" sandbox="" srcDoc={confirm.preview.html} className="h-[45vh] w-full rounded border border-[var(--color-border)] bg-white" />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} />
                I have checked the preview and want to send this email to {confirm.counts.sendable} student{confirm.counts.sendable === 1 ? "" : "s"}.
              </label>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setConfirm(null)} disabled={pending}>
                  Cancel
                </Button>
                <Button onClick={send} disabled={!confirmed || pending || confirm.counts.sendable === 0}>
                  {pending ? "Queueing…" : `Send to ${confirm.counts.sendable}`}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
