# Authentication — Production Specification

Source: `Student-Login.dc.html`, `GOOGLE-LOGIN-IMPLEMENTATION.md`, `api-management-data.js`,
ARCHITECTURE.md.

## Status: mostly design-only, one real security issue found
**None of the authentication in this project is functionally implemented against a real
backend.** Be explicit with any developer picking this up: nothing here is "already working
auth that just needs a database" — it is UI only, and one part of it (below) needs remediation
before anything is pushed to a public repo or a live server.

### ⚠️ Action required before going further
`Student-Login.dc.html` currently loads MSG91's OTP widget client-side with a **hardcoded
`tokenAuth` value inline in the page source**. Treat any credential ever pasted into a design
prototype as compromised: **rotate/regenerate that MSG91 token in the MSG91 dashboard before
production build starts**, and never place any provider secret (MSG91, Gemini, Razorpay, Google
OAuth client secret) directly in frontend source again — server-side env vars only, per
API-MANAGEMENT's own prototype-layer warning.

## Student Login (design-only)
Three tabs/modes in one screen: Password, Mobile OTP, Google.
- **Password mode**: username/password fields, "Forgot password?" link (no destination built),
  show/hide toggle, a visible demo-credentials hint box ("Username/Password — Temporary — to be
  replaced by OTP / email verification API") — i.e. the design itself documents that this is a
  placeholder, not real auth.
- **Mobile OTP mode**: phone entry → send OTP (via the MSG91 widget referenced above) → 6-digit
  code entry → verify, with resend cooldown and error/success states modeled in UI state only;
  no server-side OTP verification exists.
- **Google mode**: a "Continue with Google" button whose handler is literally `googleNotReady`
  and the page prints "Design preview only — Google Sign-In connects once the app is deployed
  with server-side verification." `GOOGLE-LOGIN-IMPLEMENTATION.md` is the从-scratch build spec
  for this (GIS credential/ID-token flow, not Authorization Code flow) — follow it as written;
  it correctly avoids ever needing a server-side client secret for this flow, but the OAuth
  **client ID** embedded there is not secret and can stay in frontend env; any **client secret**
  must never be committed.

## Registration / Forgot / Reset password
No registration form, no forgot-password flow, no reset-password screen exist as built pages —
only a "Create a free account" link with no destination. All ❌ missing.

## Admin Login
No admin login screen exists in the design at all. ARCHITECTURE.md specifies it must be a
completely separate Auth.js config, separate cookie, separate route
(`app/api/auth/admin/[...nextauth]`) from student auth, with role claims (ADMIN/SUPER_ADMIN)
re-verified server-side on every protected admin action. Build from the architecture doc, not
from any existing screen.

## Protected routes / role-based access
Not implemented anywhere (no middleware, no session checks) — this is a static prototype.
ARCHITECTURE.md's `middleware.ts` spec (redirect unauthenticated `/student/*` to
`/student/login`, unauthenticated/wrong-role `/admin/*` to `/admin/login`, cross-role sessions
treated as unauthenticated) is the intended real behavior — implement it exactly as specified
there, since no working reference exists to diverge from.

## Session
No session mechanism exists yet in either surface. Whatever is built for
email/password/OTP login must issue the same session shape Google Login later reuses (per
GOOGLE-LOGIN-IMPLEMENTATION.md), so all three paths share one protected-route mechanism.
