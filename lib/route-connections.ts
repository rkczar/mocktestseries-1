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
  // Profile -> Delete Account files one PENDING DeletionRequest. MASTER_ADMIN
  // reviews it (FULL_ADMIN is read-only); Reject leaves the account active.
  // Approve, in one transaction: identity audit snapshot (name, Student ID,
  // full email/phone, login methods) + course/product snapshot -> releases
  // email/phone/Google link -> status DELETED, which revokes every session
  // (jwt callback re-checks status on each auth(); pages/actions -> /login,
  // APIs -> 401). The record then appears under Deleted Students. The same
  // email/phone/Google may register later as a NEW student with a new ID.
  { from: "/student/profile", to: "/admin/students/deletion-requests", source: "form", label: "Delete Account → Deletion Request (PENDING)" },
  { from: "/admin/students/deletion-requests", to: "/student/profile", source: "internal", label: "Reject → Student remains Active" },
  { from: "/admin/students/deletion-requests", to: "/admin/students/deleted", source: "internal", label: "Approve → Identity Audit Snapshot → Course/Product Snapshot → Auth Revocation → Account Deleted → Deleted Students History" },
  { from: "/admin/students/deletion-requests", to: "/login", source: "redirect", label: "Approve → Old Session → Login" },
  { from: "/login", to: "/student/dashboard", source: "form", label: "Same Email / Phone / Google → New Student Registration → New Student ID → Default Exam Enrollment (RUHS MO, idempotent)" },
  { from: "/student/dashboard", to: "/student/exams", source: "card", label: "Your Active Exam (default-enrolled) · My Exams" },
  { from: "/student/dashboard", to: "/student/subject-test", source: "card", label: "Start Practicing: Subject Test" },
  { from: "/student/dashboard", to: "/student/test-series", source: "card", label: "Start Practicing: Test Series / Test Schedule (Scheduled Mock Tests)" },
  { from: "/student/dashboard", to: "/student/custom-module", source: "card", label: "Start Practicing: Custom Module" },
  { from: "/student/dashboard", to: "/student/history", source: "card", label: "Your Progress & Tools: History" },
  { from: "/student/dashboard", to: "/student/test-series/[mockTestId]", source: "card", label: "Next Test → Mock Test Details (Start)" },
  { from: "/student/subject-test", to: "/student/subject-test/[examId]", source: "card", label: "Choose exam → Subject Test builder" },
  { from: "/student/subject-test/[examId]", to: "/student/attempt/[attemptId]", source: "form", label: "Subject → eligible count → effective = min(requested, available) → TestAttempt (0 available: blocked)" },

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
  { from: "/exams/[slug]/syllabus", to: "/student/subject-test/[examId]", source: "button", label: "Practice by subject" },
  { from: "/exams/[slug]/question-bank", to: "/student/subject-test/[examId]", source: "button", label: "Practice by subject" },
  { from: "/exams/[slug]", to: "/student/subject-test/[examId]", source: "card", label: "Subject card" },

  // --- Mock Test Series funnel (lib/mock-series.ts is the single source) ----
  // Canonical public page /exams/[slug]/mock-test-series (the old
  // /exams/[slug]/mock-tests 301s there via next.config.ts). Every price,
  // count and CTA below is computed from the canonical TestSeries + Product.
  { from: "/", to: "/exams/[slug]/mock-test-series", source: "cta", label: "Homepage offer: Mock Test Promotion / Test Series / Featured Exam → View Mock Test Series (real counts + Product price)" },
  { from: "/", to: "/exams/[slug]/mock-test-series", source: "header", label: "Header / Footer links (Admin → Website → Homepage → Header/Footer)" },
  { from: "/exams", to: "/exams/[slug]", source: "card", label: "Exam catalog card (shows series planned/available)" },
  { from: "/exams/[slug]", to: "/exams/[slug]/mock-test-series", source: "cta", label: "View Mock Test Series (hero, sub-nav, series card)" },
  { from: "/exams/[slug]/mock-test-series", to: "/exams/[slug]", source: "internal", label: "Breadcrumb / Related: Exam overview" },
  { from: "/exams/[slug]/mock-test-series", to: "/exams/[slug]/previous-year-papers", source: "internal", label: "PYQ section / Related" },
  { from: "/exams/[slug]/mock-test-series", to: "/exams/[slug]/syllabus", source: "internal", label: "Syllabus Coverage / Related" },
  { from: "/exams/[slug]/mock-test-series", to: "/exams/[slug]/exam-pattern", source: "internal", label: "Related: Exam pattern" },
  { from: "/exams/[slug]/mock-test-series", to: "/exams/[slug]/question-bank", source: "internal", label: "Related: Question bank" },
  { from: "/exams/[slug]/previous-year-papers", to: "/exams/[slug]/mock-test-series", source: "card", label: "Mock Test Series card" },
  { from: "/exams/[slug]/syllabus", to: "/exams/[slug]/mock-test-series", source: "card", label: "Mock Test Series card" },
  { from: "/exams/[slug]/exam-pattern", to: "/exams/[slug]/mock-test-series", source: "card", label: "Mock Test Series card" },
  { from: "/exams/[slug]/question-bank", to: "/exams/[slug]/mock-test-series", source: "card", label: "Mock Test Series card" },
  { from: "/exams/[slug]/mock-test-series", to: "/login", source: "cta", label: "Start Free / Unlock (logged out, callbackUrl → checkout or Test Series)" },
  { from: "/exams/[slug]/mock-test-series", to: "/student/checkout/[code]", source: "cta", label: "Unlock Complete Series (PAID mode, not yet entitled)" },
  { from: "/exams/[slug]/mock-test-series", to: "/student/test-series", source: "cta", label: "Open Test Series (entitled, or FREE mode)" },
  { from: "/exams/[slug]/mock-test-series", to: "/student/attempt/resume", source: "button", label: "Start Mock (released mocks)" },
  { from: "/student/checkout/result/[orderId]", to: "/student/test-series", source: "button", label: "Entitlement → Student Test Series (Open Product)" },
  { from: "/student/test-series", to: "/student/test-series/[mockTestId]", source: "card", label: "Mock card → Details / Instructions (no attempt created yet)" },
  { from: "/student/exams/[examId]", to: "/student/test-series/[mockTestId]", source: "button", label: "Mock Test → View & Start (Details / Instructions)" },
  { from: "/student/test-series/[mockTestId]", to: "/student/attempt/[attemptId]/run", source: "form", label: "Start / Resume → canonical TestAttempt → Player (availability, attempt policy, Test Access Gate enforced server-side)" },
  { from: "/student/test-series/[mockTestId]", to: "/student/checkout/[code]", source: "button", label: "Test Access Gate: Unlock / Renew" },
  { from: "/student/dashboard", to: "/student/analytics", source: "card", label: "Performance Analytics (after Result / Review / Ask AI — daily AI quota by plan)" },
  // Admin side of the same series.
  { from: "/admin/exams/test-series/[id]", to: "/admin/tests/mock/[id]", source: "button", label: "Mock Tests → Edit (details, coverage, questions, schedule, resources, publish)" },
  { from: "/admin/exams/test-series/[id]", to: "/admin/tests/scheduled", source: "button", label: "Schedule → Bulk Schedule Upload" },
  { from: "/admin/exams/test-series/[id]", to: "/admin/payments/products/[id]", source: "button", label: "Pricing & Access → Edit price" },
  { from: "/admin/tests/mock/[id]", to: "/exams/[slug]/mock-test-series", source: "admin-config", label: "Published mocks → public schedule" },

  // --- Consolidated Admin Tests architecture --------------------------------
  // Test Series → Mock Test → Questions (Question Bank / Bulk Import) →
  // Schedule → Access/Result → Publish → Student Attempt → Result → Review.
  // Bulk import hrefs carry ?examId=&target=MOCK_TEST&mockTestId= so the one
  // Question Bank importer opens with the Exam and target Mock Test set.
  { from: "/admin/tests", to: "/admin/tests/mock/new", source: "button", label: "+ Create Mock Test" },
  { from: "/admin/tests", to: "/admin/tests/mock/[id]", source: "button", label: "All Tests → Edit / Manage Questions" },
  { from: "/admin/tests/mock", to: "/admin/tests/mock/new", source: "button", label: "+ Create Mock Test" },
  { from: "/admin/tests/mock", to: "/admin/tests/mock/[id]", source: "button", label: "Edit / Manage Questions / Preview" },
  { from: "/admin/exams/test-series/[id]", to: "/admin/tests/mock/new", source: "button", label: "Add Mock Test (same canonical editor)" },
  { from: "/admin/tests/mock/new", to: "/admin/tests/mock/[id]", source: "redirect", label: "Save Draft → Step 3 Questions" },
  { from: "/admin/tests/mock/[id]", to: "/admin/questions/bulk-import", source: "button", label: "Questions → Bulk Import Questions (exam + target preselected)" },
  { from: "/admin/exams/test-series/[id]", to: "/admin/questions/bulk-import", source: "button", label: "Mock row → Bulk Import Questions" },
  { from: "/admin/questions/bulk-import", to: "/admin/tests/mock/[id]", source: "redirect", label: "Import Target = Mock Test → Question Bank → attach → return to Mock Test Questions" },
  { from: "/admin/tests/mock/[id]", to: "/admin/tests/mock/[id]/preview", source: "button", label: "Preview (student view, published questions in order)" },
  { from: "/admin/tests/scheduled", to: "/admin/tests/mock/[id]", source: "button", label: "Scheduled / fixed-window mock → Edit schedule" },
  { from: "/admin/tests/mock/[id]", to: "/student/test-series", source: "admin-config", label: "Published mock → Student Test Series (Upcoming / Live Now / Closed)" },
  // Retired product routes — permanent redirects, kept so old links never 404.
  { from: "/admin/tests/grand", to: "/admin/tests", source: "redirect", label: "Retired Grand Test → Mock Tests" },
  { from: "/admin/tests/live", to: "/admin/tests", source: "redirect", label: "Retired Live Test → Mock Tests" },
  { from: "/admin/tests/custom", to: "/admin/tests", source: "redirect", label: "Retired Custom Test → Mock Tests" },
  { from: "/admin/tests/random", to: "/admin/tests", source: "redirect", label: "Retired Random Test → Mock Tests" },
  { from: "/admin/tests/builder", to: "/admin/tests", source: "redirect", label: "Retired Test Builder → Mock Tests" },
  { from: "/student/live-tests", to: "/student/test-series", source: "redirect", label: "Retired Live Tests → Test Series" },
  { from: "/admin/payments/products/[id]", to: "/exams/[slug]/mock-test-series", source: "admin-config", label: "Price / MRP / sale → homepage, Exam Hub, series page (one source)" },

  // --- Ask AI → AI Question Variants (lib/ai-variant.ts ensureQuestionVariants) ---
  // Student Result / Review → Ask AI {Simple Explanation, Exam Trick / Memory
  // Aid, Step-by-Step, AI Question Variants}. Variants: existing-variant check
  // → generate only the missing count → validate + deduplicate → saved to the
  // canonical Question Bank as Source → AI01…AI05 → displayed inline.
  { from: "/student/attempt/[attemptId]/review", to: "/admin/questions", source: "internal", label: "Ask AI → AI Question Variants: existing check → generate missing → validate + dedupe → Question Bank (Source → AI01–AI05) → inline display" },
  { from: "/admin/questions", to: "/admin/ai/variants", source: "button", label: "Source question → View AI variants / filter: AI Variant, Has AI Variants" },
  { from: "/admin/ai/variants", to: "/student/attempt/[attemptId]/review", source: "admin-config", label: "AI Variant Monitoring / Quality Control (archive, restore, generate missing) — no approval needed" },

  // --- Student auth: ONE canonical Student Login (/login) -------------------
  // Protected /student/* → middleware → /login?callbackUrl=<path+query> →
  // Google / Phone OTP / Password → lib/student-callback.ts → original
  // destination. Legacy aliases are permanent redirects into /login (query
  // preserved); /student_login.php etc. come from lib/legacy-redirects.ts.
  // Admin auth (/admin/login) is a separate NextAuth instance and cookie.
  { from: "/student/login", to: "/login", source: "redirect", label: "Legacy alias → canonical Student Login (308, query preserved)" },
  { from: "/student/register", to: "/login", source: "redirect", label: "Legacy alias → /login?tab=register (308, query preserved)" },
  { from: "/student/dashboard", to: "/login", source: "redirect", label: "Protected Student route, not signed in → /login?callbackUrl=<original path+query>" },
  { from: "/login", to: "/student/attempt/resume", source: "form", label: "Google / Phone OTP / Password → callbackUrl → original Student destination" },

  // app/student/attempt/resume/page.tsx — resumes into the canonical
  // TestAttempt flow, same destination the authenticated student flow uses.
  { from: "/student/attempt/resume", to: "/student/attempt/[attemptId]", source: "redirect", label: "Resumes into canonical TestAttempt" },

  // middleware.ts redirects an unauthenticated /student/* request (including
  // /student/attempt/resume) to /login with callbackUrl set.
  { from: "/student/attempt/resume", to: "/login", source: "redirect", label: "Unauthenticated → login (callbackUrl preserved)" },
];

/**
 * Non-page nodes drawn as their own diagram node: the canonical Practice OMR
 * download (app/api/student/test-resources/[id], which brands every
 * OMR_TEMPLATE via lib/omr-sheet.ts — exactly one generator, so every OMR CTA
 * points at it), plus in-page flows that have no URL of their own (`#` nodes).
 */
export const RESOURCE_NODES = [
  {
    route: "/api/student/test-resources/[id]",
    pageName: "Canonical OMR Generator → Branded OMR PDF (MockTestSeries.in link · watermark · website link · Instagram link)",
    module: "Practice Resources",
  },
  {
    // app/login/login-screen.tsx ForgotPasswordFlow + lib/password-reset.ts.
    route: "/login#forgot-password",
    pageName: "Forgot Password → Verify (Phone OTP to registered mobile) → Reset Password (New + Confirm) → Login",
    module: "Student Auth",
  },
  {
    // app/student/(dashboard)/dashboard/dashboard-announcements.tsx — StudentNotificationState.dismissedAt.
    route: "/student/dashboard#announcements",
    pageName: "Dashboard Announcement (✕ Per-student Dismiss, persisted — Admin announcement untouched)",
    module: "Student Dashboard",
  },
] as const;

ROUTE_CONNECTIONS.push(
  { from: "/login", to: "/login#forgot-password", source: "button", label: "Password login → Forgot Password?" },
  { from: "/login#forgot-password", to: "/login", source: "form", label: "Password reset successful → Return to Login (new password)" },
  {
    from: "/student/dashboard",
    to: "/student/dashboard#announcements",
    source: "card",
    label: "Welcome → Announcement → Active Examination → Performance Summary → Progress & Tools → Practice / Tests → Recent Tests",
  },
);

const OMR_GENERATOR = RESOURCE_NODES[0].route;
ROUTE_CONNECTIONS.push(
  // components/homepage/homepage-view.tsx — mid-page Practice OMR section (components/omr/omr-practice-card.tsx).
  { from: "/", to: OMR_GENERATOR, source: "card", label: "Homepage: Practice OMR Sheet → Download OMR Sheet (no login)" },
  // app/student/(dashboard)/dashboard/active-exam-dashboard.tsx — card after the summary tiles.
  { from: "/student/dashboard", to: OMR_GENERATOR, source: "card", label: "Student Dashboard: Practice OMR Sheet → Download OMR Sheet" },
  // Existing OMR CTAs.
  { from: "/student/omr", to: OMR_GENERATOR, source: "button", label: "Practice with OMR → Download OMR Sheet" },
  { from: "/exams/[slug]", to: OMR_GENERATOR, source: "button", label: "Public Exam Page → Download OMR Sheet" },
  { from: "/exams/[slug]/mock-test-series", to: OMR_GENERATOR, source: "button", label: "Mock Test Series → Practice OMR → Download OMR" },
  { from: "/student/attempt/[attemptId]/result", to: OMR_GENERATOR, source: "button", label: "Result → Print Practice Kit → Download OMR Sheet" },
);

/**
 * Ordered student journey for the Flow view (Section 6A). Each route must
 * exist in ROUTE_MANIFEST with status "CONNECTED" — this is a curated
 * narrative ordering, not a discovery, so it stays honest about what's
 * actually built today.
 */
/** Homepage → Exam Hub → Mock Test Series → checkout → entitlement → attempt → review (Website Diagram "Mock Series Funnel" tab). */
export const MOCK_SERIES_FUNNEL_FLOW: string[] = [
  "/",
  "/exams",
  "/exams/[slug]",
  "/exams/[slug]/mock-test-series",
  "/exams/[slug]/previous-year-papers",
  "/exams/[slug]/syllabus",
  "/exams/[slug]/exam-pattern",
  "/exams/[slug]/question-bank",
  "/login",
  "/student/plans",
  "/admin/payments/products/[id]",
  "/student/checkout/[code]",
  "/student/checkout/result/[orderId]",
  "/student/test-series",
  "/student/test-series/[mockTestId]",
  "/student/attempt/[attemptId]/run",
  "/student/attempt/[attemptId]/result",
  "/student/attempt/[attemptId]/review",
  "/student/analytics",
];

export const STUDENT_JOURNEY_FLOW: string[] = [
  "/",
  "/login",
  "/student/dashboard",
  "/student/exams",
  "/student/exams/[examId]",
  "/student/subject-test",
  "/student/subject-test/[examId]",
  "/student/test-series",
  "/student/test-series/[mockTestId]",
  "/student/custom-module",
  "/student/omr",
  "/student/analytics",
  "/student/attempt/[attemptId]",
  "/student/attempt/[attemptId]/run",
  "/student/attempt/[attemptId]/result",
  "/student/attempt/[attemptId]/review",
  "/student/history",
];
