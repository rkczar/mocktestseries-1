import { Bookmark } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getSavedQuestions } from "@/lib/student-data";
import { Card, CardContent } from "@/components/ui/card";
import { BackButton } from "@/components/student/back-button";
import { SaveQuestionButton } from "@/components/student/save-question-button";
import { ReportQuestionDialog } from "@/components/student/report-question-dialog";
import { unsaveQuestionAction, reportSavedQuestionAction } from "./actions";

export const metadata = { title: "Saved Questions — Mock Test Series.in" };

export default async function SavedQuestionsPage() {
  const student = await requireStudent();
  const saved = await getSavedQuestions(student.id);

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Saved Questions</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Questions you bookmarked for later review.</p>
      </div>

      {saved.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <Bookmark className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
            <p className="text-sm text-[var(--color-muted-foreground)]">No saved questions yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {saved.map(({ question: q }) => (
            <div key={q.id} className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  {q.exam.name} {q.subject ? `· ${q.subject.name}` : ""} {q.topic ? `· ${q.topic.name}` : ""}
                </span>
                <span className="font-mono text-xs text-[var(--color-muted-foreground)]">{q.code}</span>
              </div>

              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-[var(--color-foreground)]">{q.text}</p>
              {q.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={q.imageUrl}
                  alt=""
                  className="mt-3 max-h-72 rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain"
                />
              ) : null}

              <div className="mt-4 flex flex-col gap-2">
                {q.options.map((opt) => (
                  <div
                    key={opt.label}
                    className={
                      opt.isCorrect
                        ? "rounded-[var(--radius-card)] border border-[var(--color-success)] bg-[var(--color-success)]/10 p-3 text-sm"
                        : "rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm"
                    }
                  >
                    <span className="font-semibold">{opt.label}.</span> {opt.text}
                    {opt.isCorrect ? <span className="ml-2 text-xs font-medium text-[var(--color-success)]">Correct answer</span> : null}
                  </div>
                ))}
              </div>

              <div className="mt-4 flex gap-2">
                <SaveQuestionButton initialSaved onToggle={unsaveQuestionAction.bind(null, q.id)} />
                <ReportQuestionDialog onSubmit={reportSavedQuestionAction.bind(null, q.id)} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
