# Mandatory mobile OTP verification

Every student must prove an Indian mobile number (+91) with an OTP before using
tests, results, progress or the dashboard. Controlled by one Admin switch.

## Where it lives

| Piece | File |
|---|---|
| Switch (default OFF) | Admin → Settings → Authentication → Login Methods → "Require mobile OTP verification (all students)" (`auth.providers` → `toggles.mobileVerificationRequired`) |
| Enforcement (every protected page, Server Action, student API) | `lib/student-session.ts` `requireStudent()` → `StudentMobileUnverifiedError`; `proxy.ts` redirects page loads early |
| Verification page (restricted session: verify, sign out, support) | `/student/verify-mobile` |
| Verify / conflict rules | `lib/mobile-verification.ts` |
| Mobile-first Create Account + OTP sign-in rules | `app/login/actions.ts`, `lib/auth-student.ts` (`otp` provider) |
| Number parsing (+91 only, E.164 storage) | `lib/indian-mobile.ts` |
| Admin numbers | Admin → Analytics → "Mobile Verification" |

Data: `Student.mobileVerifiedAt` (NULL = unverified) and `OtpPurpose.VERIFY_MOBILE`
(migration `20261008150000_student_mobile_verification`, additive only). No
existing student is marked verified by the migration. A verified number is
stored as `+91XXXXXXXXXX`. `Student.mobile` was already `@unique`.

Rules:
- A number on another account (in any stored spelling) is never moved or merged.
  The student sees a support message, and only after the OTP proves they own the number.
- Phone OTP sign-in reaches only an account that proved the number: one already
  verified, or one created by OTP sign-up. A number typed into a password or
  Google account is not trusted until that student verifies it.
- With the switch OFF, nothing is enforced and Create Account keeps the password form.
  These apply regardless of the switch: the Phone OTP tab is sign-in only (+91; new users go to Create Account),
  the OTP sign-in rule above, the 60 s resend cooldown, and no OTP text in production logs.

## Turning it on

1. Admin → Settings → Authentication: MSG91 shows Connected (Auth Key + Widget ID or Flow ID).
   The switch refuses to turn on without them.
2. Sign in as a real student account and open `/student/verify-mobile`. Verify your own number
   and confirm the SMS arrives and the code works. The page works while the switch is OFF.
3. Turn the switch ON. The provider config cache means it takes effect within 15 s.
4. In a private window, check Login → Create Account (Name + +91 + OTP) with a second real number.
5. Watch Admin → Analytics → Mobile Verification and Monitoring → Authentication (`MOBILE_VERIFY`).

Before turning it on during a campaign: a student who is mid-test when the switch flips is
sent to verification on their next save. Flip it outside Live CBT windows.

To turn it off, flip the same switch. Verified data stays, and nothing else changes.

## Production audit (count-only, run by the owner)

```bash
cd /var/www/mocktestseries && set -a && . ./.env && set +a && psql "${DATABASE_URL%%\?*}" -At <<'SQL'
select 'students (not deleted)', count(*) from "Student" where status <> 'DELETED';
select 'verified', count(*) from "Student" where "mobileVerifiedAt" is not null;
select 'no mobile', count(*) from "Student" where mobile is null;
select 'format '||case when mobile ~ '^\+91[6-9][0-9]{9}$' then 'e164' when mobile ~ '^[6-9][0-9]{9}$' then '10-digit'
  when mobile ~ '^91[6-9][0-9]{9}$' then '91-prefix' else 'other/non-Indian' end, count(*) from "Student" where mobile is not null group by 1;
select 'same number in 2+ spellings', count(*) from (select right(regexp_replace(mobile,'\D','','g'),10) d from "Student"
  where mobile is not null group by 1 having count(*) > 1) x;
SQL
```

## Tests

`scripts/verify-mobile-otp.mjs` (+ `scripts/mobile-otp-fixture.ts`, `scripts/msg91-widget-mock.mjs`):
a local production build on a disposable DB, with MSG91 answered in-process so no SMS is ever
sent. The invocation is in the suite header.
