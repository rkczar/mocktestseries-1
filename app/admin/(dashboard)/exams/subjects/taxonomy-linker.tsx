"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Copy, Library } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { linkTaxonomyAction } from "./actions";

/** One canonical master record plus the ids of every exam that currently links it. */
export interface MasterSubTopic {
  id: string;
  name: string;
  examIds: string[];
}
export interface MasterTopic {
  id: string;
  name: string;
  examIds: string[];
  subTopics: MasterSubTopic[];
}
export interface MasterSubject {
  id: string;
  name: string;
  examIds: string[];
  topics: MasterTopic[];
}

type Mode = "existing" | "exam";

/**
 * Add Existing Subject / Use Taxonomy From Existing Exam. Both browse the ONE
 * canonical Subject -> Topic -> SubTopic tree; "exam" mode just narrows it to
 * what the source exam links. Confirming creates link rows only — nothing
 * is copied, so "Anatomy" stays a single record shared by every exam.
 *
 * Checking a subject selects its visible topics/sub-topics (uncheck any you
 * don't want); checking a topic or sub-topic also selects its parents.
 * Items the target exam already links show as "Linked" and can't change here.
 */
export function TaxonomyLinker({
  mode,
  examId,
  examName,
  exams,
  master,
}: {
  mode: Mode;
  examId: string;
  examName: string;
  exams: { id: string; name: string }[];
  master: MasterSubject[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const sourceExams = exams.filter((e) => e.id !== examId);
  const [sourceExamId, setSourceExamId] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [subjects, setSubjects] = useState<Set<string>>(new Set());
  const [topics, setTopics] = useState<Set<string>>(new Set());
  const [subTopics, setSubTopics] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  // The tree this dialog offers: whole master taxonomy, or the source exam's linked part of it.
  const tree = useMemo(() => {
    if (mode === "existing") {
      const q = search.trim().toLowerCase();
      return q ? master.filter((s) => s.name.toLowerCase().includes(q) || s.topics.some((t) => t.name.toLowerCase().includes(q))) : master;
    }
    if (!sourceExamId) return [];
    return master
      .filter((s) => s.examIds.includes(sourceExamId))
      .map((s) => ({
        ...s,
        topics: s.topics
          .filter((t) => t.examIds.includes(sourceExamId))
          .map((t) => ({ ...t, subTopics: t.subTopics.filter((st) => st.examIds.includes(sourceExamId)) })),
      }));
  }, [master, mode, search, sourceExamId]);

  const linked = (ids: string[]) => ids.includes(examId);

  const reset = () => {
    setSubjects(new Set());
    setTopics(new Set());
    setSubTopics(new Set());
    setExpanded(new Set());
  };

  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };

  const setSubject = (s: MasterSubject, on: boolean) => {
    setSubjects((prev) => toggle(prev, s.id, on));
    setTopics((prev) => {
      const next = new Set(prev);
      for (const t of s.topics) if (!linked(t.examIds)) { if (on) next.add(t.id); else next.delete(t.id); };
      return next;
    });
    setSubTopics((prev) => {
      const next = new Set(prev);
      for (const t of s.topics) for (const st of t.subTopics) if (!linked(st.examIds)) { if (on) next.add(st.id); else next.delete(st.id); };
      return next;
    });
  };

  const setTopic = (s: MasterSubject, t: MasterTopic, on: boolean) => {
    setTopics((prev) => toggle(prev, t.id, on));
    setSubTopics((prev) => {
      const next = new Set(prev);
      for (const st of t.subTopics) if (!linked(st.examIds)) { if (on) next.add(st.id); else next.delete(st.id); };
      return next;
    });
    if (on && !linked(s.examIds)) setSubjects((prev) => toggle(prev, s.id, true));
  };

  const setSubTopic = (s: MasterSubject, t: MasterTopic, st: MasterSubTopic, on: boolean) => {
    setSubTopics((prev) => toggle(prev, st.id, on));
    if (on) {
      if (!linked(t.examIds)) setTopics((prev) => toggle(prev, t.id, true));
      if (!linked(s.examIds)) setSubjects((prev) => toggle(prev, s.id, true));
    }
  };

  const selectAllFromSource = () => {
    const sIds = new Set<string>();
    const tIds = new Set<string>();
    const stIds = new Set<string>();
    for (const s of tree) {
      if (!linked(s.examIds)) sIds.add(s.id);
      for (const t of s.topics) {
        if (!linked(t.examIds)) tIds.add(t.id);
        for (const st of t.subTopics) if (!linked(st.examIds)) stIds.add(st.id);
      }
    }
    setSubjects(sIds);
    setTopics(tIds);
    setSubTopics(stIds);
  };

  const total = subjects.size + topics.size + subTopics.size;

  const confirm = () => {
    setMessage(null);
    startTransition(async () => {
      const res = await linkTaxonomyAction({
        examId,
        subjectIds: [...subjects],
        topicIds: [...topics],
        subTopicIds: [...subTopics],
        sourceExamId: mode === "exam" ? sourceExamId : undefined,
      });
      if (res.error) {
        setMessage({ kind: "error", text: res.error });
        return;
      }
      const l = res.linked!;
      setMessage({ kind: "ok", text: `Linked ${l.subjects} subject(s), ${l.topics} topic(s), ${l.subTopics} sub-topic(s) to ${examName}. No records were copied.` });
      reset();
      router.refresh();
    });
  };

  const expandKey = (id: string) => expanded.has(id);
  const flip = (id: string) => setExpanded((prev) => toggle(prev, id, !prev.has(id)));

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          reset();
          setMessage(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          {mode === "existing" ? <Library className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {mode === "existing" ? "Add Existing Subject" : "Use Taxonomy From Existing Exam"}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>{mode === "existing" ? `Add existing subjects to ${examName}` : `Reuse another exam's taxonomy for ${examName}`}</DialogTitle>
          <DialogDescription>
            Links the shared master Subjects, Topics and Sub-topics to this exam. Nothing is copied, and no questions are shared
            between exams.
          </DialogDescription>
        </DialogHeader>

        {mode === "existing" ? (
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search subjects or topics…" aria-label="Search master taxonomy" />
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
              <Label htmlFor="taxonomy-source-exam">Use taxonomy from</Label>
              <SelectNative
                id="taxonomy-source-exam"
                value={sourceExamId}
                onChange={(e) => {
                  setSourceExamId(e.target.value);
                  reset();
                }}
              >
                <option value="">Select an exam…</option>
                {sourceExams.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </SelectNative>
            </div>
            {sourceExamId && tree.length > 0 ? (
              <Button type="button" size="sm" variant="outline" onClick={selectAllFromSource}>
                Select all
              </Button>
            ) : null}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto rounded-[var(--radius-button)] border border-[var(--color-border)]">
          {tree.length === 0 ? (
            <p className="p-4 text-center text-sm text-[var(--color-muted-foreground)]">
              {mode === "exam" ? (sourceExamId ? "That exam has no linked taxonomy." : "Choose an exam to preview its taxonomy.") : "No matching subjects."}
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {tree.map((s) => {
                const sLinked = linked(s.examIds);
                return (
                  <li key={s.id} className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => flip(s.id)} aria-label={`${expandKey(s.id) ? "Collapse" : "Expand"} ${s.name}`} aria-expanded={expandKey(s.id)}>
                        {expandKey(s.id) ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                      </button>
                      <Checkbox
                        id={`s-${s.id}`}
                        checked={sLinked || subjects.has(s.id)}
                        disabled={sLinked}
                        onCheckedChange={(v) => setSubject(s, v === true)}
                      />
                      <label htmlFor={`s-${s.id}`} className="flex-1 text-sm font-medium text-[var(--color-foreground)]">
                        {s.name}
                      </label>
                      <span className="text-xs text-[var(--color-muted-foreground)]">
                        {sLinked ? "Linked · " : ""}
                        {s.topics.length} topic{s.topics.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    {expandKey(s.id) ? (
                      <ul className="ml-8 mt-2 flex flex-col gap-1.5">
                        {s.topics.length === 0 ? <li className="text-xs text-[var(--color-muted-foreground)]">No topics.</li> : null}
                        {s.topics.map((t) => {
                          const tLinked = linked(t.examIds);
                          return (
                            <li key={t.id}>
                              <div className="flex items-center gap-2">
                                {t.subTopics.length > 0 ? (
                                  <button type="button" onClick={() => flip(t.id)} aria-label={`${expandKey(t.id) ? "Collapse" : "Expand"} ${t.name}`} aria-expanded={expandKey(t.id)}>
                                    {expandKey(t.id) ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                                  </button>
                                ) : (
                                  <span className="w-3.5" />
                                )}
                                <Checkbox
                                  id={`t-${t.id}`}
                                  checked={tLinked || topics.has(t.id)}
                                  disabled={tLinked}
                                  onCheckedChange={(v) => setTopic(s, t, v === true)}
                                />
                                <label htmlFor={`t-${t.id}`} className="flex-1 text-sm text-[var(--color-foreground)]">
                                  {t.name}
                                </label>
                                {tLinked ? <span className="text-xs text-[var(--color-muted-foreground)]">Linked</span> : null}
                              </div>
                              {expandKey(t.id) ? (
                                <ul className="ml-9 mt-1 flex flex-col gap-1">
                                  {t.subTopics.map((st) => {
                                    const stLinked = linked(st.examIds);
                                    return (
                                      <li key={st.id} className="flex items-center gap-2">
                                        <Checkbox
                                          id={`st-${st.id}`}
                                          checked={stLinked || subTopics.has(st.id)}
                                          disabled={stLinked}
                                          onCheckedChange={(v) => setSubTopic(s, t, st, v === true)}
                                        />
                                        <label htmlFor={`st-${st.id}`} className="flex-1 text-xs text-[var(--color-foreground)]">
                                          {st.name}
                                        </label>
                                        {stLinked ? <span className="text-xs text-[var(--color-muted-foreground)]">Linked</span> : null}
                                      </li>
                                    );
                                  })}
                                </ul>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="text-xs text-[var(--color-muted-foreground)]">
          Selected: {subjects.size} subject(s), {topics.size} topic(s), {subTopics.size} sub-topic(s)
        </p>
        {message ? (
          <p className={`text-sm ${message.kind === "ok" ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>{message.text}</p>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Close
            </Button>
          </DialogClose>
          <Button type="button" onClick={confirm} disabled={isPending || total === 0}>
            {isPending ? "Linking…" : "Confirm — Link Selected"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
