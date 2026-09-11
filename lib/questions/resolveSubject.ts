import "server-only";

import { prisma } from "@/lib/db";

export async function resolveSubjectId(examId: string, name: string) {
  const subject = await prisma.subject.upsert({
    where: { examId_name: { examId, name } },
    update: {},
    create: { examId, name },
  });
  return subject.id;
}
