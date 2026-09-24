"use server";

import { z } from "zod";
import { revalidateMockSeriesSurfaces } from "@/lib/mock-series-revalidate";
import type { MockTestStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { parseIstDateTimeLocal } from "@/lib/ist-time";
import { parseScheduleFile, type RawScheduleRow } from "@/lib/schedule-import";

export interface ScheduleRowFormState {
  error?: string;
  success?: boolean;
}

/** Inline table-editor row save (Schedule Manager) — availableFrom + duration + publish toggle for one existing MockTest. */
export async function updateScheduleRowAction(
  mockTestId: string,
  _prev: ScheduleRowFormState,
  formData: FormData
): Promise<ScheduleRowFormState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const availableFromRaw = (formData.get("availableFrom") as string | null) || "";
  const durationMinutes = Number(formData.get("durationMinutes"));
  const publish = formData.get("publish") === "on";

  if (!Number.isFinite(durationMinutes) || durationMinutes < 1) return { error: "Invalid duration." };
  const availableFrom = availableFromRaw ? parseIstDateTimeLocal(availableFromRaw) : null;
  if (availableFromRaw && !availableFrom) return { error: "Invalid available-from date/time." };

  await prisma.mockTest.update({
    where: { id: mockTestId },
    data: { availableFrom, durationMinutes, status: publish ? "PUBLISHED" : "DRAFT" },
  });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "MOCK_TEST_SCHEDULE_UPDATED",
      entityType: "MockTest",
      entityId: mockTestId,
      metadata: { availableFrom, durationMinutes, publish },
    },
  });

  revalidateMockSeriesSurfaces();
  return { success: true };
}

export interface SchedulePreviewRow {
  rowNumber: number;
  testNumber: number | null;
  title: string;
  matchedMockTestId: string | null;
  isNew: boolean;
  availableFromIso: string | null;
  durationMinutes: number | null;
  publish: boolean | null;
  errors: string[];
  warnings: string[];
}

export interface SchedulePreviewResult {
  error?: string;
  rows?: SchedulePreviewRow[];
}

function parseBooleanCell(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  return ["true", "1", "yes", "y"].includes(v);
}

/** Parses + validates an uploaded schedule file into a preview — never writes to the DB. */
export async function previewScheduleImportAction(
  testSeriesId: string,
  _prev: SchedulePreviewResult,
  formData: FormData
): Promise<SchedulePreviewResult> {
  await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "No file uploaded." };

  const { rows: rawRows, errors: parseErrors } = await parseScheduleFile(file);
  if (parseErrors.length > 0 && rawRows.length === 0) return { error: parseErrors.join(" ") };

  const existingTests = await prisma.mockTest.findMany({
    where: { testSeriesId },
    select: { id: true, order: true, title: true },
  });
  const byTestNumber = new Map(existingTests.map((t) => [t.order, t]));
  const seenInFile = new Set<number>();

  const rows: SchedulePreviewRow[] = rawRows.map((raw: RawScheduleRow) => {
    const errors: string[] = [];
    const warnings: string[] = [];

    const testNumber = raw.testNumber ? Number(raw.testNumber) : null;
    if (raw.testNumber && (!Number.isInteger(testNumber) || (testNumber as number) < 0)) {
      errors.push("Test Number must be a whole number.");
    }
    if (testNumber != null && seenInFile.has(testNumber)) {
      errors.push(`Duplicate Test Number ${testNumber} in this file — only the first occurrence will be applied.`);
    }
    if (testNumber != null) seenInFile.add(testNumber);

    const matched = testNumber != null ? byTestNumber.get(testNumber) : undefined;
    const isNew = !matched;

    if (isNew && !raw.title.trim()) errors.push("Test Title is required for a new test.");

    const durationMinutes = raw.durationMinutes ? Number(raw.durationMinutes) : null;
    if (raw.durationMinutes && (!Number.isFinite(durationMinutes) || (durationMinutes as number) < 1)) {
      errors.push("Duration Minutes must be a positive number.");
    }
    if (isNew && !durationMinutes) errors.push("Duration Minutes is required for a new test.");

    let availableFromIso: string | null = null;
    if (raw.availableDate) {
      const timePart = raw.availableTime || "00:00";
      const parsed = parseIstDateTimeLocal(`${raw.availableDate}T${timePart}`);
      if (!parsed) errors.push("Invalid Available Date/Time.");
      else availableFromIso = parsed.toISOString();
    }

    const publish = raw.publish ? parseBooleanCell(raw.publish) : null;

    if (isNew) warnings.push("New Test Number — will be created as Draft with 0 questions. Add questions after import.");
    if (matched && raw.title.trim() && raw.title.trim() !== matched.title) {
      warnings.push(`Title will be updated: "${matched.title}" → "${raw.title.trim()}"`);
    }

    return {
      rowNumber: raw.rowNumber,
      testNumber,
      title: raw.title.trim() || matched?.title || "",
      matchedMockTestId: matched?.id ?? null,
      isNew,
      availableFromIso,
      durationMinutes,
      publish,
      errors,
      warnings,
    };
  });

  return { rows };
}

const confirmRowSchema = z.object({
  testNumber: z.number().int().nonnegative().nullable(),
  title: z.string(),
  isNew: z.boolean(),
  availableFromIso: z.string().nullable(),
  durationMinutes: z.number().nullable(),
  publish: z.boolean().nullable(),
});

export interface ScheduleImportConfirmResult {
  error?: string;
  applied?: number;
  created?: number;
  updated?: number;
}

/**
 * Applies a previously-previewed import. Re-derives every match from
 * `testNumber` against the CURRENT database state rather than trusting the
 * client-echoed `matchedMockTestId` — the admin may have edited other tests
 * between preview and confirm. Rows with any error are skipped entirely.
 */
export async function confirmScheduleImportAction(
  testSeriesId: string,
  examId: string,
  rows: unknown[]
): Promise<ScheduleImportConfirmResult> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);

  const parsed = rows.map((r) => confirmRowSchema.safeParse(r)).filter((r) => r.success).map((r) => r.data);
  const validRows = parsed.filter((r) => r.testNumber != null);
  if (validRows.length === 0) return { error: "No valid rows to import." };

  const existingTests = await prisma.mockTest.findMany({ where: { testSeriesId }, select: { id: true, order: true } });
  const byTestNumber = new Map(existingTests.map((t) => [t.order, t.id]));

  const seen = new Set<number>();
  let created = 0;
  let updated = 0;

  const operations = [];
  for (const row of validRows) {
    const testNumber = row.testNumber as number;
    if (seen.has(testNumber)) continue; // duplicate within this batch — first occurrence wins
    seen.add(testNumber);

    const matchedId = byTestNumber.get(testNumber);
    const availableFrom = row.availableFromIso ? new Date(row.availableFromIso) : undefined;
    const status: MockTestStatus | undefined = row.publish == null ? undefined : row.publish ? "PUBLISHED" : "DRAFT";

    if (matchedId) {
      operations.push(
        prisma.mockTest.update({
          where: { id: matchedId },
          data: {
            ...(row.title ? { title: row.title } : {}),
            ...(availableFrom !== undefined ? { availableFrom } : {}),
            ...(row.durationMinutes ? { durationMinutes: row.durationMinutes } : {}),
            ...(status ? { status } : {}),
          },
        })
      );
      updated += 1;
    } else if (row.title && row.durationMinutes) {
      operations.push(
        prisma.mockTest.create({
          data: {
            examId,
            testSeriesId,
            title: row.title,
            durationMinutes: row.durationMinutes,
            order: testNumber,
            availableFrom: availableFrom ?? null,
            status: status ?? "DRAFT",
          },
        })
      );
      created += 1;
    }
  }

  if (operations.length === 0) return { error: "No valid rows to import." };

  await prisma.$transaction(operations);
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "TEST_SERIES_SCHEDULE_IMPORTED",
      entityType: "TestSeries",
      entityId: testSeriesId,
      metadata: { created, updated },
    },
  });

  revalidateMockSeriesSurfaces();

  return { applied: created + updated, created, updated };
}
