import "server-only";
import {
  PDFDocument,
  PDFArray,
  PDFString,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import { prisma } from "@/lib/prisma";
import { BRAND_NAME } from "@/lib/brand";

/**
 * The one canonical Practice OMR pipeline. Every OMR download on the site —
 * Public Homepage, Student Dashboard, Student → Practice with OMR, the Public
 * Exam Page, the Mock Test Series landing page, and the result page's print
 * kit — goes through app/api/student/test-resources/[id]/route.ts, which runs
 * the stored OMR_TEMPLATE file through brandOmrPdf() below. Branding is
 * applied at download time rather than baked into the stored file, so an
 * admin-uploaded OMR and a generated one get exactly the same treatment and
 * the stored functional sheet is never modified.
 */

export const SITE_URL = "https://mocktestseries.in/";
const SITE_HOST = "mocktestseries.in";
export const OMR_DOWNLOAD_FILENAME = "MockTestSeries-OMR-Practice-Sheet.pdf";

const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.35, 0.35, 0.35);
const RULE = rgb(0.75, 0.75, 0.75);
const WATERMARK = rgb(0.5, 0.5, 0.5);
const WATERMARK_OPACITY = 0.07;

/** Raw functional OMR sheet (A4, A–D bubbles). Used by setup scripts to create a stored OMR_TEMPLATE file. */
export async function buildOmrPdf(title: string, questionCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = INK;
  const { width, height } = page.getSize();

  page.drawText(title, { x: 40, y: height - 50, size: 14, font: bold, color: ink });
  page.drawText("Practice OMR Answer Sheet — for self-practice only. Fill one bubble per question with a dark pen.", {
    x: 40, y: height - 68, size: 8.5, font, color: ink,
  });
  const fields = ["Name", "Roll No.", "Mock Test No.", "Date", "Start time", "End time"];
  fields.forEach((f, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 40 + col * 175;
    const y = height - 98 - row * 26;
    page.drawText(`${f}:`, { x, y, size: 9, font, color: ink });
    page.drawLine({ start: { x: x + 62, y: y - 2 }, end: { x: x + 165, y: y - 2 }, thickness: 0.6, color: ink });
  });

  const cols = 4;
  const perCol = Math.ceil(questionCount / cols);
  const top = height - 170;
  const rowH = Math.min(24, (top - 60) / perCol);
  const colW = (width - 80) / cols;
  const opts = ["A", "B", "C", "D"];
  for (let q = 0; q < questionCount; q++) {
    const c = Math.floor(q / perCol);
    const r = q % perCol;
    const x = 40 + c * colW;
    const y = top - r * rowH;
    page.drawText(String(q + 1).padStart(3, " "), { x, y: y - 3, size: 8.5, font: bold, color: ink });
    opts.forEach((o, i) => {
      const cx = x + 30 + i * 22;
      page.drawCircle({ x: cx, y, size: 7, borderColor: ink, borderWidth: 0.7 });
      page.drawText(o, { x: cx - 2.6, y: y - 2.8, size: 7, font, color: ink });
    });
  }
  page.drawText("MockTestSeries.in — enter these answers online via Test Series > Enter OMR Answers to get your score and review.", {
    x: 40, y: 30, size: 7.5, font, color: ink,
  });
  return pdf.save();
}

/**
 * The official Instagram profile, read from the PUBLISHED Homepage Footer
 * (Admin → Homepage Builder → Footer → Instagram URL) — the same value the
 * public site footer links to. Never guessed: returns null unless it is a
 * plain https instagram.com profile URL.
 */
export async function getOfficialInstagram(): Promise<{ url: string; handle: string } | null> {
  const footer = await prisma.homepageSection.findFirst({
    where: { key: "FOOTER", homepageConfig: { status: "PUBLISHED" } },
    orderBy: { homepageConfig: { version: "desc" } },
    select: { content: true },
  });
  const raw = (footer?.content as Record<string, unknown> | null)?.instagramUrl;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || !/^(www\.)?instagram\.com$/i.test(u.hostname)) return null;
    const handle = u.pathname.split("/").filter(Boolean)[0];
    if (!handle || !/^[A-Za-z0-9._]{1,30}$/.test(handle)) return null;
    return { url: u.toString(), handle: `@${handle}` };
  } catch {
    return null;
  }
}

/**
 * The OMR sheet the Homepage and Student Dashboard cards download: the
 * student's active exam's global OMR when there is one, otherwise the first
 * active global OMR by admin order. Global = not tied to a single mock test,
 * so the download route serves it without a login.
 */
export async function findPracticeOmrSheet(preferExamId?: string | null) {
  const sheets = await prisma.testResource.findMany({
    where: { type: "OMR_TEMPLATE", isActive: true, mockTestId: null },
    orderBy: [{ order: "asc" }, { createdAt: "desc" }],
    select: { id: true, title: true, questionCount: true, examId: true },
  });
  return (preferExamId ? sheets.find((s) => s.examId === preferExamId) : undefined) ?? sheets[0] ?? null;
}

function addLink(pdf: PDFDocument, page: PDFPage, rect: [number, number, number, number], url: string) {
  const annot = pdf.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: rect,
    Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
  });
  page.node.addAnnot(pdf.context.register(annot));
}

function linkedText(pdf: PDFDocument, page: PDFPage, text: string, x: number, y: number, size: number, font: PDFFont, url: string) {
  page.drawText(text, { x, y, size, font, color: INK });
  const w = font.widthOfTextAtSize(text, size);
  addLink(pdf, page, [x - 1, y - 2.5, x + w + 1, y + size], url);
  return w;
}

/** Moves the page's most recently added content stream to the front, so it paints underneath the original sheet. */
function sendLastStreamToBack(page: PDFPage) {
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray) || contents.size() < 2) return;
  const last = contents.get(contents.size() - 1) as PDFRef;
  contents.remove(contents.size() - 1);
  contents.insert(0, last);
  // Make pdf-lib start a fresh stream (appended on top) for the next drawing.
  const p = page as unknown as { contentStream?: unknown; contentStreamRef?: unknown };
  p.contentStream = undefined;
  p.contentStreamRef = undefined;
}

function drawInstagramGlyph(page: PDFPage, x: number, y: number, s: number) {
  // Outline camera glyph (rounded square + lens + dot), drawn as vectors — no image asset.
  const r = s * 0.3;
  page.drawSvgPath(
    `M${r} 0 H${s - r} A${r} ${r} 0 0 1 ${s} ${r} V${s - r} A${r} ${r} 0 0 1 ${s - r} ${s} H${r} A${r} ${r} 0 0 1 0 ${s - r} V${r} A${r} ${r} 0 0 1 ${r} 0 Z`,
    { x, y: y + s, borderColor: INK, borderWidth: 0.7 }
  );
  page.drawCircle({ x: x + s / 2, y: y + s / 2, size: s * 0.23, borderColor: INK, borderWidth: 0.7 });
  page.drawCircle({ x: x + s * 0.76, y: y + s * 0.76, size: s * 0.06, color: INK });
}

/**
 * Stamps MockTestSeries.in branding onto every page of an OMR sheet without
 * moving any of its content: a clickable brand line in the top margin, a very
 * light repeating watermark painted underneath the sheet, and a footer with
 * clickable website and (when configured) official Instagram links. Page size
 * and every bubble/number stay exactly where the source file put them.
 */
export async function brandOmrPdf(
  source: Uint8Array,
  opts: { instagram: { url: string; handle: string } | null }
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(source);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();

    // Watermark — staggered rows, low opacity, underneath the sheet.
    const wmSize = 20;
    const wmW = bold.widthOfTextAtSize(BRAND_NAME, wmSize);
    let row = 0;
    for (let y = height - 150; y > 60; y -= 130, row++) {
      const offset = row % 2 === 0 ? 0 : (width - wmW) / 2 - 40;
      const xs = row % 2 === 0 ? [50, width - wmW - 50] : [offset + 40];
      for (const x of xs) {
        page.drawText(BRAND_NAME, { x, y, size: wmSize, font: bold, color: WATERMARK, opacity: WATERMARK_OPACITY });
      }
    }
    sendLastStreamToBack(page);

    // Header — brand (linked) left, "Practice OMR Sheet" right, hairline below.
    const headY = height - 24;
    linkedText(pdf, page, BRAND_NAME, 40, headY, 12, bold, SITE_URL);
    const label = "Practice OMR Sheet";
    page.drawText(label, { x: width - 40 - font.widthOfTextAtSize(label, 9), y: headY + 1, size: 9, font, color: MUTED });
    page.drawLine({ start: { x: 40, y: headY - 6 }, end: { x: width - 40, y: headY - 6 }, thickness: 0.4, color: RULE });

    // Footer — hairline, brand + website (both linked) left, Instagram right.
    const footY = 11;
    page.drawLine({ start: { x: 40, y: footY + 11 }, end: { x: width - 40, y: footY + 11 }, thickness: 0.4, color: RULE });
    let x = 40;
    x += linkedText(pdf, page, BRAND_NAME, x, footY, 8, bold, SITE_URL) + 14;
    page.drawText("Website:", { x, y: footY, size: 8, font, color: MUTED });
    x += font.widthOfTextAtSize("Website: ", 8);
    linkedText(pdf, page, SITE_HOST, x, footY, 8, font, SITE_URL);

    if (opts.instagram) {
      const handleW = font.widthOfTextAtSize(opts.instagram.handle, 8);
      const glyph = 8;
      const hx = width - 40 - handleW;
      const gx = hx - glyph - 4;
      drawInstagramGlyph(page, gx, footY - 1, glyph);
      page.drawText(opts.instagram.handle, { x: hx, y: footY, size: 8, font, color: INK });
      addLink(pdf, page, [gx - 1, footY - 2.5, hx + handleW + 1, footY + 8], opts.instagram.url);
    }
  }

  pdf.setTitle(`${BRAND_NAME} — Practice OMR Sheet`);
  pdf.setAuthor(BRAND_NAME);
  pdf.setCreator(SITE_URL);
  return pdf.save();
}
