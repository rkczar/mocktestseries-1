import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getRazorpayConfig, type RazorpaySlotPublic } from "@/lib/razorpay-config";
import { getInvoiceSettings, getPaymentMode, getPaymentPolicy, getVerificationStudentIds, MAX_VERIFICATION_ACCOUNTS } from "@/lib/payments/settings";
import { findPaymentMismatches } from "@/lib/payments/reconcile";
import { PAYMENT_AUDIT_ENTITY_TYPES } from "@/lib/payments/audit";
import { getSiteUrl } from "@/lib/site-url";
import { getLaunchReadiness } from "@/lib/payments/launch-readiness";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { Empty, EnvBadge, fmtDate, StatusBadge, TableShell, Td, Th } from "./shared";
import { ActionForm } from "./action-form";
import {
  expireStaleOrdersAction,
  reconcileOrderAction,
  saveGatewayAction,
  saveGatewayModeAction,
  saveInvoiceSettingsAction,
  savePaymentPolicyAction,
  saveVerificationAccountsAction,
  setPaymentModeAction,
  testGatewayAction,
} from "../actions";

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-[var(--color-muted-foreground)]">{hint}</p> : null}
    </div>
  );
}

function SlotCard({ slot, data, readOnly }: { slot: "TEST" | "LIVE"; data: RazorpaySlotPublic; readOnly: boolean }) {
  const id = slot.toLowerCase();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {slot} credentials {data.configured ? <Badge variant="success">Configured</Badge> : <Badge>Not configured</Badge>}
        </CardTitle>
        <CardDescription>
          Key ID: <span className="font-mono">{data.keyIdMasked || "—"}</span> · Secret: {data.keySecretConfigured ? "••••••••••••" : "—"} · Webhook secret:{" "}
          {data.webhookSecretConfigured ? "••••••••••••" : "—"}
        </CardDescription>
        <p className={`text-xs ${data.lastTest ? (data.lastTest.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]") : "text-[var(--color-muted-foreground)]"}`}>
          {data.lastTest ? `Connection test ${fmtDate(new Date(data.lastTest.at), true)}: ${data.lastTest.message}` : "Connection not tested since these credentials last changed."}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!readOnly && data.configured ? (
          <ActionForm action={testGatewayAction} submitLabel={`Test ${slot} connection`} variant="outline">
            <input type="hidden" name="environment" value={slot} />
            {slot === "LIVE" ? <p className="text-xs text-[var(--color-muted-foreground)]">Read-only API check with the LIVE keys — the gateway stays in its current mode.</p> : null}
          </ActionForm>
        ) : null}
        {readOnly ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">View only — only Master Admin can update credentials.</p>
        ) : (
          <ActionForm action={saveGatewayAction} submitLabel={`Save ${slot} credentials`}>
            <input type="hidden" name="slot" value={slot} />
            <Field label="Key ID" htmlFor={`${id}-keyId`} hint={`Starts with rzp_${id}_. Leave blank to keep the current one.`}>
              <Input id={`${id}-keyId`} name="keyId" autoComplete="off" placeholder={data.keyIdMasked || `rzp_${id}_…`} />
            </Field>
            <Field label="Key Secret" htmlFor={`${id}-keySecret`} hint="Write-only. Leave blank to keep the stored secret.">
              <Input id={`${id}-keySecret`} name="keySecret" type="password" autoComplete="new-password" placeholder={data.keySecretConfigured ? "•••••••• (stored)" : ""} />
            </Field>
            <Field label="Webhook Secret" htmlFor={`${id}-webhookSecret`} hint="The secret you set when creating the webhook in the Razorpay Dashboard.">
              <Input id={`${id}-webhookSecret`} name="webhookSecret" type="password" autoComplete="new-password" placeholder={data.webhookSecretConfigured ? "•••••••• (stored)" : ""} />
            </Field>
          </ActionForm>
        )}
      </CardContent>
    </Card>
  );
}

export async function GatewayPanel({ canManage }: { canManage: boolean }) {
  const [rzp, readiness] = await Promise.all([getRazorpayConfig(), getLaunchReadiness()]);
  const webhookUrl = `${await getSiteUrl()}/api/webhooks/razorpay`;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            Razorpay Gateway
            {rzp.environment === "TEST" ? <Badge variant="warning">TEST MODE</Badge> : <Badge variant="error">LIVE MODE — real money</Badge>}
            {rzp.enabled ? <Badge variant="success">Enabled</Badge> : <Badge>Disabled</Badge>}
          </CardTitle>
          <CardDescription>
            Standard Checkout. Secrets are AES-256-GCM encrypted at rest, never sent to the browser, and never shown after saving. Webhook URL:{" "}
            <span className="font-mono">{webhookUrl}</span> (events: payment.authorized, payment.captured, payment.failed, order.paid, refund.created, refund.processed,
            refund.failed).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {rzp.lastTest ? (
            <p className={`text-sm ${rzp.lastTest.ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}>
              Last test ({fmtDate(new Date(rzp.lastTest.at), true)}): {rzp.lastTest.message}
            </p>
          ) : null}
          <ActionForm action={saveGatewayModeAction} submitLabel="Save gateway mode" readOnly={!canManage} className="grid grid-cols-1 gap-3 sm:grid-cols-4 sm:items-end">
            <Field label="Environment" htmlFor="gw-env">
              <SelectNative id="gw-env" name="environment" defaultValue={rzp.environment}>
                <option value="TEST">TEST</option>
                <option value="LIVE">LIVE</option>
              </SelectNative>
            </Field>
            <Field label="Confirm LIVE" htmlFor="gw-confirm" hint="Type LIVE when switching to live.">
              <Input id="gw-confirm" name="confirmLive" autoComplete="off" />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="enabled" defaultChecked={rzp.enabled} /> Payments enabled
            </label>
            {rzp.environment !== "LIVE" ? (
              <label className="flex items-start gap-2 text-xs sm:col-span-4">
                <input type="checkbox" name="acknowledgeReadiness" className="mt-0.5" />
                <span>
                  Switching to LIVE: I have reviewed{" "}
                  <Link href="/admin/payments?tab=readiness" className="text-[var(--color-primary)] hover:underline">
                    Live Launch Readiness
                  </Link>{" "}
                  and accept the {readiness.acknowledgementsRequired.length} open business / legal item(s).
                </span>
              </label>
            ) : null}
          </ActionForm>
          {rzp.environment !== "LIVE" ? (
            readiness.liveBlockers.length ? (
              <div className="rounded-[var(--radius-button)] border border-[var(--color-error)]/40 bg-[var(--color-error)]/5 px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
                <p className="font-medium text-[var(--color-foreground)]">Switching to LIVE is blocked (checked again on the server when you save):</p>
                <ul className="list-disc pl-5">
                  {readiness.liveBlockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-xs text-[var(--color-muted-foreground)]">LIVE technical requirements are met. Follow the controlled first-payment checklist under Live Launch Readiness.</p>
            )
          ) : null}
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SlotCard slot="TEST" data={rzp.test} readOnly={!canManage} />
        <SlotCard slot="LIVE" data={rzp.live} readOnly={!canManage} />
      </div>
    </div>
  );
}

export async function WebhooksPanel() {
  const events = await prisma.paymentWebhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 200 });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Webhook Events</CardTitle>
        <CardDescription>Signature-verified Razorpay deliveries, deduplicated by event id. Only a safe summary is stored.</CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <Empty>No webhook events received yet.</Empty>
        ) : (
          <TableShell minWidth={900}>
            <thead>
              <tr>
                <Th>Received</Th>
                <Th>Event</Th>
                <Th>Event ID</Th>
                <Th>Env</Th>
                <Th>Summary</Th>
                <Th>Processed</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const s = (e.summary ?? {}) as Record<string, unknown>;
                return (
                  <tr key={e.id}>
                    <Td>{fmtDate(e.receivedAt, true)}</Td>
                    <Td mono>{e.eventType}</Td>
                    <Td mono>{e.eventId.slice(0, 24)}</Td>
                    <Td>{e.environment ?? "—"}</Td>
                    <Td>
                      <span className="font-mono text-[10px]">
                        {[s.paymentId, s.orderId, s.refundId, s.status].filter(Boolean).join(" · ")}
                      </span>
                      {e.orderId ? (
                        <Link href={`/admin/payments/orders/${e.orderId}`} className="ml-1 text-xs text-[var(--color-primary)] hover:underline">
                          order
                        </Link>
                      ) : null}
                    </Td>
                    <Td>{fmtDate(e.processedAt, true)}</Td>
                    <Td>
                      <StatusBadge status={e.status} />
                      {e.errorCategory ? <div className="text-[10px] text-[var(--color-muted-foreground)]">{e.errorCategory}</div> : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </CardContent>
    </Card>
  );
}

export async function ReconciliationPanel({ canManage }: { canManage: boolean }) {
  const mismatches = await findPaymentMismatches();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Reconciliation</CardTitle>
        <CardDescription>
          Mismatches between our records and Razorpay. &ldquo;Re-check&rdquo; re-reads the order from Razorpay with the server key and fulfils only a genuinely captured payment — it never
          fabricates success.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canManage ? <ActionForm action={expireStaleOrdersAction} submitLabel="Expire stale unpaid orders" variant="outline" /> : null}
        {mismatches.length === 0 ? (
          <Empty>No mismatches found.</Empty>
        ) : (
          <TableShell minWidth={900}>
            <thead>
              <tr>
                <Th>Detected</Th>
                <Th>Type</Th>
                <Th>Order</Th>
                <Th>Detail</Th>
                <Th> </Th>
              </tr>
            </thead>
            <tbody>
              {mismatches.map((m, i) => (
                <tr key={`${m.kind}-${m.orderId}-${i}`}>
                  <Td>{fmtDate(m.at, true)}</Td>
                  <Td>
                    <Badge variant="warning">{m.kind.replace(/_/g, " ")}</Badge>
                  </Td>
                  <Td mono>
                    {m.orderId ? (
                      <Link href={`/admin/payments/orders/${m.orderId}`} className="text-[var(--color-primary)] hover:underline">
                        {m.orderNumber ?? m.orderId}
                      </Link>
                    ) : (
                      "—"
                    )}{" "}
                    <EnvBadge env={m.environment} />
                  </Td>
                  <Td>{m.detail}</Td>
                  <Td>
                    {canManage && m.orderId ? (
                      <ActionForm action={reconcileOrderAction} submitLabel="Re-check" variant="outline" className="flex items-center gap-2">
                        <input type="hidden" name="orderId" value={m.orderId} />
                      </ActionForm>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </CardContent>
    </Card>
  );
}

export async function AuditPanel() {
  const logs = await prisma.auditLog.findMany({
    where: { entityType: { in: PAYMENT_AUDIT_ENTITY_TYPES } },
    include: { actor: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Payment Audit Log</CardTitle>
        <CardDescription>Sensitive payment actions with safe before/after facts. Secrets are never recorded.</CardDescription>
      </CardHeader>
      <CardContent>
        {logs.length === 0 ? (
          <Empty>No payment admin actions yet.</Empty>
        ) : (
          <TableShell minWidth={900}>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Admin</Th>
                <Th>Action</Th>
                <Th>Entity</Th>
                <Th>Details</Th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <Td>{fmtDate(l.createdAt, true)}</Td>
                  <Td>{l.actor?.name ?? "System"}</Td>
                  <Td mono>{l.action}</Td>
                  <Td mono>
                    {l.entityType}
                    {l.entityId ? `:${l.entityId.slice(0, 12)}` : ""}
                  </Td>
                  <Td>
                    <code className="block max-w-[420px] truncate text-[10px] text-[var(--color-muted-foreground)]" title={JSON.stringify(l.metadata)}>
                      {l.metadata ? JSON.stringify(l.metadata) : "—"}
                    </code>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </CardContent>
    </Card>
  );
}

export async function SettingsPanel({ canManage }: { canManage: boolean }) {
  const [mode, policy, inv, verificationIds] = await Promise.all([getPaymentMode(), getPaymentPolicy(), getInvoiceSettings(), getVerificationStudentIds()]);
  const verificationStudents = verificationIds.length
    ? await prisma.student.findMany({ where: { id: { in: verificationIds } }, select: { id: true, studentId: true, name: true } })
    : [];
  const ro = !canManage;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Global Payment Mode <Badge variant={mode === "PAID" ? "primary" : mode === "FREE" ? "success" : "warning"}>{mode}</Badge>
          </CardTitle>
          <CardDescription>
            FREE — everything stays open, no payments (today&apos;s behavior). PAID — product pricing and entitlements apply. MAINTENANCE — no new payments; existing
            subscriptions keep working. Switching never deletes orders, payments, coupons or invoices.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={setPaymentModeAction} submitLabel="Change mode" readOnly={ro} className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
            <Field label="Mode" htmlFor="pm-mode">
              <SelectNative id="pm-mode" name="mode" defaultValue={mode}>
                <option value="FREE">FREE</option>
                <option value="PAID">PAID</option>
                <option value="MAINTENANCE">MAINTENANCE</option>
              </SelectNative>
            </Field>
            <Field label="Confirm" htmlFor="pm-confirm" hint="Type the mode name again to confirm.">
              <Input id="pm-confirm" name="confirm" autoComplete="off" />
            </Field>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            Payment Verification Accounts <Badge>{verificationStudents.length}</Badge>
          </CardTitle>
          <CardDescription>
            While the mode is FREE, these students (max {MAX_VERIFICATION_ACCOUNTS}) see PAID behaviour — locked paid mocks, pricing, coupons and checkout —
            so one controlled real purchase can be verified without charging or locking anyone else. Everyone else stays free. Ignored in PAID /
            MAINTENANCE. Clear the list after verification.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {verificationStudents.length ? (
            <ul className="text-sm">
              {verificationStudents.map((st) => (
                <li key={st.id}>
                  <Link href={`/admin/students/${st.id}`} className="font-mono text-[var(--color-primary)] hover:underline">
                    {st.studentId}
                  </Link>{" "}
                  {st.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">None — every student follows the global mode.</p>
          )}
          <ActionForm action={saveVerificationAccountsAction} submitLabel="Save verification accounts" readOnly={ro} className="grid grid-cols-1 gap-3 sm:items-end">
            <Field label="Student IDs (one per line; empty = clear)" htmlFor="pv-accounts">
              <Textarea id="pv-accounts" name="accounts" rows={3} defaultValue={verificationStudents.map((st) => st.studentId).join("\n")} />
            </Field>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Order &amp; Refund Policy</CardTitle>
          <CardDescription>
            What happens to a student&apos;s access after a refund. Refunds are never automatic — a Master Admin requests each one from the order page and
            picks its access policy there (defaulting to the setting below). Access changes only once Razorpay reports the refund <strong>PROCESSED</strong> and
            the payment is <strong>fully</strong> refunded; partial refunds never change access.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="grid grid-cols-1 gap-2 text-xs text-[var(--color-muted-foreground)] sm:grid-cols-3">
            <li className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-2">
              <strong className="text-[var(--color-foreground)]">Retain access</strong> — the entitlement stays active until its normal expiry.
            </li>
            <li className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-2">
              <strong className="text-[var(--color-foreground)]">Revoke immediately</strong> — the entitlement from that order is revoked when the full refund is
              processed.
            </li>
            <li className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-2">
              <strong className="text-[var(--color-foreground)]">Retain until a date</strong> (per refund) — access ends on the chosen date (never later than its
              normal expiry).
            </li>
          </ul>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            Refunds started outside this panel (e.g. in the Razorpay Dashboard) are recorded from the refund webhook with <strong>Retain access</strong>; revoke
            manually from the student&apos;s payment profile if needed. Public wording: Refund &amp; Cancellation Policy (/refund-policy).
          </p>
          <ActionForm action={savePaymentPolicyAction} submitLabel="Save policy" readOnly={ro} className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
            <Field label="Default access after full refund" htmlFor="pol-refund">
              <SelectNative id="pol-refund" name="refundAccessPolicy" defaultValue={policy.refundAccessPolicy}>
                <option value="RETAIN">Retain access</option>
                <option value="REVOKE_IMMEDIATELY">Revoke immediately</option>
              </SelectNative>
            </Field>
            <Field label="Unpaid order lifetime (minutes)" htmlFor="pol-ttl">
              <Input id="pol-ttl" name="orderTtlMinutes" type="number" min={10} max={1440} defaultValue={policy.orderTtlMinutes} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="invoiceZeroValueOrders" defaultChecked={policy.invoiceZeroValueOrders} /> Issue invoices for ₹0 coupon orders
            </label>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoice &amp; Business Details</CardTitle>
          <CardDescription>
            Printed on invoices issued from now on — existing invoices keep their snapshot. Nothing is assumed: GST registration stays &ldquo;not answered&rdquo;
            until you choose, and the tax treatment only changes when you change it here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={saveInvoiceSettingsAction} submitLabel="Save invoice settings" readOnly={ro} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Legal / business name" htmlFor="inv-legal">
              <Input id="inv-legal" name="legalName" defaultValue={inv.legalName} />
            </Field>
            <Field label="Brand / trading name (optional)" htmlFor="inv-trade">
              <Input id="inv-trade" name="tradeName" defaultValue={inv.tradeName} />
            </Field>
            <Field label="Address line 1" htmlFor="inv-a1">
              <Input id="inv-a1" name="addressLine1" defaultValue={inv.addressLine1} />
            </Field>
            <Field label="Address line 2" htmlFor="inv-a2">
              <Input id="inv-a2" name="addressLine2" defaultValue={inv.addressLine2} />
            </Field>
            <Field label="City" htmlFor="inv-city">
              <Input id="inv-city" name="city" defaultValue={inv.city} />
            </Field>
            <Field label="State" htmlFor="inv-state">
              <Input id="inv-state" name="state" defaultValue={inv.state} />
            </Field>
            <Field label="PIN code" htmlFor="inv-pin">
              <Input id="inv-pin" name="pinCode" defaultValue={inv.pinCode} inputMode="numeric" maxLength={10} />
            </Field>
            <Field label="Country" htmlFor="inv-country">
              <Input id="inv-country" name="country" defaultValue={inv.country} />
            </Field>
            {inv.billingAddress && !inv.addressLine1 ? (
              <Field label="Legacy billing address (used until the fields above are filled)" htmlFor="inv-addr">
                <Textarea id="inv-addr" name="billingAddress" defaultValue={inv.billingAddress} rows={3} />
              </Field>
            ) : (
              <input type="hidden" name="billingAddress" value={inv.billingAddress} />
            )}
            <div className="flex flex-col gap-3">
              <Field label="Support email" htmlFor="inv-email">
                <Input id="inv-email" name="supportEmail" type="email" defaultValue={inv.supportEmail} />
              </Field>
              <Field label="Support phone" htmlFor="inv-phone">
                <Input id="inv-phone" name="supportPhone" defaultValue={inv.supportPhone} />
              </Field>
            </div>
            <Field label="GST registered?" htmlFor="inv-gstreg" hint="Your decision — the site never assumes it. “No” prints no GSTIN and no tax lines.">
              <SelectNative id="inv-gstreg" name="gstRegistered" defaultValue={inv.gstRegistered === true ? "YES" : inv.gstRegistered === false ? "NO" : "UNSET"}>
                <option value="UNSET">Not answered yet</option>
                <option value="YES">Yes — GST registered</option>
                <option value="NO">No — not GST registered</option>
              </SelectNative>
            </Field>
            <Field label="GSTIN (only if registered)" htmlFor="inv-gstin">
              <Input id="inv-gstin" name="gstin" defaultValue={inv.gstin} maxLength={15} />
            </Field>
            <Field label="Invoice prefix" htmlFor="inv-prefix" hint="e.g. MTS → MTS/2026-27/00001 (TEST invoices: TEST-MTS/…)">
              <Input id="inv-prefix" name="invoicePrefix" defaultValue={inv.invoicePrefix} maxLength={10} />
            </Field>
            <Field label="Tax mode" htmlFor="inv-taxmode">
              <SelectNative id="inv-taxmode" name="taxMode" defaultValue={inv.taxMode}>
                <option value="NONE">None (no tax lines)</option>
                <option value="INCLUSIVE">Prices include GST</option>
              </SelectNative>
            </Field>
            <Field label="GST rate %" htmlFor="inv-rate">
              <Input id="inv-rate" name="taxRatePercent" type="number" step="0.01" min={0} max={50} defaultValue={inv.taxRatePercent} />
            </Field>
            <Field label="Tax split" htmlFor="inv-split">
              <SelectNative id="inv-split" name="taxSplit" defaultValue={inv.taxSplit}>
                <option value="IGST">IGST</option>
                <option value="CGST_SGST">CGST + SGST</option>
              </SelectNative>
            </Field>
            <Field label="SAC code" htmlFor="inv-sac">
              <Input id="inv-sac" name="sacCode" defaultValue={inv.sacCode} maxLength={8} />
            </Field>
            <Field label="Footer / support note" htmlFor="inv-footer">
              <Input id="inv-footer" name="footerNote" defaultValue={inv.footerNote} maxLength={300} />
            </Field>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
