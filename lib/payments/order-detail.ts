import type { Prisma } from "@prisma/client";

/** What a payment order detail view loads (Admin → Payments → Order and the Teacher Portal). */
export const ORDER_DETAIL_INCLUDE = {
  student: { select: { id: true, name: true, studentId: true } },
  product: { select: { id: true, name: true, code: true, examId: true } },
  payments: { orderBy: { createdAt: "asc" } },
  refunds: { orderBy: { createdAt: "asc" } },
  entitlement: true,
  invoice: { select: { id: true, invoiceNumber: true, issuedAt: true } },
  couponRedemption: true,
} satisfies Prisma.PaymentOrderInclude;

export type OrderDetail = Prisma.PaymentOrderGetPayload<{ include: typeof ORDER_DETAIL_INCLUDE }>;
