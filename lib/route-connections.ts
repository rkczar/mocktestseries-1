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
  // --- Backup & Disaster Recovery (lib/backup/*) ---------------------------
  // What a Full DR backup captures (lib/backup/package.ts): the complete
  // PostgreSQL dump (every admin module's data), persistent assets, source,
  // and secrets as an encrypted recovery payload. Downloads stream to the
  // administrator's device (/api/admin/backup/jobs/[id]/download).
  { from: "/admin/backup", to: "/admin/payments", source: "internal", label: "PostgreSQL → Backup: commerce state (products, coupons, orders, payments, entitlements, invoices)" },
  { from: "/admin/backup", to: "/admin/questions", source: "internal", label: "PostgreSQL + Persistent Assets → Backup: question bank + question images" },
  { from: "/admin/backup", to: "/admin/website", source: "internal", label: "Website Settings → Backup: homepage, appearance, SEO, page visibility" },
  { from: "/admin/backup", to: "/admin/settings/authentication", source: "internal", label: "Secrets → Encrypted Recovery Payload (FULL backups only)" },
  { from: "/admin/backup", to: "/admin/system", source: "internal", label: "Canonical Storage Analysis (Actual App Source · Current/Rollback/Old Releases · Database · Uploads · Backups · Cache/Temp) — shared with System → Storage" },
  // Backup Center structure (one page, tabs): Storage Breakdown · Retention
  // (Current — Protected, Previous N — Protected, Older — Cleanup Candidate) ·
  // Backup Retention · Release Cleanup · Backup Cleanup · Verification · Restore.
  // app/admin/(dashboard)/page.tsx — the dashboard's VPS Storage card
  // (Used / Available / Release / Backup / Reclaimable) links to Manage Storage.
  { from: "/admin", to: "/admin/backup", source: "card", label: "VPS Storage → Manage Storage" },

  // --- Student account deletion lifecycle (lib/student-lifecycle.ts) -------
  // Profile -> Delete Account files one PENDING DeletionRequest (identity
  // snapshot, masked contact). MASTER_ADMIN reviews it; Reject leaves the
  // account active, Approve snapshots -> anonymizes -> releases email/phone/
  // Google link -> revokes every session (jwt callback re-checks status),
  // keeping anonymous attempt/payment history. The old session lands on
  // /login; the same email/phone/Google may register a NEW student later.
  { from: "/student/profile", to: "/admin/students/deletion-requests", source: "form", label: "Delete Account → Deletion Request (PENDING, identity snapshot)" },
  { from: "/admin/students/deletion-requests", to: "/student/profile", source: "internal", label: "Reject → student remains active" },
  { from: "/admin/students/deletion-requests", to: "/login", source: "redirect", label: "Approve → Anonymization + Auth Revocation → old session forced to Login" },
  { from: "/login", to: "/student/dashboard", source: "form", label: "Same email/phone/Google after deletion → New Registration → New Student Identity" },

  // --- Commerce / Razorpay (lib/payments/*) ---------------------------------
  // Admin Payment Control Center tabs (?tab=products|coupons|orders|
  // transactions|subscriptions|invoices|gateway|webhooks|reconciliation) link
  // into these editors/detail pages (app/admin/(dashboard)/payments/_components).
  { from: "/admin/payments", to: "/admin/payments/products/[id]", source: "card", label: "Products & Pricing (canonical price source)" },
  { from: "/admin/payments", to: "/admin/payments/coupons/[id]", source: "card", label: "Coupons" },
  { from: "/admin/payments", to: "/admin/payments/orders/[id]", source: "card", label: "Orders / Transactions / Refunds / Reconciliation" },
  { from: "/admin/payments", to: "/admin/students/[id]", source: "card", label: "Entitlements → student payment profile" },
  { from: "/admin/payments/orders/[id]", to: "/admin/payments", source: "form", label: "Razorpay Refund API + refund.* webhook / Reconcile (server re-read)" },
  { from: "/admin/students/[id]", to: "/admin/payments/orders/[id]", source: "card", label: "Payments & Access: grant/revoke entitlement, purchase history" },
  // Pricing set in Admin is what the student checkout shows (server-computed).
  { from: "/admin/payments/products/[id]", to: "/student/checkout/[code]", source: "admin-config", label: "Server-side price / sale / access duration" },
  { from: "/admin/payments/coupons/[id]", to: "/student/checkout/[code]", source: "admin-config", label: "Server-side coupon validation" },
  // Student checkout flow (app/student/(dashboard)/checkout/*).
  { from: "/student/plans", to: "/student/checkout/[code]", source: "card", label: "View & Buy" },
  { from: "/student/checkout/[code]", to: "/student/checkout/result/[orderId]", source: "form", label: "Razorpay: Create Order → Checkout → Verify signature (server)" },
  { from: "/student/checkout/result/[orderId]", to: "/student/subscriptions", source: "button", label: "Entitlement active (webhook/reconcile restores if callback lost)" },
  { from: "/student/checkout/result/[orderId]", to: "/student/payments", source: "button", label: "Invoice" },
  { from: "/student/subscriptions", to: "/student/checkout/[code]", source: "button", label: "Renew" },
  { from: "/student/dashboard", to: "/student/subscriptions", source: "card", label: "Active subscription / expiry warning" },
  // Test Access Gate (lib/payments/access.ts via lib/test-attempt.ts start*):
  // a denied start redirects to the unlocking product's checkout.
  { from: "/student/test-series", to: "/student/checkout/[code]", source: "button", label: "Test Access Gate: Unlock / Renew" },
  { from: "/student/exams/[examId]", to: "/student/checkout/[code]", source: "redirect", label: "Test Access Gate: PAYMENT_REQUIRED" },
  { from: "/student/attempt/[attemptId]/run", to: "/student/checkout/[code]", source: "button", label: "Test Access Gate: locked attempt" },

  // Note: /login -> /student/dashboard on successful sign-in is already
  // captured by the tree edge (Student Dashboard's parentRoute is /login in
  // lib/routes.ts), so it's intentionally not duplicated here.

  // app/admin/login/actions.ts:22 — signIn("credentials", { redirectTo:
  // callbackUrl.startsWith("/admin") ? callbackUrl : "/admin" }).
  { from: "/admin/login", to: "/admin", source: "redirect", label: "Successful sign-in" },
  // middleware.ts — every unauthenticated /admin/* request is redirected to
  // /admin/login (?callbackUrl=…). This is the login page's real entry point;
  // without it the page looked like it had "no incoming links" and was
  // misreported as Broken even though the auth flow works.
  { from: "/admin", to: "/admin/login", source: "redirect", label: "Unauthenticated admin request (middleware)" },

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
