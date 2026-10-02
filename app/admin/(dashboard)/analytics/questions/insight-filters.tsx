"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarRange, Loader2, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { cn } from "@/lib/utils";
import type { InsightFilters } from "@/lib/question-insights";

type Option = { id: string; name: string };

const PRESETS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "custom", label: "Custom" },
] as const;

const TEST_TYPES = [
  { value: "FULL_MOCK", label: "Mock Test" },
  { value: "PREVIOUS_YEAR_PAPER", label: "Previous Year Paper" },
  { value: "SUBJECT_TEST", label: "Subject Test" },
  { value: "CUSTOM_MODULE", label: "Custom Module" },
  { value: "GRAND_TEST", label: "Grand Test" },
  { value: "LIVE_TEST", label: "Live Test" },
];

const SORT_LABELS = {
  wrong: "Most Wrong (count)",
  wrongPct: "Highest Wrong %",
  attempts: "Most Attempted",
  reports: "Most Reported",
  saves: "Most Saved",
} as const;

// Field names here must match parseInsightFilters (lib/question-insights.ts).
type FilterKey = "examId" | "subjectId" | "topicId" | "subTopicId" | "testType" | "source" | "difficulty" | "status" | "min" | "sort";

export function InsightFiltersBar({
  filters,
  options,
  rangeLabel,
  rangeError,
}: {
  filters: InsightFilters;
  options: { exams: Option[]; subjects: Option[]; topics: Option[]; subTopics: Option[] };
  rangeLabel: string;
  rangeError?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [customFrom, setCustomFrom] = useState(filters.from ?? "");
  const [customTo, setCustomTo] = useState(filters.to ?? "");
  const [showCustom, setShowCustom] = useState(filters.range === "custom");

  function navigate(changes: Record<string, string | undefined>) {
    const params = new URLSearchParams();
    const current: Record<string, string | undefined> = {
      tab: filters.tab,
      range: filters.range,
      from: filters.from,
      to: filters.to,
      examId: filters.examId,
      subjectId: filters.subjectId,
      topicId: filters.topicId,
      subTopicId: filters.subTopicId,
      testType: filters.testType,
      source: filters.source,
      difficulty: filters.difficulty,
      status: filters.status,
      min: String(filters.min),
      sort: filters.sort,
    };
    const next = { ...current, ...changes };
    if (next.range !== "custom") {
      delete next.from;
      delete next.to;
    }
    for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
    startTransition(() => router.push(`/admin/analytics/questions?${params.toString()}`, { scroll: false }));
  }

  function setFilter(key: FilterKey, value: string) {
    const v = value || undefined;
    // Changing a parent level clears its children so a stale topic can't silently empty the results.
    if (key === "examId") return navigate({ examId: v, subjectId: undefined, topicId: undefined, subTopicId: undefined });
    if (key === "subjectId") return navigate({ subjectId: v, topicId: undefined, subTopicId: undefined });
    if (key === "topicId") return navigate({ topicId: v, subTopicId: undefined });
    navigate({ [key]: v });
  }

  const activeCount = [filters.examId, filters.subjectId, filters.topicId, filters.subTopicId, filters.testType, filters.source, filters.difficulty, filters.status].filter(Boolean).length;
  const answerTab = filters.tab === "wrong" || filters.tab === "attempted";

  const select = (label: string, key: FilterKey, value: string | undefined, items: { value: string; label: string }[], allLabel = "All", disabled = false) => (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-[var(--color-muted-foreground)]">
      {label}
      <SelectNative value={value ?? ""} onChange={(e) => setFilter(key, e.target.value)} disabled={disabled || pending} className="h-9">
        {allLabel !== "" && <option value="">{allLabel}</option>}
        {items.map((i) => (
          <option key={i.value} value={i.value}>
            {i.label}
          </option>
        ))}
      </SelectNative>
    </label>
  );

  const toItems = (list: Option[]) => list.map((o) => ({ value: o.id, label: o.name }));

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => {
            const active = p.value === "custom" ? showCustom : !showCustom && filters.range === p.value;
            return (
              <Button
                key={p.value}
                type="button"
                size="sm"
                variant={active ? "primary" : "outline"}
                disabled={pending}
                onClick={() => {
                  if (p.value === "custom") return setShowCustom(true);
                  setShowCustom(false);
                  navigate({ range: p.value });
                }}
              >
                {p.label}
              </Button>
            );
          })}
          {pending && <Loader2 className="h-4 w-4 animate-spin text-[var(--color-muted-foreground)]" aria-label="Loading" />}
        </div>

        {showCustom && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              navigate({ range: "custom", from: customFrom, to: customTo });
            }}
          >
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-muted-foreground)]">
              From (IST)
              <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} required className="h-9 w-40" />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-muted-foreground)]">
              To (IST)
              <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} required className="h-9 w-40" />
            </label>
            <Button type="submit" size="sm" disabled={pending}>
              Apply
            </Button>
          </form>
        )}

        <p className="flex items-start gap-1.5 text-xs text-[var(--color-muted-foreground)]">
          <CalendarRange className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            <span className="font-medium text-[var(--color-foreground)]">Showing:</span> {rangeLabel}
            {answerTab && " · counted by attempt submission time"}
          </span>
        </p>
        {rangeError && <p className="text-xs font-medium text-[var(--color-error)]">{rangeError} Showing today instead.</p>}

        <details className="group" open={activeCount > 0}>
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-[var(--color-foreground)]">
            <SlidersHorizontal className="h-4 w-4" aria-hidden />
            Filters{activeCount > 0 ? ` (${activeCount} active)` : ""}
            {activeCount > 0 && (
              <button
                type="button"
                className="ml-2 text-xs font-normal text-[var(--color-primary)] hover:underline"
                onClick={(e) => {
                  e.preventDefault();
                  navigate({ examId: undefined, subjectId: undefined, topicId: undefined, subTopicId: undefined, testType: undefined, source: undefined, difficulty: undefined, status: undefined });
                }}
              >
                Clear all
              </button>
            )}
          </summary>
          <div className={cn("mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4")}>
            {select("Exam", "examId", filters.examId, toItems(options.exams))}
            {select("Subject", "subjectId", filters.subjectId, toItems(options.subjects))}
            {select("Topic", "topicId", filters.topicId, toItems(options.topics), filters.subjectId ? "All" : "Pick a subject first", !filters.subjectId)}
            {select("Sub-topic", "subTopicId", filters.subTopicId, toItems(options.subTopics), filters.topicId ? "All" : "Pick a topic first", !filters.topicId)}
            {answerTab && select("Test type", "testType", filters.testType, TEST_TYPES)}
            {select("Question source", "source", filters.source, [
              { value: "QUESTION_BANK", label: "Question Bank" },
              { value: "PYQ", label: "Previous Year (PYQ)" },
            ])}
            {select("Difficulty", "difficulty", filters.difficulty, [
              { value: "EASY", label: "Easy" },
              { value: "MEDIUM", label: "Medium" },
              { value: "HARD", label: "Hard" },
            ])}
            {select("Question status", "status", filters.status, [
              { value: "PUBLISHED", label: "Published" },
              { value: "DRAFT", label: "Draft" },
              { value: "ARCHIVED", label: "Archived" },
            ])}
          </div>
        </details>

        {answerTab && (
          <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
            {select(
              "Minimum attempts",
              "min",
              String(filters.min),
              [
                { value: "1", label: "All" },
                { value: "5", label: "5+" },
                { value: "10", label: "10+" },
                { value: "20", label: "20+" },
                { value: "50", label: "50+" },
              ],
              ""
            )}
            {select(
              "Sort by",
              "sort",
              filters.sort,
              Object.entries(SORT_LABELS).map(([value, label]) => ({ value, label })),
              ""
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
