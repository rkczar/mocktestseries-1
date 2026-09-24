import "server-only";
import { revalidatePath } from "next/cache";

/**
 * Every public/student surface that renders canonical Mock Test Series data
 * (lib/mock-series.ts). Called by any admin mutation that changes a series,
 * a mock, its schedule/coverage/questions, or the product price, so one Admin
 * save updates the homepage, Exam Hub, series page and deep-page cards together.
 */
export function revalidateMockSeriesSurfaces(...extra: string[]) {
  revalidatePath("/");
  revalidatePath("/exams");
  for (const p of ["", "/mock-test-series", "/previous-year-papers", "/syllabus", "/exam-pattern", "/question-bank"]) {
    revalidatePath(`/exams/[slug]${p}`, "page");
  }
  revalidatePath("/student/test-series");
  revalidatePath("/student/dashboard");
  revalidatePath("/student/plans");
  revalidatePath("/admin/exams/test-series");
  revalidatePath("/admin/exams/test-series/[id]", "page");
  revalidatePath("/admin/tests/mock");
  revalidatePath("/admin/tests/scheduled");
  for (const p of extra) revalidatePath(p);
}
