import type { RoleName } from "@prisma/client";

/**
 * Permission keys used by lib/rbac.ts. This is intentionally a small, real
 * set scoped to what's actually enforced in Phases 1-5 (Website, Exams
 * stubs, Users & Access) — the full granular Permissions UI (Section 52) is
 * built out in Phase 11. MASTER_ADMIN always has every permission.
 *
 * FULL_ADMIN (database value "ADMIN", see RoleName in schema.prisma) is
 * GLOBAL READ-ONLY: it holds no manage/publish key at all, only the *_VIEW
 * keys below (see DEFAULT_ROLE_PERMISSIONS). Server routes must keep gating
 * every create/edit/delete/import/publish/link/unlink mutation behind
 * requirePermission(...) — never rely on the admin UI merely hiding a button.
 */
export const PERMISSIONS = {
  WEBSITE_MANAGE: "website:manage",
  HOMEPAGE_PUBLISH: "homepage:publish",
  EXAMS_MANAGE: "exams:manage",
  USERS_MANAGE: "users:manage",
  SETTINGS_MANAGE: "settings:manage",
  QUESTIONS_MANAGE: "questions:manage",
  TESTS_MANAGE: "tests:manage",
  CUSTOM_MODULES_MANAGE: "custom-modules:manage",
  STUDENTS_MANAGE: "students:manage",
  ANNOUNCEMENTS_MANAGE: "announcements:manage",
  COMMUNICATIONS_MANAGE: "communications:manage",
  // Read access to the Communications inbox/detail (MASTER_ADMIN + FULL_ADMIN).
  // Status/notes/assignment changes stay on COMMUNICATIONS_MANAGE.
  COMMUNICATIONS_VIEW: "communications:view",
  // Deliberately NOT given to FULL_ADMIN below, even though it already has
  // WEBSITE_MANAGE — the public-page on/off switch (Admin -> Website ->
  // Pages & Content) is MASTER_ADMIN-only per spec; FULL_ADMIN can still
  // view the page list, just not toggle it.
  PAGE_VISIBILITY_MANAGE: "page-visibility:manage",
  // Site-wide SEO defaults (Admin -> SEO). Same MASTER_ADMIN-only pattern as
  // PAGE_VISIBILITY_MANAGE above — FULL_ADMIN can view the page but every
  // mutation is blocked server-side, not just hidden in the UI.
  SEO_MANAGE: "seo:manage",
  // Gemini Model Pool (Admin -> AI -> Settings): which models are enabled,
  // and the primary/fallback priority order every new Ask AI/Variant
  // generation follows. Same MASTER_ADMIN-only pattern as SEO_MANAGE above —
  // FULL_ADMIN can view the pool and model-health table, not change them.
  AI_MODEL_POOL_MANAGE: "ai-model-pool:manage",
  // Test Series Control Center (Test Series, Mock Test Builder, Schedule
  // Manager, Resources — Paper/Solution PDF + OMR templates). Same
  // MASTER_ADMIN-only pattern as SEO_MANAGE/AI_MODEL_POOL_MANAGE above.
  // Deliberately NOT TESTS_MANAGE (which FULL_ADMIN already holds, and which
  // Live Test keeps using unchanged) — the Scheduled Mock Test Series spec
  // requires FULL_ADMIN to be read-only here specifically, so Mock Test
  // create/edit/publish/schedule/resource mutations move onto this new key
  // instead of TESTS_MANAGE.
  TEST_SERIES_MANAGE: "test-series:manage",
  // Payments Control Center (Admin -> Payments). PAYMENTS_VIEW is global
  // read access (MASTER_ADMIN + FULL_ADMIN); PAYMENTS_MANAGE — payment mode,
  // pricing, coupons, gateway credentials, entitlement grant/revoke,
  // refunds, reconciliation repair, invoice settings — is MASTER_ADMIN-only,
  // enforced server-side on every mutation.
  PAYMENTS_VIEW: "payments:view",
  PAYMENTS_MANAGE: "payments:manage",
  // Backup & Disaster Recovery Center (Admin -> Backup). BACKUP_VIEW is
  // global read access to storage/backup/release inventory, history and
  // verification status (MASTER_ADMIN + FULL_ADMIN). BACKUP_MANAGE — create,
  // download, verify, delete, cleanup, release deletion, restore — is
  // MASTER_ADMIN-only and enforced server-side on every action/route.
  BACKUP_VIEW: "backup:view",
  BACKUP_MANAGE: "backup:manage",
  // Approve/reject student account-deletion requests (Admin -> Students ->
  // Deletion Requests). Destructive and irreversible, so MASTER_ADMIN-only:
  // FULL_ADMIN keeps STUDENTS_MANAGE (and can view the queue) but every
  // approve/reject is refused server-side without this key.
  STUDENT_DELETION_MANAGE: "student-deletion:manage",
  // Read the retained deletion audit records (Admin -> Students -> Deletion
  // Requests + detail view), which hold a deleted student's real name,
  // email and phone. MASTER_ADMIN + FULL_ADMIN (global read-only); TEACHER
  // is refused server-side and never receives the contact data.
  STUDENT_DELETION_VIEW: "student-deletion:view",
  // Bulk Import rollback (Admin -> Questions -> Bulk Import -> Import History
  // -> run detail -> Delete Questions Created By This Import). Destructive,
  // so MASTER_ADMIN-only: FULL_ADMIN can open the run and its impact
  // analysis but every delete/archive is refused server-side without this
  // key (TEACHER's QUESTIONS_MANAGE does not grant it either).
  IMPORT_ROLLBACK_MANAGE: "import-rollback:manage",
  // Platform / Emergency Controls (Admin -> System -> Platform Controls):
  // pause registrations, student login, new payments, new test starts or AI
  // generation; Maintenance Mode; Emergency Lockdown. VIEW is read access to
  // the control states and history (MASTER_ADMIN + FULL_ADMIN). MANAGE —
  // every change — is MASTER_ADMIN-only and enforced server-side.
  PLATFORM_CONTROLS_VIEW: "platform-controls:view",
  PLATFORM_CONTROLS_MANAGE: "platform-controls:manage",
  // Outbound email (Admin -> Communications -> Email): compose, campaigns,
  // template edits, test emails and the production-sending switch.
  // MASTER_ADMIN-only, enforced server-side on every action. Reading the
  // Email tabs (logs, campaigns, settings status) uses COMMUNICATIONS_VIEW.
  EMAIL_MANAGE: "email:manage",
  // Duplicate-number recovery requests (Admin -> Students -> Account
  // Recovery). VIEW shows both accounts' real contact details (MASTER_ADMIN +
  // FULL_ADMIN). MANAGE — approve (moves the mobile number) / reject — is
  // MASTER_ADMIN-only, enforced server-side.
  ACCOUNT_RECOVERY_VIEW: "account-recovery:view",
  ACCOUNT_RECOVERY_MANAGE: "account-recovery:manage",
  // Instagram Content Studio (Admin -> Instagram): browse PYQ / Most Missed
  // questions, create and edit carousel drafts, run AI generation, approve
  // (Mark Ready), edit studio settings and publish to Instagram (after an
  // explicit confirmation; the publish actions also require the MASTER_ADMIN
  // role itself). MASTER_ADMIN-only, enforced server-side on every page,
  // action and the slide-image route.
  INSTAGRAM_MANAGE: "instagram:manage",
  // AI Engine (Admin -> AI: Providers, Models, Features, Analytics, Budgets,
  // History). VIEW = read the cost/usage pages (MASTER_ADMIN + FULL_ADMIN).
  // MANAGE — OpenRouter key, model approval, feature routing, budgets,
  // emergency stop, exchange rate, paid model evaluation — is MASTER_ADMIN-only,
  // enforced server-side on every action.
  AI_ENGINE_VIEW: "ai-engine:view",
  AI_ENGINE_MANAGE: "ai-engine:manage",
  // AI Question Importer (Admin -> AI Question Importer). VIEW = read jobs,
  // costs, vault and storage reports (MASTER_ADMIN + FULL_ADMIN). USE =
  // upload, process (paid AI within the budgets), review, import and publish
  // (MASTER_ADMIN). MANAGE = importer settings, budgets, privacy, retention
  // and storage cleanup (MASTER_ADMIN). Enforced server-side everywhere.
  AI_IMPORTER_VIEW: "ai-importer:view",
  AI_IMPORTER_USE: "ai-importer:use",
  AI_IMPORTER_MANAGE: "ai-importer:manage",
  // SEO Intelligence (Admin -> SEO -> Intelligence): Search Console + GA4
  // data pulled through ONE shared, read-only Google connection. VIEW = read
  // the connection status and the synced reports (every admin role, TEACHER
  // included). MANAGE — connect, disconnect, manual sync — is
  // MASTER_ADMIN-only, enforced server-side on every action and the OAuth
  // callback route.
  SEO_INTEL_VIEW: "seo-intel:view",
  SEO_INTEL_MANAGE: "seo-intel:manage",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const DEFAULT_ROLE_PERMISSIONS: Record<RoleName, PermissionKey[]> = {
  MASTER_ADMIN: Object.values(PERMISSIONS),
  // FULL_ADMIN is GLOBAL READ-ONLY: it may open every Admin page, record,
  // report, status and history view, but holds NO manage/publish key, so
  // every mutation (requirePermission on each Server Action / route) is
  // refused server-side. Only *_VIEW keys, for the few surfaces whose read
  // access is itself restricted (payments, backup inventory, deletion audit
  // records, communications inbox).
  FULL_ADMIN: [
    PERMISSIONS.PAYMENTS_VIEW,
    PERMISSIONS.BACKUP_VIEW,
    PERMISSIONS.STUDENT_DELETION_VIEW,
    PERMISSIONS.COMMUNICATIONS_VIEW,
    PERMISSIONS.PLATFORM_CONTROLS_VIEW,
    PERMISSIONS.ACCOUNT_RECOVERY_VIEW,
    PERMISSIONS.AI_ENGINE_VIEW,
    PERMISSIONS.AI_IMPORTER_VIEW,
    PERMISSIONS.SEO_INTEL_VIEW,
  ],
  TEACHER: [PERMISSIONS.EXAMS_MANAGE, PERMISSIONS.QUESTIONS_MANAGE, PERMISSIONS.SEO_INTEL_VIEW],
};
