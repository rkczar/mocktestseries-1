import "server-only";
import { prisma } from "@/lib/prisma";
import { isDefaultEligible, isExcludedExam } from "@/lib/instagram/exam-scope";

/**
 * Which exams Instagram Studio may use (Setting `instagram.scope`). Until a
 * Master Admin saves a list, eligibility is automatic by exam name (FMGE,
 * NEET PG, INI-CET, AIIMS, UPSC CMS, Medical Officer exams). NEET UG and
 * school-level exams can never be enabled. Only the studio is scoped — the
 * exams themselves are untouched.
 */

export const SCOPE_SETTING_KEY = "instagram.scope";

interface StoredScope {
  /** Explicit list chosen by an admin; absent = automatic by name. */
  examIds?: string[];
  updatedAt?: string;
}

export interface ScopedExam {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  eligible: boolean;
  excluded: boolean;
  /** Why it is (not) eligible — shown in Settings. */
  reason: string;
}

async function readScope(): Promise<StoredScope> {
  const row = await prisma.setting.findUnique({ where: { key: SCOPE_SETTING_KEY } });
  return (row?.value as StoredScope | undefined) ?? {};
}

export async function listScopedExams(): Promise<{ exams: ScopedExam[]; mode: "auto" | "custom" }> {
  const [scope, exams] = await Promise.all([readScope(), prisma.exam.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, code: true, isActive: true } })]);
  const custom = Array.isArray(scope.examIds);
  const chosen = new Set(scope.examIds ?? []);
  return {
    mode: custom ? "custom" : "auto",
    exams: exams.map((e) => {
      const excluded = isExcludedExam(e.name, e.code);
      const eligible = !excluded && (custom ? chosen.has(e.id) : isDefaultEligible(e.name, e.code));
      return {
        ...e,
        eligible,
        excluded,
        reason: excluded ? "NEET UG / school level — always excluded" : custom ? (eligible ? "Enabled by admin" : "Not enabled") : eligible ? "Automatic (MBBS-level exam name)" : "Not recognised as an MBBS-level exam — enable it if it is one",
      };
    }),
  };
}

export async function eligibleExamIds(): Promise<Set<string>> {
  const { exams } = await listScopedExams();
  return new Set(exams.filter((e) => e.eligible).map((e) => e.id));
}

export async function isExamInScope(examId: string): Promise<boolean> {
  return (await eligibleExamIds()).has(examId);
}

/** Save an explicit list (excluded exams are dropped), or `null` to go back to automatic. */
export async function saveScope(examIds: string[] | null): Promise<void> {
  let value: StoredScope = { updatedAt: new Date().toISOString() };
  if (examIds) {
    const exams = await prisma.exam.findMany({ where: { id: { in: examIds.slice(0, 200) } }, select: { id: true, name: true, code: true } });
    value = { ...value, examIds: exams.filter((e) => !isExcludedExam(e.name, e.code)).map((e) => e.id) };
  }
  await prisma.setting.upsert({ where: { key: SCOPE_SETTING_KEY }, update: { value: value as object }, create: { key: SCOPE_SETTING_KEY, value: value as object } });
}
