import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { isPurchasable, productCovers, PRODUCT_SELECT, type ProductRow } from "@/lib/payments/access";

/**
 * Mock Test → Test Series assignment and paid-coverage review.
 *
 * The assignment IS MockTest.testSeriesId — nothing else is stored. Access
 * stays canonical: Product (TEST_SERIES / EXAM_ACCESS / MOCK_TEST) → Test
 * Series → Mock Test → lib/payments/access.ts. There are no per-mock
 * entitlements, so a student who already owns a series' Product can open a
 * mock the moment it is assigned, and loses it only through that Product.
 *
 * "Covered" means at least one active, purchasable PAID Product unlocks the
 * mock under the same productCovers() rule the access engine uses — i.e. a
 * student could actually buy their way in. A PAID mock that no such Product
 * covers evaluates to NOT_AVAILABLE for every student.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export class AssignmentError extends Error {}

export interface CoverageMock {
  id: string;
  examId: string;
  testSeriesId: string | null;
  accessType: "FREE" | "PAID";
}

export interface ProductRef {
  id: string;
  code: string;
  name: string;
  productType: ProductRow["productType"];
}

export const UNCOVERED_PAID_MOCK_WARNING =
  "This paid mock is not included in any purchasable plan. Students will not be able to unlock it.";

export async function loadCoverageProducts(db: Db): Promise<ProductRow[]> {
  return db.product.findMany({ where: { isActive: true }, select: PRODUCT_SELECT });
}

function descriptor(m: CoverageMock) {
  return { kind: "MOCK_TEST" as const, id: m.id, examId: m.examId, testSeriesId: m.testSeriesId, accessType: m.accessType };
}

/** Is the mock free for everyone (FREE flag, or a covering FREE product)? Mirrors evaluateContentAccess's free rules. */
export function mockIsFree(m: CoverageMock, products: ProductRow[]): boolean {
  const covering = products.filter((p) => productCovers(p, descriptor(m)));
  if (covering.some((p) => p.accessType === "FREE")) return true;
  if (m.accessType === "FREE") return true;
  return m.accessType !== "PAID" && !covering.some((p) => p.accessType === "PAID");
}

/** Purchasable PAID products that unlock this mock. */
export function purchasableProductsFor(m: CoverageMock, products: ProductRow[], now: Date): ProductRef[] {
  return products
    .filter((p) => p.accessType === "PAID" && isPurchasable(p, now) && productCovers(p, descriptor(m)))
    .map((p) => ({ id: p.id, code: p.code, name: p.name, productType: p.productType }));
}

/**
 * How a PAID mock is sold, for the Admin mock page: included in a Complete
 * Series / Exam Access product, sold on its own, both, or not at all.
 */
export function sellingCoverageLabel(plans: ProductRef[]): string | null {
  const individual = plans.filter((p) => p.productType === "MOCK_TEST").map((p) => p.name);
  const bundles = plans.filter((p) => p.productType !== "MOCK_TEST").map((p) => p.name);
  if (individual.length && bundles.length) return `Sold individually (${individual.join(", ")}) and included in ${bundles.join(", ")}`;
  if (individual.length) return `Sold individually only (${individual.join(", ")})`;
  if (bundles.length) return `Included in Complete Series only (${bundles.join(", ")})`;
  return null;
}

/** An active Individual Mock Test product exists for a mock that is FREE — it can never be sold (FREE always means open). */
export function inertIndividualProducts(m: CoverageMock, products: ProductRow[]): string[] {
  if (m.accessType !== "FREE") return [];
  return products.filter((p) => p.productType === "MOCK_TEST" && p.mockTestId === m.id && p.accessType === "PAID").map((p) => p.name);
}

/** Purchasable PAID products that would unlock a PAID mock placed in `seriesId` of `examId`. */
export function seriesPlanProducts(seriesId: string, examId: string, products: ProductRow[], now: Date): ProductRef[] {
  return purchasableProductsFor({ id: "__probe__", examId, testSeriesId: seriesId, accessType: "PAID" }, products, now);
}

export interface CoverageSummary<M extends CoverageMock = CoverageMock> {
  total: number;
  free: number;
  paid: number;
  coveredPaid: number;
  uncoveredPaid: number;
  uncovered: M[];
}

export function summarizeCoverage<M extends CoverageMock>(mocks: M[], products: ProductRow[], now: Date): CoverageSummary<M> {
  const uncovered: M[] = [];
  let free = 0;
  let covered = 0;
  for (const m of mocks) {
    if (mockIsFree(m, products)) free++;
    else if (purchasableProductsFor(m, products, now).length > 0) covered++;
    else uncovered.push(m);
  }
  return { total: mocks.length, free, paid: mocks.length - free, coveredPaid: covered, uncoveredPaid: uncovered.length, uncovered };
}

async function nextTestNumber(db: Db, seriesId: string): Promise<number> {
  const last = await db.mockTest.findFirst({ where: { testSeriesId: seriesId }, orderBy: { order: "desc" }, select: { order: true } });
  return (last?.order ?? 0) + 1;
}

async function audit(db: Db, actorId: string | undefined, mockTestId: string, metadata: Record<string, unknown>) {
  await db.auditLog.create({
    data: { actorId: actorId ?? null, action: "MOCK_TEST_SERIES_ASSIGNMENT", entityType: "MockTest", entityId: mockTestId, metadata: metadata as Prisma.InputJsonValue },
  });
}

/**
 * Assign standalone mocks of the series' exam to `seriesId` (appended as the
 * next Test Numbers, in the order given). Mocks already in a series, or of a
 * different exam, are refused — nothing is ever moved silently.
 */
export async function assignMocksToSeries(db: Db, input: { seriesId: string; mockIds: string[]; actorId?: string }): Promise<number> {
  const ids = [...new Set(input.mockIds)];
  if (ids.length === 0) throw new AssignmentError("Select at least one mock test.");
  const series = await db.testSeries.findUnique({ where: { id: input.seriesId }, select: { id: true, examId: true } });
  if (!series) throw new AssignmentError("Test Series not found.");
  const mocks = await db.mockTest.findMany({ where: { id: { in: ids } }, select: { id: true, examId: true, testSeriesId: true } });
  if (mocks.length !== ids.length) throw new AssignmentError("One or more mock tests no longer exist.");
  for (const m of mocks) {
    if (m.examId !== series.examId) throw new AssignmentError("Only mock tests of this series' exam can be assigned.");
    if (m.testSeriesId === series.id) throw new AssignmentError("A selected mock test is already in this series.");
    if (m.testSeriesId) throw new AssignmentError("A selected mock test belongs to another series — remove it there first.");
  }
  let n = await nextTestNumber(db, series.id);
  for (const id of ids) {
    const r = await db.mockTest.updateMany({ where: { id, testSeriesId: null }, data: { testSeriesId: series.id, order: n } });
    if (r.count !== 1) throw new AssignmentError("A selected mock test changed meanwhile — reload and try again.");
    await audit(db, input.actorId, id, { op: "ASSIGN", testSeriesId: series.id, testNumber: n });
    n++;
  }
  return ids.length;
}

/** Make mocks of `seriesId` standalone again. Their Test Number, schedule, questions and FREE/PAID flag are untouched. */
export async function removeMocksFromSeries(db: Db, input: { seriesId: string; mockIds: string[]; actorId?: string }): Promise<number> {
  const ids = [...new Set(input.mockIds)];
  if (ids.length === 0) throw new AssignmentError("Select at least one mock test.");
  const r = await db.mockTest.updateMany({ where: { id: { in: ids }, testSeriesId: input.seriesId }, data: { testSeriesId: null } });
  if (r.count !== ids.length) throw new AssignmentError("A selected mock test isn't in this series any more — reload and try again.");
  for (const id of ids) await audit(db, input.actorId, id, { op: "REMOVE", testSeriesId: input.seriesId });
  return ids.length;
}

/** Mock editor: set one mock's assignment (null = Standalone). Same exam rule; moving between series is explicit here. */
export async function setMockSeriesAssignment(db: Db, input: { mockTestId: string; seriesId: string | null; actorId?: string }): Promise<void> {
  const mock = await db.mockTest.findUnique({ where: { id: input.mockTestId }, select: { id: true, examId: true, testSeriesId: true } });
  if (!mock) throw new AssignmentError("Mock test not found.");
  if ((mock.testSeriesId ?? null) === input.seriesId) return;
  if (input.seriesId === null) {
    await db.mockTest.update({ where: { id: mock.id }, data: { testSeriesId: null } });
    await audit(db, input.actorId, mock.id, { op: "REMOVE", testSeriesId: mock.testSeriesId });
    return;
  }
  const series = await db.testSeries.findUnique({ where: { id: input.seriesId }, select: { id: true, examId: true } });
  if (!series) throw new AssignmentError("Test Series not found.");
  if (series.examId !== mock.examId) throw new AssignmentError("A mock test can only join a Test Series of its own exam.");
  const order = await nextTestNumber(db, series.id);
  await db.mockTest.update({ where: { id: mock.id }, data: { testSeriesId: series.id, order } });
  await audit(db, input.actorId, mock.id, { op: mock.testSeriesId ? "MOVE" : "ASSIGN", from: mock.testSeriesId, testSeriesId: series.id, testNumber: order });
}
