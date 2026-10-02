import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatInr } from "@/lib/payments/money";
import { enqueueEmail } from "@/lib/email/queue";

/**
 * Automatic email events — the only entry points app code calls. Each one
 * just queues a row with a deterministic idempotency key; rendering, gating
 * (sending on/off, template enabled, preferences) and delivery happen in the
 * worker. The non-transactional helpers never throw: an email problem must
 * never break registration, login or a password reset.
 */

async function safely(label: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    console.error(`[email] ${label} enqueue failed`, { code: (error as { code?: string })?.code ?? (error instanceof Error ? error.name : "UNKNOWN") });
  }
}

/** WELCOME — once per account, at creation (password, mobile OTP or Google). */
export function queueWelcomeEmail(studentId: string) {
  return safely("welcome", () => enqueueEmail({ idempotencyKey: `welcome:${studentId}`, templateKey: "WELCOME", studentId }));
}

/** Arrives as a "getting started" follow-up rather than alongside the welcome email. */
const FIRST_LOGIN_DELAY_MS = 15 * 60 * 1000;

/**
 * FIRST_LOGIN — exactly once per student, ever. The conditional UPDATE on
 * Student.firstLoginEmailAt is the claim: only the request that flips it
 * from NULL queues the email, so concurrent logins, later logins and
 * replays can never send it again. (Accounts that existed before the email
 * system were backfilled by the migration and never get it.)
 */
export function queueFirstLoginEmail(studentId: string) {
  return safely("first-login", async () => {
    const claimed = await prisma.student.updateMany({ where: { id: studentId, firstLoginEmailAt: null }, data: { firstLoginEmailAt: new Date() } });
    if (claimed.count !== 1) return;
    await enqueueEmail({
      idempotencyKey: `first-login:${studentId}`,
      templateKey: "FIRST_LOGIN",
      studentId,
      notBefore: new Date(Date.now() + FIRST_LOGIN_DELAY_MS),
    });
  });
}

/** FORGOT_PASSWORD notice — at most one per student per 10 minutes. */
export function queueForgotPasswordEmail(studentId: string) {
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  return safely("forgot-password", () => enqueueEmail({ idempotencyKey: `forgot-password:${studentId}:${bucket}`, templateKey: "FORGOT_PASSWORD", studentId }));
}

/** PASSWORD_RESET (password changed) — once per consumed reset token. */
export function queuePasswordChangedEmail(studentId: string, resetTokenId: string) {
  return safely("password-reset", () => enqueueEmail({ idempotencyKey: `password-reset:${resetTokenId}`, templateKey: "PASSWORD_RESET", studentId }));
}

interface PaidOrderFacts {
  id: string;
  studentId: string;
  orderNumber: string;
  amountPaise: number;
  productSnapshot: Prisma.JsonValue;
}

function orderVars(order: PaidOrderFacts, invoiceNumber: string | null, paymentId: string | null) {
  const snap = (order.productSnapshot ?? {}) as { name?: string };
  return {
    productName: snap.name ?? "Your purchase",
    amount: formatInr(order.amountPaise),
    orderNumber: order.orderNumber,
    invoiceNumber: invoiceNumber ?? "Not applicable",
    paymentId: paymentId ?? "Not applicable",
  };
}

/**
 * PAYMENT_SUCCESS — called INSIDE the fulfilment transaction, right where
 * the order becomes PAID (lib/payments/orders.ts), which only happens after
 * server-side verification (checkout signature + API re-fetch, signed
 * webhook, or reconciliation). One row per order (key `payment:<orderId>`),
 * committed atomically with the PAID status, so duplicate Razorpay events,
 * webhook retries and verify/webhook races can never queue a second email.
 * Deliberately not wrapped in `safely`: it is one INSERT … ON CONFLICT DO
 * NOTHING, and swallowing an error inside a Prisma transaction would leave
 * the transaction aborted anyway.
 */
export async function queuePaymentSuccessEmailTx(
  tx: Prisma.TransactionClient,
  order: PaidOrderFacts,
  invoice: { invoiceNumber: string } | null,
  gatewayPaymentId: string | null
) {
  await enqueueEmail(
    {
      idempotencyKey: `payment:${order.id}`,
      templateKey: "PAYMENT_SUCCESS",
      studentId: order.studentId,
      variables: orderVars(order, invoice?.invoiceNumber ?? null, gatewayPaymentId),
    },
    tx
  );
}

/** INVOICE — for an invoice issued after the payment (admin fulfilment repair). One per invoice. */
export async function queueInvoiceEmailTx(
  tx: Prisma.TransactionClient,
  order: PaidOrderFacts,
  invoice: { id: string; invoiceNumber: string },
  gatewayPaymentId: string | null
) {
  await enqueueEmail(
    {
      idempotencyKey: `invoice:${invoice.id}`,
      templateKey: "INVOICE",
      studentId: order.studentId,
      variables: orderVars(order, invoice.invoiceNumber, gatewayPaymentId),
    },
    tx
  );
}
