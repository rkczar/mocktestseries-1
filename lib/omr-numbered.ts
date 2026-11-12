import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * Print-ready practice OMR with numbered options (1–4), for exams whose booklets number options
 * instead of lettering them (RPSC: Rajasthan Food Safety Officer, 150 questions). Separate from
 * lib/omr-sheet.ts buildOmrPdf (the A–D RUHS sheet), which stays byte-for-byte unchanged.
 *
 * Geometry is computed once by numberedOmrLayout() so the automated print check validates the exact
 * positions the PDF draws. The page leaves room for the download-time branding of brandOmrPdf()
 * (header band above y = height − 32, footer band below y = 30).
 */

export const A4 = { width: 595.28, height: 841.89 } as const;
export const MM = 72 / 25.4;
const SAFE = 36; // pt: printable on A4 and US Letter (Letter clips ~18 pt top/bottom when centred)

export interface NumberedOmrSpec {
  title: string;
  subtitle: string;
  questionCount: number;
  labels: string[];
  columns: number;
  fields: string[];
  instructions: string[];
}

export const FSO_OMR_SPEC: NumberedOmrSpec = {
  title: "Rajasthan Food Safety Officer (RPSC) — Practice OMR Sheet · 150 Questions",
  subtitle: "For self-practice only. Not an official RPSC document.",
  questionCount: 150,
  labels: ["1", "2", "3", "4"],
  columns: 5,
  fields: ["Name", "Roll No.", "Paper (year)", "Booklet Series", "Booklet No.", "Date", "Start time", "End time", "Signature"],
  instructions: [
    "1. Use a blue or black ball-point pen. Darken ONE bubble completely for each question.",
    "2. Every question has four options, numbered 1, 2, 3 and 4 (as in the RPSC question booklet).",
    "3. Each wrong answer deducts one-third (1/3) of the marks of that question. Darkening more than one bubble counts as a wrong answer;",
    "    a question left blank is not a wrong answer.",
    "4. After practising, enter your answers on mocktestseries.in to see your score and review.",
  ],
};

export interface OmrBubble {
  question: number;
  label: string;
  cx: number;
  cy: number;
  r: number;
}

export interface NumberedOmrLayout {
  page: { width: number; height: number };
  bubbles: OmrBubble[];
  numberX: (question: number) => number;
  rowPitch: number;
  gridTop: number;
  gridBottom: number;
  calibration: { x: number; y: number; lengthPt: number };
}

export function numberedOmrLayout(spec: NumberedOmrSpec = FSO_OMR_SPEC): NumberedOmrLayout {
  const { width, height } = A4;
  const rows = Math.ceil(spec.questionCount / spec.columns);
  const gridTop = height - 222;
  const gridBottom = 82;
  const rowPitch = (gridTop - gridBottom) / (rows - 1);
  const colW = (width - 2 * SAFE) / spec.columns;
  const r = 5.5;
  const bubbleGap = 18.5;
  const bubbles: OmrBubble[] = [];
  for (let q = 0; q < spec.questionCount; q++) {
    const c = Math.floor(q / rows);
    const row = q % rows;
    const x = SAFE + c * colW;
    const cy = gridTop - row * rowPitch;
    spec.labels.forEach((label, i) => bubbles.push({ question: q + 1, label, cx: x + 32 + i * bubbleGap, cy, r }));
  }
  return {
    page: { width, height },
    bubbles,
    numberX: (question) => SAFE + Math.floor((question - 1) / rows) * colW,
    rowPitch,
    gridTop,
    gridBottom,
    calibration: { x: SAFE, y: 48, lengthPt: 100 * MM },
  };
}

export async function buildNumberedOmrPdf(spec: NumberedOmrSpec = FSO_OMR_SPEC): Promise<Uint8Array> {
  const layout = numberedOmrLayout(spec);
  const pdf = await PDFDocument.create();
  pdf.setTitle(spec.title);
  pdf.setProducer("mocktestseries.in");
  const page = pdf.addPage([A4.width, A4.height]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.1);
  const muted = rgb(0.4, 0.4, 0.4);
  const { width, height } = A4;

  page.drawText(spec.title, { x: SAFE, y: height - 56, size: 11.5, font: bold, color: ink });
  page.drawText(spec.subtitle, { x: SAFE, y: height - 70, size: 8, font, color: muted });

  // Candidate and booklet details: 3 per row.
  const fieldW = (width - 2 * SAFE) / 3;
  spec.fields.forEach((f, i) => {
    const x = SAFE + (i % 3) * fieldW;
    const y = height - 92 - Math.floor(i / 3) * 20;
    page.drawText(`${f}:`, { x, y, size: 8.5, font, color: ink });
    const lw = font.widthOfTextAtSize(`${f}:`, 8.5) + 4;
    page.drawLine({ start: { x: x + lw, y: y - 2 }, end: { x: x + fieldW - 10, y: y - 2 }, thickness: 0.6, color: ink });
  });

  // Instructions box.
  const boxTop = height - 142;
  const boxH = 8 + spec.instructions.length * 10;
  page.drawRectangle({ x: SAFE, y: boxTop - boxH, width: width - 2 * SAFE, height: boxH, borderColor: muted, borderWidth: 0.6 });
  spec.instructions.forEach((line, i) => page.drawText(line, { x: SAFE + 6, y: boxTop - 12 - i * 10, size: 7.2, font, color: ink }));

  // Bubble grid with a light rule every 5 rows and between columns.
  const rows = Math.ceil(spec.questionCount / spec.columns);
  const colW = (width - 2 * SAFE) / spec.columns;
  for (let c = 1; c < spec.columns; c++) {
    const x = SAFE + c * colW - 4;
    page.drawLine({ start: { x, y: layout.gridTop + 12 }, end: { x, y: layout.gridBottom - 10 }, thickness: 0.4, color: rgb(0.8, 0.8, 0.8) });
  }
  for (let row = 5; row < rows; row += 5) {
    const y = layout.gridTop - (row - 0.5) * layout.rowPitch;
    page.drawLine({ start: { x: SAFE, y }, end: { x: width - SAFE, y }, thickness: 0.3, color: rgb(0.85, 0.85, 0.85) });
  }
  for (let q = 1; q <= spec.questionCount; q++) {
    const label = String(q).padStart(3, " ");
    const first = layout.bubbles[(q - 1) * spec.labels.length];
    page.drawText(label, { x: layout.numberX(q) + 22 - bold.widthOfTextAtSize(label, 8.5), y: first.cy - 3, size: 8.5, font: bold, color: ink });
  }
  for (const b of layout.bubbles) {
    page.drawCircle({ x: b.cx, y: b.cy, size: b.r, borderColor: ink, borderWidth: 0.7 });
    page.drawText(b.label, { x: b.cx - font.widthOfTextAtSize(b.label, 6.5) / 2, y: b.cy - 2.3, size: 6.5, font, color: ink });
  }

  // 100 mm calibration bar: print at "Actual size / 100%" and it must measure 100 mm.
  const cal = layout.calibration;
  page.drawLine({ start: { x: cal.x, y: cal.y }, end: { x: cal.x + cal.lengthPt, y: cal.y }, thickness: 1, color: ink });
  for (const t of [0, cal.lengthPt]) page.drawLine({ start: { x: cal.x + t, y: cal.y - 3 }, end: { x: cal.x + t, y: cal.y + 3 }, thickness: 1, color: ink });
  page.drawText("Print check: this bar must measure 100 mm (print at Actual size / 100%).", { x: cal.x + cal.lengthPt + 8, y: cal.y - 2.5, size: 7, font, color: muted });

  return pdf.save();
}
