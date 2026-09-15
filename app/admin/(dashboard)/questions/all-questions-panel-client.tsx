"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusSelect } from "./status-select";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";

const DIFFICULTY_VARIANT = { EASY: "success", MEDIUM: "warning", HARD: "error" } as const;
const LIMIT = 50;

interface Question {
  id: string;
  code: string;
  text: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  examYear: number | null;
  source: string;
  exam: { id: string; name: string };
  subject: { id: string; name: string };
  topic: { id: string; name: string } | null;
  subTopic: { id: string; name: string } | null;
  previousYearPaper: { id: string; year: number; title: string } | null;
}

interface FilterOptions {
  exams: { id: string; name: string }[];
  subjects: { id: string; name: string; examId: string }[];
  topics: { id: string; name: string; subjectId: string }[];
}

export function AllQuestionsPanelClient({
  initialFilters,
  filterOptions
}: {
  initialFilters: Record<string, string>;
  filterOptions: FilterOptions;
}) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<string>("");

  // Filters
  const [search, setSearch] = useState(initialFilters.search || "");
  const [examId, setExamId] = useState(initialFilters.examId || "");
  const [examYear, setExamYear] = useState(initialFilters.examYear || "");
  const [subjectId, setSubjectId] = useState(initialFilters.subjectId || "");
  const [topicId, setTopicId] = useState(initialFilters.topicId || "");
  const [difficulty, setDifficulty] = useState(initialFilters.difficulty || "");
  const [status, setStatus] = useState(initialFilters.status || "");
  const [source, setSource] = useState(initialFilters.source || "");
  const [isPyq, setIsPyq] = useState(initialFilters.isPyq || "");

  const totalPages = Math.ceil(total / LIMIT);

  // Encodes every value the fetch depends on, including the manual-refresh
  // nonce. Comparing this against `loadedKey` (set once a fetch resolves)
  // derives `isLoading` during render, so no effect ever needs to call
  // setState synchronously before its first await.
  const fetchKey = useMemo(
    () =>
      JSON.stringify({ page, search, examId, examYear, subjectId, topicId, difficulty, status, source, isPyq, refreshNonce }),
    [page, search, examId, examYear, subjectId, topicId, difficulty, status, source, isPyq, refreshNonce]
  );
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const isLoading = loadedKey !== fetchKey;

  useEffect(() => {
    const f = JSON.parse(fetchKey) as {
      page: number;
      search: string;
      examId: string;
      examYear: string;
      subjectId: string;
      topicId: string;
      difficulty: string;
      status: string;
      source: string;
      isPyq: string;
    };
    let cancelled = false;
    const params = new URLSearchParams({ page: String(f.page), limit: String(LIMIT) });
    if (f.search) params.set("search", f.search);
    if (f.examId) params.set("examId", f.examId);
    if (f.examYear) params.set("examYear", f.examYear);
    if (f.subjectId) params.set("subjectId", f.subjectId);
    if (f.topicId) params.set("topicId", f.topicId);
    if (f.difficulty) params.set("difficulty", f.difficulty);
    if (f.status) params.set("status", f.status);
    if (f.source) params.set("source", f.source);
    if (f.isPyq) params.set("isPyq", f.isPyq);

    fetch(`/api/admin/questions?${params}`)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        setQuestions(data.questions);
        setTotal(data.pagination.total);
      })
      .catch((error) => {
        console.error("Failed to fetch questions:", error);
      })
      .finally(() => {
        if (!cancelled) setLoadedKey(fetchKey);
      });

    return () => {
      cancelled = true;
    };
  }, [fetchKey]);

  const handleToggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedIds.size === questions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(questions.map((q) => q.id)));
    }
  };

  const handleBulkAction = async () => {
    if (selectedIds.size === 0 || !bulkAction) return;

    const ids = Array.from(selectedIds);

    try {
      if (bulkAction === "delete") {
        if (!confirm(`Delete ${ids.length} questions? This cannot be undone.`)) return;

        const response = await fetch(`/api/admin/questions?ids=${ids.join(",")}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          const error = await response.json();
          alert(error.error || "Failed to delete questions");
          return;
        }
      } else {
        // Bulk status change
        const response = await fetch("/api/admin/questions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids, status: bulkAction }),
        });

        if (!response.ok) {
          const error = await response.json();
          alert(error.error || "Failed to update questions");
          return;
        }
      }

      setSelectedIds(new Set());
      setBulkAction("");
      setRefreshNonce((n) => n + 1);
    } catch (error) {
      console.error("Bulk action failed:", error);
      alert("Failed to perform bulk action");
    }
  };

  const handleResetFilters = () => {
    setSearch("");
    setExamId("");
    setExamYear("");
    setSubjectId("");
    setTopicId("");
    setDifficulty("");
    setStatus("");
    setSource("");
    setIsPyq("");
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-foreground)]">All Questions</h2>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            The central Question Bank consumed by Mock Tests, Custom Modules, and Previous Year Papers.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/admin/questions/bulk-import">Bulk Import</Link>
          </Button>
          <Button asChild>
            <Link href="/admin/questions?tab=add">Add Question</Link>
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-5">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="relative lg:col-span-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-muted-foreground)]" />
              <Input
                placeholder="Search by text or code..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="pl-9"
              />
            </div>

            <select
              value={examId}
              onChange={(e) => {
                setExamId(e.target.value);
                setSubjectId("");
                setTopicId("");
                setPage(1);
              }}
              className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            >
              <option value="">All exams</option>
              {filterOptions.exams.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>

            <Input
              type="number"
              placeholder="Year"
              value={examYear}
              onChange={(e) => {
                setExamYear(e.target.value);
                setPage(1);
              }}
            />

            <select
              value={subjectId}
              onChange={(e) => {
                setSubjectId(e.target.value);
                setTopicId("");
                setPage(1);
              }}
              className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            >
              <option value="">All subjects</option>
              {filterOptions.subjects
                .filter((s) => !examId || s.examId === examId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>

            <select
              value={topicId}
              onChange={(e) => {
                setTopicId(e.target.value);
                setPage(1);
              }}
              className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            >
              <option value="">All topics</option>
              {filterOptions.topics
                .filter((t) => !subjectId || t.subjectId === subjectId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>

            <select
              value={difficulty}
              onChange={(e) => {
                setDifficulty(e.target.value);
                setPage(1);
              }}
              className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            >
              <option value="">All difficulties</option>
              <option value="EASY">Easy</option>
              <option value="MEDIUM">Medium</option>
              <option value="HARD">Hard</option>
            </select>

            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            >
              <option value="">All statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="PUBLISHED">Published</option>
              <option value="ARCHIVED">Archived</option>
            </select>

            <select
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setPage(1);
              }}
              className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            >
              <option value="">All sources</option>
              <option value="QUESTION_BANK">Question Bank</option>
              <option value="PYQ">Previous Year Paper</option>
            </select>

            <select
              value={isPyq}
              onChange={(e) => {
                setIsPyq(e.target.value);
                setPage(1);
              }}
              className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            >
              <option value="">All questions</option>
              <option value="true">PYQ only</option>
              <option value="false">Non-PYQ only</option>
            </select>

            <Button onClick={handleResetFilters} variant="outline" size="sm">
              Reset Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Bulk Actions */}
      {selectedIds.size > 0 && (
        <Card>
          <CardContent className="flex items-center gap-3 pt-5">
            <span className="text-sm font-medium">{selectedIds.size} selected</span>
            <select
              value={bulkAction}
              onChange={(e) => setBulkAction(e.target.value)}
              className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            >
              <option value="">Select action...</option>
              <option value="DRAFT">Set to Draft</option>
              <option value="PUBLISHED">Set to Published</option>
              <option value="ARCHIVED">Set to Archived</option>
              <option value="delete">Delete</option>
            </select>
            <Button onClick={handleBulkAction} disabled={!bulkAction} size="sm">
              Apply
            </Button>
            <Button onClick={() => setSelectedIds(new Set())} variant="outline" size="sm">
              Clear Selection
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Questions Table */}
      <Card>
        <CardHeader>
          <CardTitle>Questions</CardTitle>
          <CardDescription>
            {isLoading ? "Loading..." : `${total} total questions • Page ${page} of ${totalPages}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {questions.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
              {isLoading ? "Loading questions..." : "No questions match these filters."}
            </p>
          ) : (
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">
                    <Checkbox
                      checked={selectedIds.size === questions.length && questions.length > 0}
                      onCheckedChange={handleSelectAll}
                    />
                  </th>
                  <th className="py-2 pr-4">Code</th>
                  <th className="py-2 pr-4">Question</th>
                  <th className="py-2 pr-4">Exam / Subject</th>
                  <th className="py-2 pr-4">Year</th>
                  <th className="py-2 pr-4">Difficulty</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {questions.map((q) => (
                  <tr key={q.id} className="border-b border-[var(--color-border)] last:border-0 align-top">
                    <td className="py-2.5 pr-4">
                      <Checkbox
                        checked={selectedIds.has(q.id)}
                        onCheckedChange={() => handleToggleSelect(q.id)}
                      />
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-muted-foreground)]">{q.code}</td>
                    <td className="max-w-xs py-2.5 pr-4 text-[var(--color-foreground)]">{q.text.slice(0, 90)}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                      {q.exam.name}
                      <br />
                      <span className="text-xs">
                        {q.subject.name}
                        {q.topic ? ` · ${q.topic.name}` : ""}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                      {q.examYear || "—"}
                      {q.previousYearPaper && (
                        <Badge variant="neutral" className="ml-1 text-xs">
                          PYQ
                        </Badge>
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={DIFFICULTY_VARIANT[q.difficulty]}>{q.difficulty}</Badge>
                    </td>
                    <td className="py-2.5 pr-4">
                      <StatusSelect questionId={q.id} status={q.status} />
                    </td>
                    <td className="py-2.5 pr-4">
                      <Link
                        href={`/admin/questions?tab=add&id=${q.id}`}
                        className="text-[var(--color-primary)] hover:underline"
                      >
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--color-border)]">
              <p className="text-sm text-[var(--color-muted-foreground)]">
                Showing {(page - 1) * LIMIT + 1}-{Math.min(page * LIMIT, total)} of {total}
              </p>
              <div className="flex gap-2">
                <Button onClick={() => setPage(page - 1)} disabled={page === 1} variant="outline" size="sm">
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <Button onClick={() => setPage(page + 1)} disabled={page >= totalPages} variant="outline" size="sm">
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
