import { prisma } from "@/lib/prisma";
import { BulkImportWorkspace } from "./bulk-import-workspace";

export default async function BulkImportPage() {
  const [exams, papers] = await Promise.all([
    prisma.exam.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, year: true },
    }),
    prisma.previousYearPaper.findMany({
      orderBy: [{ year: "desc" }, { title: "asc" }],
      select: { id: true, examId: true, year: true, title: true, paperCode: true },
    }),
  ]);

  return <BulkImportWorkspace exams={exams} papers={papers} />;
}
