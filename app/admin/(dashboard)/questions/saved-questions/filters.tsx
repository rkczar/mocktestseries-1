"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ExamFilterSelect } from "@/components/admin/exam-filter-select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function SavedQuestionsFilters({
  exams,
  subjects,
  examId,
  subjectId,
  search,
}: {
  exams: { id: string; name: string }[];
  subjects: { id: string; name: string }[];
  examId?: string;
  subjectId?: string;
  search?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [searchValue, setSearchValue] = useState(search ?? "");

  const applySearch = () => {
    const params = new URLSearchParams(searchParams.toString());
    if (searchValue) params.set("search", searchValue);
    else params.delete("search");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-[var(--color-muted-foreground)]">Exam</label>
        <ExamFilterSelect options={exams} paramName="examId" value={examId} clearParams={["subjectId"]} allowAll allLabel="All Exams" className="w-56" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-[var(--color-muted-foreground)]">Subject</label>
        <ExamFilterSelect options={subjects} paramName="subjectId" value={subjectId} allowAll allLabel="All Subjects" disabled={!examId} className="w-56" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-[var(--color-muted-foreground)]">Question code or text</label>
        <div className="flex gap-2">
          <Input
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applySearch()}
            placeholder="Search…"
            className="w-56"
          />
          <Button type="button" size="sm" variant="outline" onClick={applySearch}>
            Search
          </Button>
        </div>
      </div>
    </div>
  );
}
