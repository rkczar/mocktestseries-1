import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStudent, StudentUnauthorizedError } from "@/lib/student-session";
import { renderInvoicePdf, type InvoiceSnapshot } from "@/lib/payments/invoices";

/** Student invoice PDF — ownership enforced by the studentId filter (no IDOR). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let studentId: string;
  try {
    studentId = (await requireStudent()).id;
  } catch (e) {
    if (e instanceof StudentUnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw e;
  }
  const { id } = await params;
  const invoice = await prisma.invoice.findFirst({ where: { id, studentId } });
  if (!invoice) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const pdf = await renderInvoicePdf(invoice.snapshot as unknown as InvoiceSnapshot);
  const name = invoice.invoiceNumber.replace(/[^A-Za-z0-9-]/g, "_");
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Invoice-${name}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
