/**
 * Server-side release-policy enforcement for TestResource downloads (Paper
 * PDF / Solution PDF / OMR Template). This is deliberately pure — the
 * download route (app/api/student/test-resources/[id]/route.ts) is the only
 * place this is called, and it is the only enforcement point: never a
 * client-supplied "unlocked" flag.
 *
 * OMR_TEMPLATE resources carry no exam secrecy concern — they're gated only
 * by `isActive`, regardless of releasePolicy.
 */
import type { ResourceReleasePolicy, TestResourceType } from "@prisma/client";

export interface TestResourceAccessContext {
  resourceType: TestResourceType;
  releasePolicy: ResourceReleasePolicy;
  releaseAt: Date | null;
  isActive: boolean;
  /** Whether the parent Mock Test is currently AVAILABLE per lib/mock-test-schedule.ts. */
  mockTestAvailable: boolean;
  /** Whether the requesting student has a SUBMITTED attempt for the parent Mock Test. */
  hasSubmittedAttempt: boolean;
  /**
   * Whether the parent Mock Test's result/answer key is released
   * (lib/mock-test-schedule.ts#isMockResultReleased — the same gate as the
   * result, review, Ask AI and leaderboard). A Solution PDF is answer-key
   * data, so it never unlocks before this, whatever its own policy says.
   * Omitted = no parent mock = released.
   */
  resultReleased?: boolean;
  now?: Date;
}

export function canAccessTestResource(ctx: TestResourceAccessContext): boolean {
  if (!ctx.isActive) return false;
  if (ctx.resourceType === "OMR_TEMPLATE") return true;
  if (ctx.resourceType === "SOLUTION_PDF" && ctx.resultReleased === false) return false;

  const now = ctx.now ?? new Date();
  switch (ctx.releasePolicy) {
    case "DISABLED":
      return false;
    case "AFTER_AVAILABLE_FROM":
      return ctx.mockTestAvailable;
    case "AFTER_SUBMISSION":
      return ctx.hasSubmittedAttempt;
    case "CUSTOM_DATE":
      return ctx.releaseAt != null && now.getTime() >= ctx.releaseAt.getTime();
    default:
      return false;
  }
}
