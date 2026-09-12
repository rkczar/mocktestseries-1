import "server-only";
import { prisma } from "@/lib/prisma";

const PREFIX = "MTS";
const PAD_LENGTH = 6;

/** Atomically issues the next human-readable Student ID, e.g. MTS-000123. */
export async function nextStudentId(): Promise<string> {
  await prisma.studentIdCounter.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, value: 0 },
  });
  const counter = await prisma.studentIdCounter.update({
    where: { id: 1 },
    data: { value: { increment: 1 } },
  });
  return `${PREFIX}-${String(counter.value).padStart(PAD_LENGTH, "0")}`;
}
