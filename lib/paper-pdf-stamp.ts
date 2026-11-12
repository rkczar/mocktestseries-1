import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * Per-download licence line on every page of a paid paper PDF ("Licensed to 98******21 · 13 Nov 2026"),
 * drawn in the bottom margin on top of the stored file. Deterrence against re-sharing, not DRM.
 */
export async function stampPaperPdf(bytes: Uint8Array, licensee: string, when: Date = new Date()): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const date = when.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  // StandardFonts are WinAnsi: keep the line ASCII.
  const line = `Licensed to ${licensee} - ${date} - personal use only, do not share`.replace(/[^\x20-\x7E]/g, "");
  for (const page of doc.getPages()) {
    const { width } = page.getSize();
    const size = 6.5;
    page.drawText(line, { x: (width - font.widthOfTextAtSize(line, size)) / 2, y: 22, size, font, color: rgb(0.35, 0.35, 0.35) });
  }
  return doc.save();
}
