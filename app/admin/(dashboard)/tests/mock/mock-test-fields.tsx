"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";

export interface CoverageSubject {
  id: string;
  name: string;
  topics: { id: string; name: string }[];
}

export interface MockTestFieldValues {
  title?: string;
  order?: number | null;
  description?: string | null;
  durationMinutes?: number;
  negativeMarking?: number;
  instructions?: string | null;
  accessType?: "FREE" | "PAID";
  targetQuestionCount?: number | null;
  coverageType?: "FULL_SYLLABUS" | "PARTIAL_SYLLABUS" | "SUBJECT_WISE";
  coverageSubjectIds?: string[];
  coverageTopicIds?: string[];
}

const textareaClass =
  "w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]";

/**
 * Shared Mock Test fields (create + edit): Test Number, title, duration,
 * marking, FREE/PAID, target question count, description, instructions, and
 * syllabus coverage picked from the exam's real Subject/Topic taxonomy.
 */
export function MockTestFields({ v = {}, subjects }: { v?: MockTestFieldValues; subjects: CoverageSubject[] }) {
  const [coverageType, setCoverageType] = useState(v.coverageType ?? "FULL_SYLLABUS");
  const [pickedSubjects, setPickedSubjects] = useState<Set<string>>(new Set(v.coverageSubjectIds ?? []));
  const pickedTopics = new Set(v.coverageTopicIds ?? []);

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="order">Test Number</Label>
        <Input id="order" name="order" type="number" min={0} defaultValue={v.order ?? ""} placeholder="Auto (next number)" />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" required defaultValue={v.title} placeholder="RUHS MO Mock Test 1" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="durationMinutes">Duration (minutes)</Label>
        <Input id="durationMinutes" name="durationMinutes" type="number" min={1} required defaultValue={v.durationMinutes ?? 120} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="negativeMarking">Negative marking (per wrong answer)</Label>
        <Input id="negativeMarking" name="negativeMarking" type="number" step="0.05" min={0} max={1} defaultValue={v.negativeMarking ?? 0} />
        <p className="text-[11px] text-[var(--color-muted-foreground)]">Each correct answer scores 1 mark; total marks = number of questions.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="accessType">Access</Label>
        <SelectNative id="accessType" name="accessType" defaultValue={v.accessType ?? "PAID"}>
          <option value="FREE">FREE — anyone signed in</option>
          <option value="PAID">PAID — Complete Series entitlement</option>
        </SelectNative>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="targetQuestionCount">Target question count</Label>
        <Input id="targetQuestionCount" name="targetQuestionCount" type="number" min={0} defaultValue={v.targetQuestionCount ?? ""} placeholder="e.g. 100" />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
        <Label htmlFor="description">Description (shown on public/student cards)</Label>
        <Input id="description" name="description" defaultValue={v.description ?? ""} />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
        <Label htmlFor="instructions">Instructions</Label>
        <textarea id="instructions" name="instructions" rows={2} defaultValue={v.instructions ?? ""} className={textareaClass} />
      </div>

      <fieldset className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-4 sm:col-span-2 lg:col-span-3">
        <legend className="px-1 text-sm font-medium text-[var(--color-foreground)]">Syllabus coverage</legend>
        <SelectNative
          name="coverageType"
          value={coverageType}
          onChange={(e) => setCoverageType(e.target.value as typeof coverageType)}
          className="max-w-xs"
          aria-label="Coverage type"
        >
          <option value="FULL_SYLLABUS">Full Syllabus</option>
          <option value="PARTIAL_SYLLABUS">Partial Syllabus</option>
          <option value="SUBJECT_WISE">Subject-wise</option>
        </SelectNative>
        {coverageType === "FULL_SYLLABUS" ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">Students see “Full Syllabus”. No subject selection needed.</p>
        ) : subjects.length === 0 ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">This exam has no subjects yet (Admin → Exams → Subjects).</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {subjects.map((s) => (
              <div key={s.id} className="rounded-[var(--radius-button)] border border-[var(--color-border)] p-2">
                <label className="flex items-center gap-2 text-sm font-medium text-[var(--color-foreground)]">
                  <input
                    type="checkbox"
                    name="coverageSubjectIds"
                    value={s.id}
                    defaultChecked={pickedSubjects.has(s.id)}
                    onChange={(e) =>
                      setPickedSubjects((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(s.id);
                        else next.delete(s.id);
                        return next;
                      })
                    }
                  />
                  {s.name}
                </label>
                {s.topics.length > 0 ? (
                  <details className="mt-1" open={s.topics.some((t) => pickedTopics.has(t.id))}>
                    <summary className="cursor-pointer text-[11px] text-[var(--color-muted-foreground)]">Specific topics ({s.topics.length})</summary>
                    <div className="mt-1 flex flex-col gap-1 pl-5">
                      {s.topics.map((t) => (
                        <label key={t.id} className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
                          <input type="checkbox" name="coverageTopicIds" value={t.id} defaultChecked={pickedTopics.has(t.id)} />
                          {t.name}
                        </label>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </fieldset>
    </>
  );
}
