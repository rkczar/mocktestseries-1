"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Checkbox } from "@/components/ui/checkbox";
import { ImageUploadField } from "./image-upload-field";
import { createQuestionAction, updateQuestionAction, type QuestionFormState } from "./actions";

export interface ExamTree {
  id: string;
  name: string;
  subjects: {
    id: string;
    name: string;
    topics: { id: string; name: string; subTopics: { id: string; name: string }[] }[];
  }[];
  previousYearPapers: { id: string; title: string; year: number }[];
}

export interface QuestionDefaults {
  id: string;
  examId: string;
  examYear: number | null;
  subjectId: string;
  topicId: string | null;
  subTopicId: string | null;
  previousYearPaperId: string | null;
  source: "QUESTION_BANK" | "PYQ";
  text: string;
  imageUrl: string | null;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  reviewRequired?: boolean;
  reviewReason?: string | null;
  options: { label: string; text: string; imageUrl?: string | null; isCorrect: boolean }[];
}

function SubmitButton({ editing }: { editing: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : editing ? "Save Changes" : "Create Question"}
    </Button>
  );
}

export function QuestionForm({ exams, defaults }: { exams: ExamTree[]; defaults?: QuestionDefaults }) {
  const action = defaults ? updateQuestionAction.bind(null, defaults.id) : createQuestionAction;
  const [state, formAction] = useActionState<QuestionFormState, FormData>(action, {});

  const [examId, setExamId] = useState(defaults?.examId ?? exams[0]?.id ?? "");
  const [subjectId, setSubjectId] = useState(defaults?.subjectId ?? "");
  const [topicId, setTopicId] = useState(defaults?.topicId ?? "");

  const exam = useMemo(() => exams.find((e) => e.id === examId), [exams, examId]);
  const subjects = useMemo(() => exam?.subjects ?? [], [exam]);
  const subject = useMemo(() => subjects.find((s) => s.id === subjectId), [subjects, subjectId]);
  const topics = useMemo(() => subject?.topics ?? [], [subject]);
  const topic = useMemo(() => topics.find((t) => t.id === topicId), [topics, topicId]);
  const subTopics = topic?.subTopics ?? [];
  const papers = exam?.previousYearPapers ?? [];

  const optionText = (label: string) => defaults?.options.find((o) => o.label === label)?.text ?? "";
  const optionImageUrl = (label: string) => defaults?.options.find((o) => o.label === label)?.imageUrl ?? null;
  const correctLabel = defaults?.options.find((o) => o.isCorrect)?.label ?? "A";
  const [reviewRequired, setReviewRequired] = useState(defaults?.reviewRequired ?? false);

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="examId">Exam</Label>
          <SelectNative
            id="examId"
            name="examId"
            value={examId}
            onChange={(e) => {
              setExamId(e.target.value);
              setSubjectId("");
              setTopicId("");
            }}
            required
          >
            <option value="" disabled>
              Select exam
            </option>
            {exams.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </SelectNative>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="examYear">Exam Year</Label>
          <Input
            id="examYear"
            name="examYear"
            type="number"
            min="2000"
            max="2099"
            defaultValue={defaults?.examYear ?? ""}
            placeholder="e.g., 2024"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="subjectId">Subject</Label>
          <SelectNative
            id="subjectId"
            name="subjectId"
            value={subjectId}
            onChange={(e) => {
              setSubjectId(e.target.value);
              setTopicId("");
            }}
            required
          >
            <option value="" disabled>
              Select subject
            </option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectNative>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="topicId">Topic (optional)</Label>
          <SelectNative id="topicId" name="topicId" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
            <option value="">No topic</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </SelectNative>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="subTopicId">Sub-topic (optional)</Label>
          <SelectNative id="subTopicId" name="subTopicId" defaultValue={defaults?.subTopicId ?? ""}>
            <option value="">No sub-topic</option>
            {subTopics.map((st) => (
              <option key={st.id} value={st.id}>
                {st.name}
              </option>
            ))}
          </SelectNative>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="source">Source</Label>
          <SelectNative id="source" name="source" defaultValue={defaults?.source ?? "QUESTION_BANK"}>
            <option value="QUESTION_BANK">Question Bank</option>
            <option value="PYQ">Previous Year Paper</option>
          </SelectNative>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="previousYearPaperId">Previous Year Paper (optional)</Label>
          <SelectNative id="previousYearPaperId" name="previousYearPaperId" defaultValue={defaults?.previousYearPaperId ?? ""}>
            <option value="">Not a PYQ</option>
            {papers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.year} — {p.title}
              </option>
            ))}
          </SelectNative>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="difficulty">Difficulty</Label>
          <SelectNative id="difficulty" name="difficulty" defaultValue={defaults?.difficulty ?? "MEDIUM"}>
            <option value="EASY">Easy</option>
            <option value="MEDIUM">Medium</option>
            <option value="HARD">Hard</option>
          </SelectNative>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="text">Question Text</Label>
        <textarea
          id="text"
          name="text"
          required
          defaultValue={defaults?.text}
          rows={3}
          className="w-full rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
        />
      </div>

      <ImageUploadField
        label="Question Image (optional)"
        name="imageUrl"
        target="question"
        questionId={defaults?.id}
        defaultUrl={defaults?.imageUrl}
      />

      <div className="flex flex-col gap-4">
        <Label>Options — mark the correct answer (each option needs text, an image, or both)</Label>
        {(["A", "B", "C", "D"] as const).map((label) => (
          <div
            key={label}
            className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 sm:flex-row sm:items-start"
          >
            <div className="flex items-center gap-3 sm:pt-2.5">
              <input
                type="radio"
                name="correctOption"
                value={label}
                defaultChecked={correctLabel === label}
                required
                className="h-4 w-4"
                aria-label={`Option ${label} is correct`}
              />
              <span className="w-6 shrink-0 text-sm font-medium text-[var(--color-muted-foreground)]">{label}</span>
            </div>
            <div className="flex-1">
              <Input name={`option${label}`} defaultValue={optionText(label)} placeholder={`Option ${label} text (optional if image provided)`} />
            </div>
            <div className="sm:w-64">
              <ImageUploadField
                label={`Option ${label} image`}
                name={`option${label}ImageUrl`}
                target={label}
                questionId={defaults?.id}
                defaultUrl={optionImageUrl(label)}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="status">Status</Label>
          <SelectNative id="status" name="status" defaultValue={defaults?.status ?? "DRAFT"}>
            <option value="DRAFT">Draft</option>
            <option value="PUBLISHED">Published</option>
            <option value="ARCHIVED">Archived</option>
          </SelectNative>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="flex items-center gap-2">
            <Checkbox
              name="reviewRequired"
              checked={reviewRequired}
              onCheckedChange={(checked) => setReviewRequired(checked === true)}
            />
            Needs manual review
          </Label>
          {reviewRequired ? (
            <Input
              name="reviewReason"
              defaultValue={defaults?.reviewReason ?? ""}
              placeholder="Why does this question need review?"
            />
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <SubmitButton editing={Boolean(defaults)} />
        {state.error ? <p className="text-sm text-[var(--color-error)]">{state.error}</p> : null}
        {state.success ? <p className="text-sm text-[var(--color-success)]">Saved.</p> : null}
      </div>
    </form>
  );
}
