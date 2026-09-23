import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getRazorpayConfig, type RazorpaySlotPublic } from "@/lib/razorpay-config";
import { getInvoiceSettings, getPaymentMode, getPaymentPolicy } from "@/lib/payments/settings";
import { findPaymentMismatches } from "@/lib/payments/reconcile";
import { PAYMENT_AUDIT_ENTITY_TYPES } from "@/lib/payments/audit";
import { getSiteUrl } from "@/lib/site-url";
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
      </CardHeader>
      <CardContent>
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
  const rzp = await getRazorpayConfig();
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
          </ActionForm>
          <ActionForm action={testGatewayAction} submitLabel="Test connection" variant="outline" readOnly={!canManage} />
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
  const [mode, policy, inv] = await Promise.all([getPaymentMode(), getPaymentPolicy(), getInvoiceSettings()]);
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
          <CardTitle className="text-base">Order &amp; Refund Policy</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={savePaymentPolicyAction} submitLabel="Save policy" readOnly={ro} className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
            <Field label="Access after full refund (default)" htmlFor="pol-refund">
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
          <CardTitle className="text-base">Invoice &amp; Tax Settings</CardTitle>
          <CardDescription>
            Printed on invoices issued from now on (old invoices keep their snapshot). Tax treatment is never assumed — set it to match your registration, or leave it at None.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={saveInvoiceSettingsAction} submitLabel="Save invoice settings" readOnly={ro} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Legal name" htmlFor="inv-legal">
              <Input id="inv-legal" name="legalName" defaultValue={inv.legalName} />
            </Field>
            <Field label="Trade / brand name" htmlFor="inv-trade">
              <Input id="inv-trade" name="tradeName" defaultValue={inv.tradeName} />
            </Field>
            <Field label="Billing address" htmlFor="inv-addr">
              <Textarea id="inv-addr" name="billingAddress" defaultValue={inv.billingAddress} rows={3} />
            </Field>
            <div className="flex flex-col gap-3">
              <Field label="Support email" htmlFor="inv-email">
                <Input id="inv-email" name="supportEmail" type="email" defaultValue={inv.supportEmail} />
              </Field>
              <Field label="Support phone" htmlFor="inv-phone">
                <Input id="inv-phone" name="supportPhone" defaultValue={inv.supportPhone} />
              </Field>
            </div>
            <Field label="GSTIN (if registered)" htmlFor="inv-gstin">
              <Input id="inv-gstin" name="gstin" defaultValue={inv.gstin} maxLength={15} />
            </Field>
            <Field label="Invoice prefix" htmlFor="inv-prefix" hint="e.g. MTS → MTS/2026-27/00001">
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
            <Field label="Footer note" htmlFor="inv-footer">
              <Input id="inv-footer" name="footerNote" defaultValue={inv.footerNote} maxLength={300} />
            </Field>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
