import { prisma } from "@/lib/prisma";
import { getPremiumPolicy, examDayEnd, isPolicyComplete, REMINDER_KINDS, TRIAL_HOURS_MAX, TRIAL_HOURS_MIN, type ReminderKind } from "@/lib/premium-policy";
import { getTrialAnalytics } from "@/lib/premium-trial";
import { enforcementBlockers, extendTillExamAccess } from "@/lib/premium-admin";
import { getEmailSettings } from "@/lib/email/settings";
import { getPaymentMode } from "@/lib/payments/settings";
import { formatInr } from "@/lib/payments/money";
import { formatIst } from "@/lib/ist-time";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { ActionForm } from "./action-form";
import { extendTillExamAccessAction, savePremiumPolicyAction, setPremiumEnforcementAction } from "../free-access-actions";

const REMINDER_LABEL: Record<ReminderKind, string> = {
  started: "Trial started",
  h24: "24 hours remaining",
  h6: "6 hours remaining",
  h1: "1 hour remaining",
  expired: "Trial expired",
};

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-[var(--color-muted-foreground)]">{hint}</p> : null}
    </div>
  );
}

function Check({ name, label, defaultChecked, value }: { name: string; label: string; defaultChecked: boolean; value?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm text-[var(--color-foreground)]">
      <input type="checkbox" name={name} value={value ?? "on"} defaultChecked={defaultChecked} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
      <span>{label}</span>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
      <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
      <p className="mt-1 text-lg font-semibold text-[var(--color-foreground)]">{value}</p>
    </div>
  );
}

/** Admin → Payments → Free Access & Trial. View: PAYMENTS_VIEW; every change: PAYMENTS_MANAGE (enforced in the actions). */
export async function FreeAccessPanel({ canManage }: { canManage: boolean }) {
  const ro = !canManage;
  const [policy, mode, email, analytics, exams] = await Promise.all([
    getPremiumPolicy(),
    getPaymentMode(),
    getEmailSettings(),
    getTrialAnalytics(),
    prisma.exam.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { order: "asc" } }),
  ]);
  const examId = policy.examId ?? (exams.length === 1 ? exams[0].id : null);
  const [products, papers, mocks, extendPreview] = await Promise.all([
    examId
      ? prisma.product.findMany({ where: { examId, accessType: "PAID" }, select: { id: true, code: true, name: true, isActive: true, productType: true }, orderBy: { order: "asc" } })
      : [],
    examId ? prisma.previousYearPaper.findMany({ where: { examId, isActive: true }, select: { id: true, title: true, year: true }, orderBy: [{ year: "desc" }, { order: "asc" }] }) : [],
    examId
      ? prisma.mockTest.findMany({
          where: { examId, status: "PUBLISHED" },
          select: { id: true, title: true, enrollmentEnabled: true, coverageType: true },
          orderBy: { createdAt: "asc" },
        })
      : [],
    extendTillExamAccess(policy, { apply: false }),
  ]);
  const blockers = enforcementBlockers({ ...policy, examId });
  const on = policy.enforcementEnabled && isPolicyComplete(policy);
  const examEnd = examDayEnd(policy.examDate);
  const liveCbt = mocks.filter((m) => m.enrollmentEnabled);
  const regular = mocks.filter((m) => !m.enrollmentEnabled);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            Premium Access Enforcement <Badge variant={on ? "primary" : "neutral"}>{on ? "ON" : "OFF"}</Badge>
            {mode !== "PAID" ? <Badge variant="warning">Payment Mode {mode}: no effect until PAID</Badge> : null}
          </CardTitle>
          <CardDescription>
            ON — only the selected free PYQ, Mock Test and Subject Mock Test (plus any free Live CBT tests) stay open; every other test of the exam needs an
            active Premium plan, a covering purchase or the student&apos;s one-time trial. Effective immediately (both servers within ~5 seconds). OFF — the
            previous access rules apply again. Switching never edits tests, attempts, results, purchases or subscriptions.
            {policy.enforcedSince ? ` Last switched ON: ${formatIst(new Date(policy.enforcedSince))}.` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!on && blockers.length ? (
            <ul className="list-disc pl-5 text-xs text-[var(--color-error)]">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : null}
          <ActionForm action={setPremiumEnforcementAction} submitLabel={on ? "Switch OFF" : "Switch ON"} readOnly={ro} variant={on ? "outline" : "primary"} className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end">
            <input type="hidden" name="enforcement" value={on ? "OFF" : "ON"} />
            <Field label="Confirm" htmlFor="pe-confirm" hint={`Type ${on ? "DISABLE" : "ENABLE"} to confirm.`}>
              <Input id="pe-confirm" name="confirm" autoComplete="off" />
            </Field>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Trial Analytics</CardTitle>
          <CardDescription>Live database counts. Revenue = verified LIVE captured payments (net of refunds) on Premium orders paid after the student&apos;s trial began.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Eligible students (no trial yet)" value={analytics.eligibleStudents} />
          <Stat label="Trials started" value={analytics.trialsStarted} />
          <Stat label="Active trials" value={analytics.activeTrials} />
          <Stat label="Expiring today (IST)" value={analytics.expiringToday} />
          <Stat label="Expired trials" value={analytics.expiredTrials} />
          <Stat label="Trial → paid conversions" value={analytics.conversions} />
          <Stat label="Active Premium subscribers" value={analytics.activePremium} />
          <Stat label="Revenue from trial conversions" value={formatInr(analytics.conversionRevenuePaise)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Free Access &amp; Trial Settings</CardTitle>
          <CardDescription>
            Trial reminders are emailed through the existing email system and only while production sending is ON (currently{" "}
            <strong>{email.sendingEnabled ? "ON" : "OFF"}</strong>). Each template is editable under Communications → Email.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={savePremiumPolicyAction} submitLabel="Save settings" readOnly={ro} className="flex flex-col gap-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Exam" htmlFor="fa-exam" hint="The exam the policy applies to. Other exams keep their current rules.">
                <SelectNative id="fa-exam" name="examId" defaultValue={examId ?? ""}>
                  <option value="">— Not set —</option>
                  {exams.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </SelectNative>
              </Field>
              <div className="flex flex-col gap-1">
                <Label>Premium products</Label>
                {products.length === 0 ? <p className="text-xs text-[var(--color-muted-foreground)]">No PAID products for this exam.</p> : null}
                {products.map((p) => (
                  <Check
                    key={p.id}
                    name="premiumProductIds"
                    value={p.id}
                    defaultChecked={policy.premiumProductIds.includes(p.id)}
                    label={`${p.name} (${p.code}, ${p.productType}${p.isActive ? "" : ", inactive"})`}
                  />
                ))}
                <p className="text-[11px] text-[var(--color-muted-foreground)]">An active plan here unlocks every test of the exam. Other purchases keep unlocking what they cover.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="Free PYQ" htmlFor="fa-pyq">
                <SelectNative id="fa-pyq" name="freePyqId" defaultValue={policy.freePyqId ?? ""}>
                  <option value="">— None —</option>
                  {papers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title} ({p.year})
                    </option>
                  ))}
                </SelectNative>
              </Field>
              <Field label="Free Mock Test" htmlFor="fa-mock">
                <SelectNative id="fa-mock" name="freeMockTestId" defaultValue={policy.freeMockTestId ?? ""}>
                  <option value="">— None —</option>
                  {regular.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title}
                    </option>
                  ))}
                </SelectNative>
              </Field>
              <Field label="Free Subject Mock Test" htmlFor="fa-subject" hint="A fixed subject mock (not random subject practice).">
                <SelectNative id="fa-subject" name="freeSubjectMockTestId" defaultValue={policy.freeSubjectMockTestId ?? ""}>
                  <option value="">— None —</option>
                  {regular.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title}
                      {m.coverageType === "SUBJECT_WISE" ? " (subject-wise)" : ""}
                    </option>
                  ))}
                </SelectNative>
              </Field>
            </div>

            {liveCbt.length ? (
              <div className="flex flex-col gap-1">
                <Label>Free Live CBT tests (optional — every other Live CBT is Premium)</Label>
                {liveCbt.map((m) => (
                  <Check key={m.id} name="freeLiveCbtMockTestIds" value={m.id} defaultChecked={policy.freeLiveCbtMockTestIds.includes(m.id)} label={m.title} />
                ))}
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="flex flex-col gap-2">
                <Label>Free Trial</Label>
                <Check name="trialEnabled" label="Free Trial ON" defaultChecked={policy.trialEnabled} />
                <Check name="requireVerifiedMobile" label="Require a verified mobile (one trial per number)" defaultChecked={policy.requireVerifiedMobile} />
              </div>
              <Field label="Trial duration (hours)" htmlFor="fa-hours" hint="Default 48. Applies to trials started after saving.">
                <Input id="fa-hours" name="trialHours" type="number" min={TRIAL_HOURS_MIN} max={TRIAL_HOURS_MAX} defaultValue={policy.trialHours} />
              </Field>
              <Field label="Grace for untimed attempts (minutes)" htmlFor="fa-grace" hint="Untimed attempts started before the trial ended / enforcement began may continue this long. Timed attempts finish within their own limit.">
                <Input id="fa-grace" name="attemptGraceMinutes" type="number" min={0} max={1440} defaultValue={policy.attemptGraceMinutes} />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label>Student Dashboard popups (at most one per day)</Label>
                <Check name="popupWelcome" label="Welcome popup (trial not started yet)" defaultChecked={policy.popups.welcome} />
                <Check name="popupActiveDaily" label="Active trial daily popup" defaultChecked={policy.popups.activeDaily} />
                <Check name="popupExpired" label="Expired trial popup" defaultChecked={policy.popups.expired} />
                <Field label="Expired-trial popup: at most every N days" htmlFor="fa-every">
                  <Input id="fa-every" name="expiredEveryDays" type="number" min={1} max={30} defaultValue={policy.popups.expiredEveryDays} className="max-w-[8rem]" />
                </Field>
              </div>
              <div className="flex flex-col gap-2">
                <Label>Trial reminders (email)</Label>
                {REMINDER_KINDS.map((k) => (
                  <Check key={k} name={`reminder_${k}`} label={REMINDER_LABEL[k]} defaultChecked={policy.reminders[k]} />
                ))}
                <p className="text-[11px] text-[var(--color-muted-foreground)]">Never sent to paid Premium students or to students who have not started a trial.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field
                label="Premium plan exam date (IST)"
                htmlFor="fa-examdate"
                hint="Leave empty until the official date is confirmed. “Till Exam” access runs to 23:59 IST on this day."
              >
                <Input id="fa-examdate" name="examDate" type="date" defaultValue={policy.examDate ?? ""} className="max-w-[12rem]" />
              </Field>
              <div className="flex flex-col gap-1">
                <Label>Sell as “Till Exam”</Label>
                {products.map((p) => (
                  <Check key={p.id} name="tillExamProductIds" value={p.id} defaultChecked={policy.tillExamProductIds.includes(p.id)} label={p.name} />
                ))}
                <p className="text-[11px] text-[var(--color-muted-foreground)]">
                  New purchases get access until the later of the plan&apos;s own validity or the end of the exam day. Existing purchases are not changed.
                </p>
              </div>
            </div>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Exam postponed? Extend “Till Exam” access</CardTitle>
          <CardDescription>
            After changing the exam date above, this moves every ACTIVE “Till Exam” subscription that would end earlier to 23:59 IST on the new date. It never
            shortens access and never revives expired or revoked access.
            {examEnd ? ` Target: ${formatIst(examEnd)}. Subscriptions that would be extended now: ${extendPreview.count}.` : " Set the exam date and “Till Exam” plans first."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={extendTillExamAccessAction} submitLabel="Extend access" readOnly={ro || !examEnd} variant="outline" className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end">
            <Field label="Confirm" htmlFor="ext-confirm" hint="Type EXTEND to confirm.">
              <Input id="ext-confirm" name="confirm" autoComplete="off" />
            </Field>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
