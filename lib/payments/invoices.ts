import "server-only";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Prisma, PaymentEnvironment } from "@prisma/client";
import { getInvoiceSettings, type InvoiceSettings } from "@/lib/payments/settings";

/**
 * Immutable invoices. The full snapshot (seller, customer, lines, tax,
 * payment reference) is frozen at issue time, so later price or settings
 * changes never alter an old invoice. Numbering is concurrency-safe: an
 * atomic INSERT ... ON CONFLICT DO UPDATE ... RETURNING on InvoiceCounter
 * (one row per prefix + financial year), plus the UNIQUE invoiceNumber.
 * TEST-environment invoices use their own "TEST-" series so they never
 * consume live invoice numbers.
 */

export interface InvoiceSnapshot {
  invoiceNumber: string;
  issuedAt: string;
  environment: PaymentEnvironment;
  seller: {
    legalName: string;
    tradeName: string;
    address: string;
    email: string;
    phone: string;
    gstin: string;
  };
  customer: { name: string; studentId: string; email: string | null; mobile: string | null };
  line: {
    description: string;
    productCode: string;
    sacCode: string;
    mrpPaise: number;
    saleDiscountPaise: number;
    couponCode: string | null;
    couponDiscountPaise: number;
    otherDiscountPaise: number;
    amountPaise: number;
  };
  tax: {
    mode: InvoiceSettings["taxMode"];
    ratePercent: number;
    split: InvoiceSettings["taxSplit"];
    taxablePaise: number;
    components: { label: string; paise: number }[];
  };
  totalPaise: number;
  currency: string;
  payment: { orderNumber: string; gatewayPaymentId: string | null; method: string | null; paidAt: string };
  footerNote: string;
}

/** Indian financial year label for a date, e.g. 2026-09-23 → "2026-27". */
export function financialYear(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

function sanitizePrefix(p: string): string {
  return (p || "MTS").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "MTS";
}

async function nextInvoiceNumber(tx: Prisma.TransactionClient, settings: InvoiceSettings, environment: PaymentEnvironment, at: Date) {
  const prefix = sanitizePrefix(settings.invoicePrefix);
  const fy = financialYear(at);
  const series = environment === "TEST" ? `TEST-${prefix}` : prefix;
  const key = `${series}/${fy}`;
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "InvoiceCounter" ("key", "value") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "value" = "InvoiceCounter"."value" + 1
    RETURNING "value"`;
  return `${key}/${String(rows[0].value).padStart(5, "0")}`;
}

function computeTax(settings: InvoiceSettings, totalPaise: number): InvoiceSnapshot["tax"] {
  const rate = Math.max(0, Math.min(100, Number(settings.taxRatePercent) || 0));
  if (settings.taxMode !== "INCLUSIVE" || rate === 0) {
    return { mode: "NONE", ratePercent: 0, split: settings.taxSplit, taxablePaise: totalPaise, components: [] };
  }
  const taxable = Math.round((totalPaise * 100) / (100 + rate));
  const tax = totalPaise - taxable;
  const components =
    settings.taxSplit === "CGST_SGST"
      ? [
          { label: `CGST @ ${rate / 2}%`, paise: Math.floor(tax / 2) },
          { label: `SGST @ ${rate / 2}%`, paise: tax - Math.floor(tax / 2) },
        ]
      : [{ label: `IGST @ ${rate}%`, paise: tax }];
  return { mode: "INCLUSIVE", ratePercent: rate, split: settings.taxSplit, taxablePaise: taxable, components };
}

/**
 * Issues the invoice for a fulfilled order inside the caller's transaction.
 * Idempotent: Invoice.orderId is UNIQUE, and an existing invoice is returned.
 */
export async function issueInvoiceTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  payment: { gatewayPaymentId: string | null; method: string | null; paidAt: Date }
) {
  const existing = await tx.invoice.findUnique({ where: { orderId } });
  if (existing) return existing;

  const order = await tx.paymentOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: { student: { select: { name: true, studentId: true, email: true, mobile: true } } },
  });
  const settings = await getInvoiceSettings();
  const issuedAt = new Date();
  const invoiceNumber = await nextInvoiceNumber(tx, settings, order.environment, issuedAt);
  const snap = order.productSnapshot as { name?: string; code?: string };

  const snapshot: InvoiceSnapshot = {
    invoiceNumber,
    issuedAt: issuedAt.toISOString(),
    environment: order.environment,
    seller: {
      legalName: settings.legalName,
      tradeName: settings.tradeName,
      address: settings.billingAddress,
      email: settings.supportEmail,
      phone: settings.supportPhone,
      gstin: settings.gstin,
    },
    customer: {
      name: order.student.name,
      studentId: order.student.studentId,
      email: order.student.email,
      mobile: order.student.mobile,
    },
    line: {
      description: snap.name ?? "Product",
      productCode: snap.code ?? "",
      sacCode: settings.sacCode,
      mrpPaise: order.mrpPaise,
      saleDiscountPaise: order.saleDiscountPaise,
      couponCode: order.couponCode,
      couponDiscountPaise: order.couponDiscountPaise,
      otherDiscountPaise: Math.max(0, order.mrpPaise - order.sellingPricePaise),
      amountPaise: order.amountPaise,
    },
    tax: computeTax(settings, order.amountPaise),
    totalPaise: order.amountPaise,
    currency: order.currency,
    payment: {
      orderNumber: order.orderNumber,
      gatewayPaymentId: payment.gatewayPaymentId,
      method: payment.method,
      paidAt: payment.paidAt.toISOString(),
    },
    footerNote: settings.footerNote,
  };

  return tx.invoice.create({
    data: {
      invoiceNumber,
      orderId,
      studentId: order.studentId,
      environment: order.environment,
      totalPaise: order.amountPaise,
      currency: order.currency,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      issuedAt,
    },
  });
}

/** "₹499.00" style for the PDF (Helvetica has no ₹ glyph, so "Rs."). */
function pdfMoney(paise: number): string {
  return `Rs. ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** WinAnsi-safe text for pdf-lib standard fonts; strips anything else. */
function pdfText(s: string | null | undefined): string {
  return (s ?? "").replace(/[^\x20-\x7E]/g, "").slice(0, 200);
}

export async function renderInvoicePdf(snapshot: InvoiceSnapshot): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.4, 0.4, 0.45);
  let y = 800;
  const left = 48;
  const right = 547;

  const text = (s: string, x: number, size = 10, f = font, color = ink) => page.drawText(pdfText(s), { x, y, size, font: f, color });
  const textRight = (s: string, size = 10, f = font) => {
    const t = pdfText(s);
    page.drawText(t, { x: right - f.widthOfTextAtSize(t, size), y, size, font: f, color: ink });
  };

  text(snapshot.seller.tradeName || snapshot.seller.legalName || "Invoice", left, 18, bold);
  textRight(snapshot.environment === "TEST" ? "TAX INVOICE (TEST MODE)" : snapshot.tax.mode === "NONE" ? "INVOICE" : "TAX INVOICE", 12, bold);
  y -= 18;
  if (snapshot.seller.legalName && snapshot.seller.legalName !== snapshot.seller.tradeName) {
    text(snapshot.seller.legalName, left, 9, font, muted);
    y -= 12;
  }
  for (const line of (snapshot.seller.address || "").split(/\r?\n/).filter(Boolean).slice(0, 4)) {
    text(line, left, 9, font, muted);
    y -= 12;
  }
  if (snapshot.seller.gstin) {
    text(`GSTIN: ${snapshot.seller.gstin}`, left, 9, font, muted);
    y -= 12;
  }
  if (snapshot.seller.email || snapshot.seller.phone) {
    text([snapshot.seller.email, snapshot.seller.phone].filter(Boolean).join("  |  "), left, 9, font, muted);
    y -= 12;
  }

  y -= 14;
  text("Invoice No:", left, 10, bold);
  text(snapshot.invoiceNumber, left + 80, 10);
  y -= 14;
  text("Invoice Date:", left, 10, bold);
  text(new Date(snapshot.issuedAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }), left + 80, 10);
  y -= 14;
  text("Order No:", left, 10, bold);
  text(snapshot.payment.orderNumber, left + 80, 10);

  y -= 26;
  text("Billed To", left, 10, bold);
  y -= 14;
  text(`${snapshot.customer.name} (${snapshot.customer.studentId})`, left, 10);
  y -= 13;
  if (snapshot.customer.email) {
    text(snapshot.customer.email, left, 9, font, muted);
    y -= 12;
  }
  if (snapshot.customer.mobile) {
    text(snapshot.customer.mobile, left, 9, font, muted);
    y -= 12;
  }

  y -= 16;
  page.drawLine({ start: { x: left, y: y + 12 }, end: { x: right, y: y + 12 }, thickness: 0.6, color: muted });
  text("Description", left, 10, bold);
  textRight("Amount", 10, bold);
  y -= 16;
  text(snapshot.line.description + (snapshot.line.sacCode ? `  (SAC ${snapshot.line.sacCode})` : ""), left, 10);
  textRight(pdfMoney(snapshot.line.mrpPaise));
  const rows: [string, number][] = [];
  if (snapshot.line.otherDiscountPaise) rows.push(["Discount", -snapshot.line.otherDiscountPaise]);
  if (snapshot.line.saleDiscountPaise) rows.push(["Sale discount", -snapshot.line.saleDiscountPaise]);
  if (snapshot.line.couponDiscountPaise) rows.push([`Coupon ${snapshot.line.couponCode ?? ""}`.trim(), -snapshot.line.couponDiscountPaise]);
  for (const [label, v] of rows) {
    y -= 14;
    text(label, left + 12, 9, font, muted);
    textRight(`- ${pdfMoney(-v)}`, 9);
  }
  y -= 10;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.6, color: muted });
  if (snapshot.tax.components.length) {
    y -= 16;
    text("Taxable value", left + 12, 9, font, muted);
    textRight(pdfMoney(snapshot.tax.taxablePaise), 9);
    for (const c of snapshot.tax.components) {
      y -= 14;
      text(c.label, left + 12, 9, font, muted);
      textRight(pdfMoney(c.paise), 9);
    }
  }
  y -= 20;
  text("Total paid", left, 12, bold);
  textRight(pdfMoney(snapshot.totalPaise), 12, bold);

  y -= 30;
  text("Payment", left, 10, bold);
  y -= 14;
  text(
    `Paid on ${new Date(snapshot.payment.paidAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}` +
      (snapshot.payment.method ? ` via ${snapshot.payment.method.toUpperCase()}` : "") +
      (snapshot.payment.gatewayPaymentId ? `  |  Ref ${snapshot.payment.gatewayPaymentId}` : ""),
    left,
    9,
    font,
    muted
  );

  y = 60;
  text(snapshot.footerNote || "", left, 8, font, muted);
  return doc.save();
}
