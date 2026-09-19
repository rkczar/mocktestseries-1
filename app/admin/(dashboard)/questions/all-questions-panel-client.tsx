"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusSelect } from "./status-select";
import { Search, ChevronLeft, ChevronRight, ImageIcon } from "lucide-react";

const DIFFICULTY_VARIANT = { EASY: "success", MEDIUM: "warning", HARD: "error" } as const;
const LIMIT = 50;

const OPTION_LABELS = ["A", "B", "C", "D"] as const;

interface QuestionOptionRow {
  id: string;
  label: string;
  text: string;
  imageUrl: string | null;
  isCorrect: boolean;
}

interface Question {
  id: string;
  code: string;
  text: string;
  imageUrl: string | null;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  examYear: number | null;
  source: string;
  reviewRequired: boolean;
  createdAt: string;
  exam: { id: string; name: string };
  subject: { id: string; name: string };
  topic: { id: string; name: string } | null;
  subTopic: { id: string; name: string } | null;
  previousYearPaper: { id: string; year: number; title: string } | null;
  importBatch: { id: string; label: string | null; filename: string; createdAt: string } | null;
  options: QuestionOptionRow[];
}

interface FilterOptions {
  exams: { id: string; name: string }[];
  subjects: { id: string; name: string; examId: string }[];
  topics: { id: string; name: string; subjectId: string }[];
  subTopics: { id: string; name: string; topicId: string }[];
  importBatches: { id: string; label: string; createdAt: string }[];
}

/** Compact "Q+A+C" style indicator of which parts of a question carry an image. */
function ImageIndicator({ question }: { question: Question }) {
  const parts: string[] = [];
  if (question.imageUrl) parts.push("Q");
  for (const label of OPTION_LABELS) {
    if (question.options.find((o) => o.label === label)?.imageUrl) parts.push(label);
  }
  if (parts.length === 0) {
    return <span className="text-xs text-[var(--color-muted-foreground)]">—</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-foreground)]" title={`Has image: ${parts.join(", ")}`}>
      <ImageIcon className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden />
      {parts.join("+")}
    </span>
  );
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
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState(initialFilters.search || "");
  const [examId, setExamId] = useState(initialFilters.examId || "");
  const [examYear, setExamYear] = useState(initialFilters.examYear || "");
  const [subjectId, setSubjectId] = useState(initialFilters.subjectId || "");
  const [topicId, setTopicId] = useState(initialFilters.topicId || "");
  const [subTopicId, setSubTopicId] = useState(initialFilters.subTopicId || "");
  const [difficulty, setDifficulty] = useState(initialFilters.difficulty || "");
  const [status, setStatus] = useState(initialFilters.status || "");
  const [source, setSource] = useState(initialFilters.source || "");
  const [isPyq, setIsPyq] = useState(initialFilters.isPyq || "");
  const [hasImage, setHasImage] = useState(initialFilters.hasImage || "");
  const [reviewRequired, setReviewRequired] = useState(initialFilters.reviewRequired || "");
  const [importBatchId, setImportBatchId] = useState(initialFilters.importBatchId || "");
  const [importedFrom, setImportedFrom] = useState(initialFilters.importedFrom || "");
  const [importedTo, setImportedTo] = useState(initialFilters.importedTo || "");

  const totalPages = Math.ceil(total / LIMIT);

  // Encodes every value the fetch depends on, including the manual-refresh
  // nonce. Comparing this against `loadedKey` (set once a fetch resolves)
  // derives `isLoading` during render, so no effect ever needs to call
  // setState synchronously before its first await.
  const fetchKey = useMemo(
    () =>
      JSON.stringify({
        page,
        search,
        examId,
        examYear,
        subjectId,
        topicId,
        subTopicId,
        difficulty,
        status,
        source,
        isPyq,
        hasImage,
        reviewRequired,
        importBatchId,
        importedFrom,
        importedTo,
        refreshNonce,
      }),
    [
      page,
      search,
      examId,
      examYear,
      subjectId,
      topicId,
      subTopicId,
      difficulty,
      status,
      source,
      isPyq,
      hasImage,
      reviewRequired,
      importBatchId,
      importedFrom,
      importedTo,
      refreshNonce,
    ]
  );
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const isLoading = loadedKey !== fetchKey;

  function buildParams(f: Record<string, string | number>) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(f)) {
      if (value !== "" && value !== undefined && value !== null) params.set(key, String(value));
    }
    return params;
  }

  useEffect(() => {
    const f = JSON.parse(fetchKey) as Record<string, string | number>;
    let cancelled = false;
    const pageValue = f.page;
    delete (f as Record<string, unknown>).refreshNonce;
    delete (f as Record<string, unknown>).page;
    const params = buildParams(f);
    params.set("page", String(pageValue));
    params.set("limit", String(LIMIT));

    fetch(`/api/admin/questions?${params}`)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        setQuestions(data.questions ?? []);
        setTotal(data.pagination?.total ?? 0);
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

  /** Selects every question matching the current filters, not just the loaded page. */
  const handleSelectAllFiltered = async () => {
    const f = JSON.parse(fetchKey) as Record<string, string | number>;
    delete (f as Record<string, unknown>).refreshNonce;
    delete (f as Record<string, unknown>).page;
    const params = buildParams(f);
    params.set("idsOnly", "true");
    try {
      const res = await fetch(`/api/admin/questions?${params}`);
      const data = await res.json();
      setSelectedIds(new Set<string>(data.ids ?? []));
      if (data.truncated) {
        setBulkMessage("Selected the first 5000 matching questions (the filter matches more).");
      }
    } catch {
      alert("Failed to select all filtered questions");
    }
  };

  const handleBulkAction = async () => {
    if (selectedIds.size === 0 || !bulkAction) return;
    const ids = Array.from(selectedIds);

    if (bulkAction === "DELETE" && !confirm(`Delete ${ids.length} question(s)? Questions referenced by test attempts, saved bookmarks, or reports will be archived instead of deleted.`)) {
      return;
    }
    if (bulkAction === "SET_REVIEW_REQUIRED" && !confirm(`Flag ${ids.length} question(s) as needing manual review?`)) {
      return;
    }

    setBulkBusy(true);
    setBulkMessage(null);
    try {
      const response = await fetch("/api/admin/questions/bulk-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: bulkAction, ids }),
      });
      const data = await response.json();

      if (!response.ok) {
        alert(data.error || "Failed to perform bulk action");
        return;
      }

      setBulkMessage(data.message || `Done: ${bulkAction} applied to ${ids.length} question(s).`);
      setSelectedIds(new Set());
      setBulkAction("");
      setRefreshNonce((n) => n + 1);
    } catch (error) {
      console.error("Bulk action failed:", error);
      alert("Failed to perform bulk action");
    } finally {
      setBulkBusy(false);
    }
  };

  const handleResetFilters = () => {
    setSearch("");
    setExamId("");
    setExamYear("");
    setSubjectId("");
    setTopicId("");
    setSubTopicId("");
    setDifficulty("");
    setStatus("");
    setSource("");
    setIsPyq("");
    setHasImage("");
    setReviewRequired("");
    setImportBatchId("");
    setImportedFrom("");
    setImportedTo("");
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
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            <div className="relative lg:col-span-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-muted-foreground)]" />
              <Input
                placeholder="Search by text, or exact/prefix code..."
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
                setSubTopicId("");
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
                setSubTopicId("");
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
                setSubTopicId("");
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
              value={subTopicId}
              onChange={(e) => {
                setSubTopicId(e.target.value);
                setPage(1);
              }}
              className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            >
              <option value="">All sub-topics</option>
              {filterOptions.subTopics
                .filter((st) => !topicId || st.topicId === topicId)
                .map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
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

            <select
              value={hasImage}
              onChange={(e) => {
                setHasImage(e.target.value);
                setPage(1);
              }}
              className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            >
              <option value="">Has image: any</option>
              <option value="true">Has an image</option>
              <option value="false">No image</option>
            </select>

            <select
              value={reviewRequired}
              onChange={(e) => {
                setReviewRequired(e.target.value);
                setPage(1);
              }}
              className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            >
              <option value="">Review: any</option>
              <option value="true">Needs review</option>
              <option value="false">Not flagged</option>
            </select>

            <select
              value={importBatchId}
              onChange={(e) => {
                setImportBatchId(e.target.value);
                setPage(1);
              }}
              className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm lg:col-span-2"
            >
              <option value="">All import batches</option>
              {filterOptions.importBatches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label} — {new Date(b.createdAt).toLocaleDateString()}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-1.5">
              <Input
                type="date"
                aria-label="Imported/created from"
                value={importedFrom}
                onChange={(e) => {
                  setImportedFrom(e.target.value);
                  setPage(1);
                }}
              />
              <span className="text-xs text-[var(--color-muted-foreground)]">to</span>
              <Input
                type="date"
                aria-label="Imported/created to"
                value={importedTo}
                onChange={(e) => {
                  setImportedTo(e.target.value);
                  setPage(1);
                }}
              />
            </div>

            <Button onClick={handleResetFilters} variant="outline" size="sm">
              Reset Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Bulk Actions */}
      {(selectedIds.size > 0 || bulkMessage) && (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium">{selectedIds.size} selected</span>
              <Button onClick={handleSelectAllFiltered} variant="outline" size="sm">
                Select All Filtered ({total})
              </Button>
              <select
                value={bulkAction}
                onChange={(e) => setBulkAction(e.target.value)}
                disabled={selectedIds.size === 0}
                className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
              >
                <option value="">Select action...</option>
                <option value="PUBLISH">Publish</option>
                <option value="DRAFT">Move to Draft</option>
                <option value="ARCHIVE">Archive</option>
                <option value="SET_REVIEW_REQUIRED">Set Review Required</option>
                <option value="DELETE">Delete</option>
              </select>
              <Button onClick={handleBulkAction} disabled={!bulkAction || selectedIds.size === 0 || bulkBusy} size="sm">
                {bulkBusy ? "Applying…" : "Apply"}
              </Button>
              <Button onClick={() => setSelectedIds(new Set())} variant="outline" size="sm">
                Clear Selection
              </Button>
            </div>
            {bulkMessage ? <p className="text-sm text-[var(--color-muted-foreground)]">{bulkMessage}</p> : null}
          </CardContent>
        </Card>
      )}

      {/* Questions Table */}
      <Card>
        <CardHeader>
          <CardTitle>Questions</CardTitle>
          <CardDescription>
            {isLoading ? "Loading..." : `${total} total questions • Page ${page} of ${totalPages || 1}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {questions.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
              {isLoading ? "Loading questions..." : "No questions match these filters."}
            </p>
          ) : (
            <table className="w-full min-w-[1000px] text-left text-sm">
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
                  <th className="py-2 pr-4">Image</th>
                  <th className="py-2 pr-4">Difficulty</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Review</th>
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
                        {q.subTopic ? ` · ${q.subTopic.name}` : ""}
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
                      <ImageIndicator question={q} />
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={DIFFICULTY_VARIANT[q.difficulty]}>{q.difficulty}</Badge>
                    </td>
                    <td className="py-2.5 pr-4">
                      <StatusSelect questionId={q.id} status={q.status} />
                    </td>
                    <td className="py-2.5 pr-4">
                      {q.reviewRequired ? <Badge variant="warning">Review</Badge> : null}
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
