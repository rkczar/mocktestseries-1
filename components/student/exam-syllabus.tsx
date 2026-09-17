import { BookOpen } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

interface SyllabusTopic {
  id: string;
  name: string;
  syllabusDescription: string | null;
}

interface SyllabusSubject {
  id: string;
  name: string;
  syllabusDescription: string | null;
  topics: SyllabusTopic[];
}

/**
 * Admin -> Exams -> Syllabus, rendered for students/public. Reads the same
 * Exam -> Subject -> Topic taxonomy the Question Bank uses — nothing here is
 * exam-specific markup; every value comes from the passed-in exam data.
 * Callers gate on `exam.syllabusEnabled` themselves so a disabled/empty
 * syllabus never renders a broken or empty section.
 */
export function ExamSyllabus({ subjects, description }: { subjects: SyllabusSubject[]; description?: string | null }) {
  if (subjects.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="h-4 w-4" aria-hidden /> Syllabus
        </CardTitle>
        <CardDescription>{subjects.length} subject{subjects.length === 1 ? "" : "s"}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {description ? <p className="text-sm text-[var(--color-muted-foreground)]">{description}</p> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {subjects.map((subject) => (
            <details
              key={subject.id}
              className="rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 open:bg-[var(--color-card)]"
            >
              <summary className="cursor-pointer text-sm font-medium text-[var(--color-foreground)]">
                {subject.name}{" "}
                <span className="text-xs font-normal text-[var(--color-muted-foreground)]">
                  ({subject.topics.length} chapter{subject.topics.length === 1 ? "" : "s"})
                </span>
              </summary>
              {subject.syllabusDescription ? (
                <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">{subject.syllabusDescription}</p>
              ) : null}
              {subject.topics.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-1.5">
                  {subject.topics.map((topic) => (
                    <li key={topic.id} className="text-xs text-[var(--color-foreground)]">
                      <span>→ {topic.name}</span>
                      {topic.syllabusDescription ? (
                        <p className="mt-0.5 pl-3 text-[var(--color-muted-foreground)]">{topic.syllabusDescription}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">No chapters listed yet.</p>
              )}
            </details>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
