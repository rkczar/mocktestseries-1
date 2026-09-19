import { prisma } from "@/lib/prisma";
import { TemplateBuilder, type ExamContextData } from "./template-builder";

export const metadata = { title: "Question Templates — Mock Test Series.in Admin" };

export default async function Page() {
  const exams = await prisma.exam.findMany({
    orderBy: { order: "asc" },
    select: {
      id: true,
      name: true,
      code: true,
      subjects: {
        orderBy: { order: "asc" },
        select: {
          id: true,
          name: true,
          topics: {
            orderBy: { order: "asc" },
            select: {
              id: true,
              name: true,
              subTopics: { orderBy: { order: "asc" }, select: { id: true, name: true } },
            },
          },
        },
      },
      previousYearPapers: {
        orderBy: { year: "desc" },
        select: { id: true, year: true, title: true },
      },
    },
  });

  const examData: ExamContextData[] = exams;

  return <TemplateBuilder exams={examData} />;
}
