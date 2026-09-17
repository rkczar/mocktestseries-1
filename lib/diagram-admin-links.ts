/**
 * Curated Admin -> Website/Student configuration edges (Website Diagram
 * Section 6): real "this admin module's data/settings feed that public or
 * student page" relationships, as opposed to a user clicking a link
 * (`lib/route-connections.ts`). Rendered with a visually distinct connector
 * (see `connection-edge.tsx`, source `"admin-config"`) so a viewer can tell
 * at a glance that an edge represents configuration/data flow rather than
 * navigation.
 *
 * Same honesty rule as `route-connections.ts`: every entry here was verified
 * against the actual code path that reads the admin-managed data, not
 * inferred from naming. The comment above each entry cites that evidence.
 */

export interface AdminConfigLink {
  from: string;
  to: string;
  label: string;
}

export const ADMIN_CONFIG_LINKS: AdminConfigLink[] = [
  // app/page.tsx renders getPublishedHomepage() (lib/homepage.ts), which reads
  // the content saved by the Homepage Builder.
  { from: "/admin/website/homepage", to: "/", label: "Publishes homepage content" },

  // lib/student-data.ts getActiveExamsCatalog() reads prisma.exam rows written
  // by app/admin/(dashboard)/exams/actions.ts.
  { from: "/admin/exams", to: "/student/exams", label: "Publishes exam catalog" },

  // lib/question-selection.ts and lib/test-attempt.ts read prisma.question
  // rows managed by the admin Question Bank.
  { from: "/admin/questions", to: "/student/attempt/[attemptId]/run", label: "Supplies question bank" },

  // app/login/page.tsx imports getAuthProviderConfig() (lib/auth-provider-config.ts)
  // directly to decide which sign-in methods to render.
  { from: "/admin/settings/authentication", to: "/login", label: "Controls sign-in providers" },

  // lib/student-data.ts getPublishedCustomModulesForStudent() reads rows
  // written by app/admin/(dashboard)/custom-modules/actions.ts.
  { from: "/admin/custom-modules", to: "/student/custom-module", label: "Publishes custom modules" },

  // app/student/ai-actions.ts (the review page's Ask AI action) calls
  // lib/ai-explanation.ts, which reads the Gemini key/model from
  // lib/gemini-config.ts — configured on this page.
  { from: "/admin/ai/settings", to: "/student/attempt/[attemptId]/review", label: "Powers Ask AI explanations" },

  // app/student/(dashboard)/exams/[examId]/page.tsx renders <ExamSyllabus> when
  // exam.syllabusEnabled — both fields come from lib/student-data.ts
  // getExamDetailForStudent(), which reads the same Exam/Subject/Topic rows
  // this page manages (app/admin/(dashboard)/exams/syllabus/actions.ts).
  { from: "/admin/exams/syllabus", to: "/student/exams/[examId]", label: "Publishes exam syllabus" },
];
