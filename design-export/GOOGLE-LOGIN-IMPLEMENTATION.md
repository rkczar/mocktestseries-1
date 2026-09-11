# Google Login — implementation blueprint for MockTestSeries.in

Status: NOT YET BUILT. There is no server, `/login` route, or auth backend in this
project yet (it's a design prototype). This doc is the spec for whoever implements
it in the real codebase (Claude Code / your Next.js + Hostinger VPS build).

## Root-cause note
No audit could find a broken Google Login in production because no Google Login
code exists anywhere yet — not in this design project, and not in the connected
GitHub repo (`rkczar/mocktestseries-1`, currently empty, no commits). There is
nothing to "re-verify"; this is a from-scratch build.

## Recommended architecture: Google Identity Services (GIS), ID-token credential flow
Do NOT build a redirect-based Authorization Code flow through `/login` as a
callback URL — that requires exchanging a code for tokens server-side and makes
`/login` do double duty as a page and an OAuth callback, which is exactly the
"convenient but wrong" trap the spec warns about.

Use GIS's credential flow instead: the button renders client-side, the user picks
an account, Google returns a signed **ID token** directly to the page via a JS
callback (no redirect hop, no code exchange, no server-side token endpoint call
needed). The backend's only job is to verify that ID token. This is Google's
current recommended web flow and needs zero callback URL.

- Authorized JavaScript origin: `https://mocktestseries.in` — required.
- Authorized redirect URI: **not needed** for this flow. Leave `https://mocktestseries.in/login` configured only if a future feature needs Authorization Code flow; it plays no role here.

## Flow
```
Student clicks "Continue with Google" (Student-Login page)
  → GIS renders Google's account picker (popup/One Tap)
  → Google returns a signed ID token (JWT) to the browser callback
  → Browser POSTs { credential: idToken } to POST /api/auth/google
  → Server verifies the token (signature, issuer, audience, expiry, email_verified)
  → Server looks up student by verified email
      found    → reuse existing student row, do not overwrite profile fields silently
      not found → create new student row (role: student, provider: google)
  → Server issues the app's normal session (httpOnly secure cookie / JWT — match whatever email+OTP login already issues)
  → Response tells client to redirect to Student Dashboard
```

## Frontend
```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
```
Load this script exactly once per page (guard against double-mount in React
StrictMode / re-renders — call `google.accounts.id.initialize()` only if not
already initialized, e.g. a module-level flag).

```js
google.accounts.id.initialize({
  client_id: "855083060212-7i5b04k0vgdjpjuv36btpv7lsm1qdkge.apps.googleusercontent.com",
  callback: handleCredentialResponse,
});
google.accounts.id.renderButton(document.getElementById("google-btn"), { theme: "outline", size: "large" });

async function handleCredentialResponse(response) {
  const r = await fetch("/api/auth/google", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential: response.credential }),
  });
  if (!r.ok) { showError("Google Sign-In could not be completed. Please try again."); return; }
  window.location.href = "/dashboard";
}
```
`GOOGLE_CLIENT_ID` is not a secret — it's fine in frontend code/env (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`).

## Backend — token verification (never decode-and-trust)
Node/Next.js example using `google-auth-library`:
```js
import { OAuth2Client } from "google-auth-library";
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export async function verifyGoogleCredential(idToken) {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID, // must equal 855083060212-...apps.googleusercontent.com
  });
  const payload = ticket.getPayload();
  if (!payload.email_verified) throw new Error("Email not verified with Google");
  return { email: payload.email, name: payload.name, googleSub: payload.sub };
}
```
This library validates signature, issuer (`accounts.google.com`), audience, and
expiry for you — do not hand-roll JWT decoding.

## Account handling
- Lookup key: verified email (case-insensitive). Match the app's existing
  account-linking rule if email/password accounts already exist with that email —
  do not silently merge without that rule.
- New account: create with `authProvider: "google"`, `googleSub` stored for
  future lookups, no password set.
- Never set `role: admin` from this path. Google Login only ever creates/loads a
  **student** row; keep it on a separate code path from `/admin/login`.

## Secrets
```
GOOGLE_CLIENT_ID=855083060212-7i5b04k0vgdjpjuv36btpv7lsm1qdkge.apps.googleusercontent.com   # public, fine in frontend
GOOGLE_CLIENT_SECRET=<rotate this — the old one is compromised, never commit it>            # server-side env only, unused by the ID-token flow above unless you later add Authorization Code flow
```
Not needed by the ID-token flow at all (no code-exchange step calls Google's token
endpoint), but rotate it anyway since it was exposed, and keep it out of git either
way. Add `GOOGLE_CLIENT_SECRET` to `.gitignore`d `.env` / your host's secret
manager, never to source.

## Session
Reuse whatever session mechanism email/password login already sets (cookie or
JWT) — Google Login should produce the identical session shape, so protected
routes, refresh-persistence, and logout all keep working unchanged.

## Test checklist (run these once the code above is deployed)
- [ ] Existing Google student → dashboard, no duplicate row created
- [ ] New Google student → account created once, dashboard
- [ ] Refresh after login → still authenticated
- [ ] Logout → protected routes redirect to login
- [ ] Login again with same Google account → same student row reused
- [ ] Email/password login, phone OTP, admin login all still work unchanged
- [ ] Browser network tab: `GOOGLE_CLIENT_SECRET` never appears in any response
