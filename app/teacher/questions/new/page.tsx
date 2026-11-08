import { requireTeacherPage } from "@/lib/teacher/page";
import { teacherExamTree } from "@/lib/teacher/queries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QuestionForm } from "@/app/admin/(dashboard)/questions/question-form";
import { createQuestionTeacherAction } from "@/app/teacher/actions";

export const metadata = { title: "Add Question — Teacher Portal" };

export default async function NewTeacherQuestion({ searchParams }: { searchParams: Promise<{ exam?: string }> }) {
  const scope = await requireTeacherPage();
  const { exam } = await searchParams;
  const tree = await teacherExamTree(scope);
  if (tree.length === 0) return <p className="text-sm">No exam is assigned to you yet.</p>;
  // Put the requested (assigned) exam first so the form preselects it.
  const exams = exam ? [...tree.filter((e) => e.id === exam), ...tree.filter((e) => e.id !== exam)] : tree;
  return (
    <Card>
      <CardHeader><CardTitle>Add question</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-[var(--color-muted-foreground)]">The question is saved as Draft. Students never see it until the Master Admin approves your publication request.</p>
        <QuestionForm exams={exams} teacher={{ action: createQuestionTeacherAction, submitLabel: "Save as Draft" }} />
      </CardContent>
    </Card>
  );
}
