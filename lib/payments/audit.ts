import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Payment-area audit trail, written to the existing AuditLog table with
 * entityType prefixed "Payment". Metadata must be safe before/after facts
 * only — callers never pass secrets (credential saves log booleans such as
 * "keySecretRotated", never values).
 */

export type PaymentAuditAction =
  | "PAYMENT_MODE_CHANGED"
  | "PRODUCT_CREATED"
  | "PRODUCT_UPDATED"
  | "COUPON_CREATED"
  | "COUPON_UPDATED"
  | "COUPON_DEACTIVATED"
  | "GATEWAY_CREDENTIALS_UPDATED"
  | "GATEWAY_TESTED"
  | "ENTITLEMENT_GRANTED"
  | "ENTITLEMENT_REVOKED"
  | "REFUND_REQUESTED"
  | "INVOICE_SETTINGS_UPDATED"
  | "PAYMENT_POLICY_UPDATED"
  | "ORDER_RECONCILED";

export async function logPaymentAudit(
  actorId: string | undefined,
  action: PaymentAuditAction,
  entityType: "PaymentSettings" | "Product" | "Coupon" | "PaymentGateway" | "StudentEntitlement" | "Refund" | "PaymentOrder",
  entityId: string | null,
  metadata?: Record<string, unknown>
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId,
      action,
      entityType,
      entityId,
      metadata: metadata ? (JSON.parse(JSON.stringify(metadata)) as object) : undefined,
    },
  });
}

export const PAYMENT_AUDIT_ENTITY_TYPES = [
  "PaymentSettings",
  "Product",
  "Coupon",
  "PaymentGateway",
  "StudentEntitlement",
  "Refund",
  "PaymentOrder",
];
