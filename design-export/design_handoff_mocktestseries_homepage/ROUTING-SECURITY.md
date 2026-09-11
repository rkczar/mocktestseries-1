# Routing & Security Specification — MockTestSeries.in

Companion to `ARCHITECTURE.md`. The URL is simple for humans; the security is enforced in the
application and database layers, never by hiding UI.

---

## 1. Public routes

| URL | Page | Auth |
|---|---|---|
| `/` | Homepage | none |
| `/login` | Student login | none |
| `/register` | Student registration | none |
| `/exams` | Exam listing (ACTIVE exams only) | none |
| `/exams/ruhs-mo` | Individual exam page (slug from the exam record) | none |
| `/tests` | Mock test catalogue | none |
| `/pricing` | Plans | none |
| `/upcoming-exams` | Exam calendar | none |
| `/about`, `/contact`, `/privacy`, `/terms` | Static pages | none |

## 2. Student routes (authenticated student session)

| URL | Page |
|---|---|
| `/dashboard` | Overview + navigation |
| `/profile`, `/profile/edit` | Candidate profile, edit |
| `/test-history` | All own attempts |
| `/tests/[test-slug]/instructions` | Entry direction (admin-authored per exam) |
| `/tests/attempt` | Active attempt (attempt held in the session, not the URL) |
| `/results/latest`, `/results/[result-slug]` | Result |
| `/results/[result-slug]/review` | Question-wise review |
| `/analysis` | Detailed analysis |
| `/saved` | Saved questions & mistake notebook |
| `/queries` | Own question queries |
| `/settings`, `/settings/delete-account` | Settings, privacy, deletion request |

**No database IDs in student URLs.** An attempt or result is addressed by an opaque, per-student
slug (or the current session), so `/results/8321` style enumeration is impossible. The server
resolves slug → attempt and re-checks ownership on every request.

## 3. Admin routes (separate auth realm)

| URL | Page | Minimum role |
|---|---|---|
| `/admin` | Admin login | none (rate-limited) |
| `/admin/dashboard` | Master dashboard | Admin |
| `/admin/exams`, `/admin/exams/[exam-slug]` | Exam management | Content Manager |
| `/admin/tests` | Test management | Content Manager |
| `/admin/questions`, `/admin/questions/import` | Question bank, bulk import | Content Manager |
| `/admin/students`, `/admin/students/[student-slug]` | Student management | Admin |
| `/admin/students/deletion-requests` | Deletion approvals | Master Admin |
| `/admin/question-queries` | Question queries | Reviewer |
| `/admin/ai-solutions` | AI solution manager | Admin |
| `/admin/appearance` | Frontend colors, fonts, buttons | Admin |
| `/admin/website-diagram` | Architecture map | Admin |
| `/admin/security`, `/admin/backup`, `/admin/system` | Security, backup, system | Master Admin |

`/admin/*` is excluded from `robots.txt` and the sitemap. Unauthenticated requests get the login
page or a 404-style response — never a redirect that confirms a route exists.

## 4. Middleware

`middleware.ts` matches `/admin/:path*` and every student route:

1. Student route without a student session → `/login?next=…`
2. `/admin/*` (except `/admin`) without an admin session carrying an allowed role → `/admin`
3. An admin session on a student route, or a student session on an admin route, is treated as
   unauthenticated — the two realms use separate cookies (`mts.student.session`, `mts.admin.session`)
   and separate Auth.js configurations.
4. Role check happens again inside every server action and route handler; middleware is the first
   gate, not the only one.

## 5. Role-based access control

| Role | Read | Write | Publish | Approve deletions | System |
|---|---|---|---|---|---|
| Master Admin | all | all | yes | yes | yes |
| Admin | all | most | yes | no | no |
| Content Manager | exams, questions, tests | same | yes | no | no |
| Teacher | assigned subjects/exams | own questions | no | no | no |
| Reviewer | questions, queries | query resolutions | no | no | no |
| Support | students (read), queries | query replies | no | no | no |

Permissions live in the database (`role` + optional per-entity grants) and are evaluated server-side.
Hidden buttons are a convenience, never the control.

## 6. Database rules

- `Student` can read/write only rows whose `studentId` equals the session subject: own profile,
  attempts, bookmarks, queries, deletion request.
- `TestAttempt`, `Question` answers and `AiSolution` are never exposed unfiltered; question
  `correctKey` and explanations are withheld until the attempt is submitted (or immediately, if the
  student chose per-question review — enforced server-side, not by the client).
- `AdminUser`, `AuditLog`, `DeletionRequest` are admin-realm only.
- Public reads are limited to published exams, published test metadata, syllabus cards,
  announcements, pricing and appearance settings.
- Every admin mutation writes an `AuditLog` row with actor, entity, diff and timestamp.

## 7. Sensitive data

Passwords are argon2id hashes, never returned by any endpoint. No token, API key, AI key, internal
ID or hash appears in a URL, in client JavaScript, or in a server response. Keys live in server-only
environment variables; the AI provider is called from the server, never the browser.

## 8. Sessions

JWT sessions with role claims, short access lifetime plus rotation, absolute expiry, secure +
httpOnly + sameSite cookies, distinct cookie names per realm, server-side revocation on logout and
on password change, and "sign out all devices" invalidating every session for that account.

## 9. Redirects

Legacy or technical URLs must 301 to the clean route rather than break:

```
/index.php, /index.html, /home        → /
/student.php, /student/login          → /login
/student/dashboard                    → /dashboard
/student/profile                      → /profile
/exam.php?id=1                        → /exams/ruhs-mo
/admin/login                          → /admin
/admin/queries                        → /admin/question-queries
/admin/ai                             → /admin/ai-solutions
/admin/diagram                        → /admin/website-diagram
```

No `.php`, `.html` or `.aspx` path is ever served to a user.

## 10. Production hardening

HTTPS with HSTS; secure cookies; `Content-Security-Policy`, `X-Content-Type-Options`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` (or CSP
`frame-ancestors 'none'`), `Permissions-Policy`; rate limiting on both login routes and on AI
requests; CSRF protection on all mutations; input validated with Zod on the server.

---

**Not yet true in these design files:** they are static mockups linked by filename
(`Homepage.dc.html`, `Student-Dashboard.dc.html`, …). The route column above is the target for the
Next.js build; the Website Diagram in the admin panel already shows these clean routes so the
mapping is unambiguous. The demo login (`student` / `Student@123`) must be removed before any
deployment.
