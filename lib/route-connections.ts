/**
 * Curated, non-tree page connections for the Website Diagram (Admin -> Website
 * -> Website Diagram). `lib/routes.ts` already encodes one hierarchical edge
 * per page via `parentRoute` — that's enough for most of the graph. This file
 * captures the *other* real connections that don't fit that tree: redirects,
 * buttons, and cards that send a user somewhere other than their tree parent.
 *
 * Every entry here was verified against the actual source component that
 * creates the link (see the comment above each group) — nothing here is
 * invented. When a spec/mockup names a connection that isn't wired yet in
 * this codebase, it is deliberately left out rather than faked; add it here
 * once the real link exists.
 */

export type ConnectionSource =
  | "header"
  | "footer"
  | "button"
  | "card"
  | "cta"
  | "redirect"
  | "form"
  | "internal"
  | "scanned"
  | "admin-config";

export interface RouteConnection {
  from: string;
  to: string;
  source: ConnectionSource;
  label?: string;
}

export const ROUTE_CONNECTIONS: RouteConnection[] = [
  // Note: /login -> /student/dashboard on successful sign-in is already
  // captured by the tree edge (Student Dashboard's parentRoute is /login in
  // lib/routes.ts), so it's intentionally not duplicated here.

  // app/admin/login/actions.ts:22 — signIn("credentials", { redirectTo:
  // callbackUrl.startsWith("/admin") ? callbackUrl : "/admin" }).
  { from: "/admin/login", to: "/admin", source: "redirect", label: "Successful sign-in" },

  // /privacy and /terms are thin redirects (app/privacy/page.tsx,
  // app/terms/page.tsx) into the combined /contact page's anchored sections.
  { from: "/privacy", to: "/contact", source: "redirect", label: "Privacy Policy section" },
  { from: "/terms", to: "/contact", source: "redirect", label: "Terms & Conditions section" },

  // lib/communications-actions.ts:submitContactMessageAction — the Message Us
  // form on /contact creates a Communication row surfaced at
  // /admin/communications (Contact tab).
  { from: "/contact", to: "/admin/communications", source: "form", label: "Message Us submission" },

  // components/homepage/grow-with-us.tsx (GrowWithUsButton) renders sitewide,
  // in both the public header and footer (components/homepage/site-header.tsx,
  // site-footer.tsx) — not tied to one page, so this edge is anchored at the
  // homepage as a representative entry point, matching how lib/global-nav-links.ts
  // deliberately keeps other shared-chrome links out of page-specific edges.
  // lib/communications-actions.ts:submitGrowWithUsAction creates a
  // Communication row surfaced at /admin/communications (Grow With Us tab).
  { from: "/", to: "/admin/communications", source: "form", label: "Grow with Us (header/footer, sitewide) submission" },

  // app/student/(dashboard)/dashboard/page.tsx — "Continue" button on the
  // in-progress-attempt card.
  { from: "/student/dashboard", to: "/student/attempt/[attemptId]/run", source: "button", label: "Continue in-progress attempt" },

  // app/student/attempt/[attemptId]/result/page.tsx:69 — "Back to Dashboard" link.
  { from: "/student/attempt/[attemptId]/result", to: "/student/dashboard", source: "button", label: "Back to Dashboard" },

  // Public exam SEO hub (/exams/[slug]/...) "Attempt Paper" / "Start Test" /
  // "Practice" CTAs. Per-item hrefs are template literals
  // (`/student/attempt/resume?paper=${p.id}`, `/student/subject-test/${exam.id}`)
  // so the mechanical scanner can't see them — curated here since they're real.
  { from: "/exams/[slug]", to: "/student/attempt/resume", source: "cta", label: "Attempt Paper / Start Preparing" },
  { from: "/exams/[slug]/previous-year-papers", to: "/student/attempt/resume", source: "button", label: "Attempt Paper" },
  { from: "/exams/[slug]/mock-tests", to: "/student/attempt/resume", source: "button", label: "Start Test" },
  { from: "/exams/[slug]/syllabus", to: "/student/subject-test/[examId]", source: "button", label: "Practice by subject" },
  { from: "/exams/[slug]/question-bank", to: "/student/subject-test/[examId]", source: "button", label: "Practice by subject" },
  { from: "/exams/[slug]", to: "/student/subject-test/[examId]", source: "card", label: "Subject card" },

  // app/student/attempt/resume/page.tsx — resumes into the canonical
  // TestAttempt flow, same destination the authenticated student flow uses.
  { from: "/student/attempt/resume", to: "/student/attempt/[attemptId]", source: "redirect", label: "Resumes into canonical TestAttempt" },

  // middleware.ts redirects an unauthenticated /student/* request (including
  // /student/attempt/resume) to /login with callbackUrl set.
  { from: "/student/attempt/resume", to: "/login", source: "redirect", label: "Unauthenticated → login (callbackUrl preserved)" },
];

/**
 * Ordered student journey for the Flow view (Section 6A). Each route must
 * exist in ROUTE_MANIFEST with status "CONNECTED" — this is a curated
 * narrative ordering, not a discovery, so it stays honest about what's
 * actually built today.
 */
export const STUDENT_JOURNEY_FLOW: string[] = [
  "/",
  "/login",
  "/student/dashboard",
  "/student/exams",
  "/student/exams/[examId]",
  "/student/attempt/[attemptId]",
  "/student/attempt/[attemptId]/run",
  "/student/attempt/[attemptId]/result",
  "/student/attempt/[attemptId]/review",
  "/student/history",
];
