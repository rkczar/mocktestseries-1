/**
 * Active Exam is a pure display/selection preference — which of the
 * student's enrolled exams the Dashboard is currently scoped to. It is never
 * an access-control mechanism: enrollment (StudentExamEnrollment) remains the
 * only thing that determines which exam ids are valid to select, exactly
 * like StudentExamEnrollment itself gates nothing else in the app. Persisted
 * the same way as THEME_COOKIE / TEXT_SIZE_COOKIE (lib/theme.ts,
 * lib/text-size.ts) — a plain client-set cookie, read back on the next
 * server render.
 */
export const ACTIVE_EXAM_COOKIE = "mts-active-exam";
