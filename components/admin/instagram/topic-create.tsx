"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { useOpenEditor } from "@/components/admin/instagram/editor-host";
import { createTopicDraftAction } from "@/app/admin/(dashboard)/instagram/actions";
import { TOPIC_LIMITS } from "@/lib/instagram/types";

/** Admin → Instagram → Topic Posts: create (or reopen) the post for one topic, then open it in the carousel editor. */
export function TopicCreate({ exams }: { exams: { id: string; name: string }[] }) {
  const router = useRouter();
  const openEditor = useOpenEditor();
  const [title, setTitle] = useState("");
  const [examId, setExamId] = useState(exams[0]?.id ?? "");
  const [subjectName, setSubjectName] = useState("");
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const r = await createTopicDraftAction({ title, examId, subjectName, notes });
      if (!r.ok) return setMessage({ tone: "error", text: r.error });
      const p = r.data.post;
      setMessage({ tone: "ok", text: r.data.existed ? "This topic already has a post — opened it instead of creating a duplicate." : "Topic draft created. Write or generate the content next." });
      router.refresh();
      openEditor({ questionId: "", topicKey: p.topicKey ?? undefined, code: p.questionCode, preview: p.snapshot.text, series: "TOPIC" });
    });
  }

  if (!exams.length) return <p className="text-sm text-[var(--color-muted-foreground)]">No exam is in Instagram Studio&apos;s scope. A Master Admin can set the scope in Instagram → Settings.</p>;

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-3" data-testid="topic-create">
      <div className="grid gap-1.5">
        <Label htmlFor="topic-title">Topic</Label>
        <Input id="topic-title" value={title} maxLength={TOPIC_LIMITS.title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Causes of secondary hypertension" required />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="topic-exam">Exam</Label>
          <SelectNative id="topic-exam" value={examId} onChange={(e) => setExamId(e.target.value)}>
            {exams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </SelectNative>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="topic-subject">Subject (optional)</Label>
          <Input id="topic-subject" value={subjectName} maxLength={80} onChange={(e) => setSubjectName(e.target.value)} placeholder="e.g. Medicine" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="topic-notes">Source notes (optional, recommended)</Label>
        <Textarea id="topic-notes" value={notes} maxLength={TOPIC_LIMITS.notes} rows={6} onChange={(e) => setNotes(e.target.value)} placeholder="Key points from your notes or a standard textbook. The AI writes from these; without them the post shows a review warning." />
        <span className="text-[11px] text-[var(--color-muted-foreground)]">{`${notes.length}/${TOPIC_LIMITS.notes}`}</span>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || title.trim().length < 3} data-testid="topic-create-submit">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Create Topic Draft
        </Button>
        {message ? (
          <span role="status" className={message.tone === "error" ? "text-sm text-[var(--color-error)]" : "text-sm text-[var(--color-muted-foreground)]"}>
            {message.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}
