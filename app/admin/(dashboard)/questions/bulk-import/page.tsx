import { prisma } from "@/lib/prisma";
import { BulkImportWorkspace } from "./bulk-import-workspace";

export default async function BulkImportPage() {
  const exams = await prisma.exam.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, year: true },
  });

  return <BulkImportWorkspace exams={exams} />;
}
