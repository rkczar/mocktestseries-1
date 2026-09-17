import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SubjectDeleteButton } from "../subjects/subject-delete-button";
import { MoveButtons } from "./move-buttons";
import { DescriptionForm } from "./description-form";
import { AddTopicForm } from "./add-topic-form";
import { TopicRow } from "./topic-row";
import { updateSubjectSyllabusDescriptionAction, moveSubjectAction } from "./actions";

interface SubjectPanelProps {
  examId: string;
  subject: {
    id: string;
    name: string;
    syllabusDescription: string | null;
    topics: {
      id: string;
      name: string;
      syllabusDescription: string | null;
      subTopics: { id: string; name: string }[];
      _count: { questions: number };
    }[];
  };
  isFirst: boolean;
  isLast: boolean;
}

export function SubjectPanel({ examId, subject, isFirst, isLast }: SubjectPanelProps) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <h3 className="text-sm font-semibold text-[var(--color-foreground)]">{subject.name}</h3>
        <div className="flex items-center gap-2">
          <MoveButtons
            label={subject.name}
            disableUp={isFirst}
            disableDown={isLast}
            onMove={(direction) => moveSubjectAction(examId, subject.id, direction)}
          />
          <SubjectDeleteButton subjectId={subject.id} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <DescriptionForm
          action={updateSubjectSyllabusDescriptionAction}
          idField="subjectId"
          idValue={subject.id}
          defaultValue={subject.syllabusDescription}
          placeholder="What this subject covers (shown on the public syllabus)…"
        />

        <div className="flex flex-col gap-2">
          {subject.topics.length === 0 ? (
            <p className="text-xs text-[var(--color-muted-foreground)]">No chapters/topics yet.</p>
          ) : (
            subject.topics.map((topic, i) => (
              <TopicRow
                key={topic.id}
                examId={examId}
                subjectId={subject.id}
                topic={topic}
                isFirst={i === 0}
                isLast={i === subject.topics.length - 1}
              />
            ))
          )}
        </div>

        <AddTopicForm subjectId={subject.id} />
      </CardContent>
    </Card>
  );
}
