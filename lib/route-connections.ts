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
  | "scanned";

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

  // app/student/(dashboard)/dashboard/page.tsx — "Continue" button on the
  // in-progress-attempt card.
  { from: "/student/dashboard", to: "/student/attempt/[attemptId]/run", source: "button", label: "Continue in-progress attempt" },

  // app/student/attempt/[attemptId]/result/page.tsx:69 — "Back to Dashboard" link.
  { from: "/student/attempt/[attemptId]/result", to: "/student/dashboard", source: "button", label: "Back to Dashboard" },
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
