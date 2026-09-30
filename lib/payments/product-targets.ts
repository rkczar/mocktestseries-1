import "server-only";
import type { AccessType, ProductType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Server-side checks for what a Product unlocks, run by the Admin product
 * save before any write. An Individual Mock Test product must point at an
 * existing, non-archived PAID mock of the chosen exam, and at most one
 * active product may sell a given mock (a student never sees two competing
 * prices for it). A Complete Test Series product must belong to the chosen
 * exam. Returns an Admin-facing error, or null when valid.
 */
export async function validateProductTarget(input: {
  id: string | null;
  productType: ProductType;
  accessType: AccessType;
  isActive: boolean;
  examId: string | null;
  testSeriesId: string | null;
  mockTestId: string | null;
}): Promise<string | null> {
  if (input.productType === "MOCK_TEST" && input.mockTestId) {
    const mock = await prisma.mockTest.findUnique({ where: { id: input.mockTestId }, select: { examId: true, status: true, accessType: true } });
    if (!mock || mock.status === "ARCHIVED") return "Choose an existing (non-archived) Mock Test.";
    if (input.examId && input.examId !== mock.examId) return "That Mock Test belongs to a different exam than the one selected.";
    if (input.accessType === "PAID" && mock.accessType === "FREE")
      return "That Mock Test is FREE for everyone. Set its access to PAID first (Admin → Test Series → Mock → Access), then sell it individually.";
    if (input.isActive) {
      const other = await prisma.product.findFirst({
        where: { productType: "MOCK_TEST", mockTestId: input.mockTestId, isActive: true, ...(input.id ? { id: { not: input.id } } : {}) },
        select: { code: true },
      });
      if (other) return `Another active product (${other.code}) already sells this Mock Test. Deactivate it first.`;
    }
  }
  if (input.productType === "TEST_SERIES" && input.testSeriesId && input.examId) {
    const series = await prisma.testSeries.findUnique({ where: { id: input.testSeriesId }, select: { examId: true } });
    if (series && series.examId !== input.examId) return "That Test Series belongs to a different exam than the one selected.";
  }
  return null;
}
