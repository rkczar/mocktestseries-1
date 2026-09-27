import { prisma } from "@/lib/prisma";
import { withExamTaxonomy } from "@/lib/exam-taxonomy";
import { TemplateBuilder, type ExamContextData } from "./template-builder";

export const metadata = { title: "Question Templates — Mock Test Series.in Admin" };

export default async function Page() {
  const examRows = await prisma.exam.findMany({
    orderBy: { order: "asc" },
    select: {
      id: true,
      name: true,
      code: true,
      previousYearPapers: {
        orderBy: { year: "desc" },
        select: { id: true, year: true, title: true },
      },
    },
  });

  const exams = await withExamTaxonomy(prisma, examRows);
  const examData: ExamContextData[] = exams;

  return <TemplateBuilder exams={examData} />;
}
