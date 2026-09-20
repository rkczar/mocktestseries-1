"use client";

import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectNative } from "@/components/ui/select-native";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { getPaperCandidateQuestions, linkQuestionsToPaperAction, type CandidateQuestion } from "../actions";

interface SubjectOption {
  id: string;
  name: string;
  topics: { id: string; name: string }[];
}

/**
 * "Add Questions from Question Bank" (Sections 16-18). Matches Question Bank
 * questions by the paper's Exam + Year (the only reliable canonical
 * metadata without a Paper Code column on Question), then lets the admin
 * narrow by Subject/Topic and select individually or all — never an
 * unreviewed bulk link.
 */
export function QuestionBankPicker({ paperId, subjects }: { paperId: string; subjects: SubjectOption[] }) {
  const [expanded, setExpanded] = useState(false);
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [candidates, setCandidates] = useState<CandidateQuestion[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [linking, startLinking] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const topics = useMemo(() => subjects.find((s) => s.id === subjectId)?.topics ?? [], [subjects, subjectId]);

  const search = async (filters?: { subjectId?: string; topicId?: string }) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const results = await getPaperCandidateQuestions(paperId, filters);
      setCandidates(results);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load matching questions.");
    } finally {
      setLoading(false);
    }
  };

  const handleExpand = () => {
    setExpanded(true);
    if (!candidates) void search();
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!candidates) return;
    setSelected((prev) => (prev.size === candidates.length ? new Set() : new Set(candidates.map((c) => c.id))));
  };

  const handleLink = (ids: string[]) => {
    if (ids.length === 0) return;
    setError(null);
    startLinking(async () => {
      try {
        const { linked } = await linkQuestionsToPaperAction(paperId, ids);
        setNotice(`Linked ${linked} question(s) to this paper.`);
        await search({ subjectId: subjectId || undefined, topicId: topicId || undefined });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not link questions.");
      }
    });
  };

  if (!expanded) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <div>
            <CardTitle className="text-base">Add Questions from Question Bank</CardTitle>
            <CardDescription>Find Question Bank questions matching this paper&apos;s Exam and Year.</CardDescription>
          </div>
          <Button onClick={handleExpand}>Find Matching Questions</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add Questions from Question Bank</CardTitle>
        <CardDescription>
          Matched by Exam + Year (never guessed by Year alone across multiple papers) — narrow further by Subject/Topic and review before
          linking.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-[var(--color-muted-foreground)]">Subject</label>
            <SelectNative
              value={subjectId}
              onChange={(e) => {
                setSubjectId(e.target.value);
                setTopicId("");
                void search({ subjectId: e.target.value || undefined });
              }}
            >
              <option value="">All Subjects</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectNative>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-[var(--color-muted-foreground)]">Topic</label>
            <SelectNative
              value={topicId}
              onChange={(e) => {
                setTopicId(e.target.value);
                void search({ subjectId: subjectId || undefined, topicId: e.target.value || undefined });
              }}
              disabled={!subjectId}
            >
              <option value="">All Topics</option>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </SelectNative>
          </div>
          <Button variant="outline" size="sm" onClick={() => void search({ subjectId: subjectId || undefined, topicId: topicId || undefined })} disabled={loading}>
            Refresh
          </Button>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {notice ? (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}

        {loading ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">Searching…</p>
        ) : candidates && candidates.length === 0 ? (
          <p className="py-4 text-center text-sm text-[var(--color-muted-foreground)]">
            No matching Question Bank questions found for this Exam/Year that aren&apos;t already linked to another paper.
          </p>
        ) : candidates ? (
          <>
            <Alert>
              <AlertDescription>
                {candidates.length} matching Question Bank question{candidates.length === 1 ? "" : "s"} found.
              </AlertDescription>
            </Alert>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={selected.size === candidates.length && candidates.length > 0} onCheckedChange={toggleAll} />
                Select All
              </label>
              <Button size="sm" disabled={selected.size === 0 || linking} onClick={() => handleLink(Array.from(selected))}>
                {linking ? "Linking…" : `Add Selected (${selected.size})`}
              </Button>
            </div>
            <div className="max-h-96 overflow-y-auto rounded-md border border-[var(--color-border)]">
              <table className="w-full text-left text-sm">
                <tbody>
                  {candidates.map((c) => (
                    <tr key={c.id} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="w-8 py-2 pl-2">
                        <Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggle(c.id)} />
                      </td>
                      <td className="py-2 pr-2 font-mono text-xs text-[var(--color-muted-foreground)]">{c.code}</td>
                      <td className="py-2 pr-2 text-xs text-[var(--color-muted-foreground)]">
                        {c.subjectName}
                        {c.topicName ? ` / ${c.topicName}` : ""}
                      </td>
                      <td className="max-w-[360px] truncate py-2 pr-2 text-[var(--color-foreground)]">{c.text}</td>
                      <td className="py-2 pr-2 text-right">
                        <Button size="compact" variant="outline" disabled={linking} onClick={() => handleLink([c.id])}>
                          Add
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
