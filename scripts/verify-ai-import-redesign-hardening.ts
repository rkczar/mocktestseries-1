/**
 * P1 hardening after the 2026-11-19 seven-paper replay (pure — no DB, no AI). Real OCR coordinates from the replay:
 *   1. footer row above the fixed band ("KCSP-A-GMPK" + "(3-A)" at 0.88 of CMS 2024 P-I scan p3) is furniture;
 *      "[P.T.O." anywhere is furniture; a bare "4" as the last row (CMS 2026 P-I p2, a statement value) is NOT.
 *   2. "41." overlapping its stem by 14 px (CMS 2026 P-I p9) is attached to the right column.
 *   3. STRONG_FOOTER (the readiness residue check) — footer text yes; "COVID-19", "1-A, 2-B" no.
 *   npx tsx scripts/verify-ai-import-redesign-hardening.ts
 */
import { attachNumberBoxes, dropFooterRow, findGutter, isFurniture, layoutOcrPage, STRONG_FOOTER, type LayoutLine } from "@/lib/ai-import/ocr-layout";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
const L = (text: string, box: number[], score = 0.99) => ({ text, box: box as [number, number, number, number], score });

// 1. CMS 2024 P-I scan page 3 bottom (W 1595, H 2119): footer row at y 0.8795.
const p3 = layoutOcrPage({
  engine: "t", width: 1595, height: 2119, dpi: 200, ink: 0.05, rereads: 0, seconds: 0,
  lines: [
    L("12. Consider the following statements :", [80, 1500, 700, 1540]),
    L("(c) 1,3 and 4", [120, 1700, 400, 1740]),
    L("(d) 2,3 and 4", [120, 1760, 400, 1800]),
    L("KCSP-A-GMPK", [80.6, 1868.0, 281.0, 1900.1]),
    L("(3-A)", [712.7, 1863.7, 827.2, 1905.4]),
  ],
});
check("1a footer row (booklet code + page number with series) above the band is removed", p3.lines.every((l) => !/KCSP|\(3-A\)/.test(l.text)) && p3.furniture.includes("(3-A)"), p3.lines.map((l) => l.text));
check("1b \"[P.T.O.\" / \"[ P.T.O.\" are furniture anywhere on the page", isFurniture("[ P.T.O.", { x: 0.8, y: 0.877, w: 0.07, h: 0.02 }) && isFurniture("[P.T.O.", { x: 0.5, y: 0.5, w: 0.07, h: 0.02 }));
check("1c \"SPACE FOR ROUGH WORK\" stays in the text mid-page (rough-work page detection reads it)", !isFurniture("SPACE FOR ROUGH WORK", { x: 0.3, y: 0.5, w: 0.4, h: 0.02 }));
const p2: LayoutLine[] = [
  { text: "3. Proteinuria", box: { x: 0.37, y: 0.83, w: 0.2, h: 0.016 }, conf: 0.99 },
  { text: "4", box: { x: 0.37, y: 0.868, w: 0.018, h: 0.016 }, conf: 0.99 },
];
check("1d a bare number as the last row (a statement value) is never dropped as a footer", dropFooterRow(p2).length === 0 && p2.length === 2);
const covid: LayoutLine[] = [
  { text: "(b) Influenza and", box: { x: 0.1, y: 0.83, w: 0.3, h: 0.016 }, conf: 0.99 },
  { text: "COVID-19", box: { x: 0.12, y: 0.86, w: 0.1, h: 0.016 }, conf: 0.99 },
];
check("1e a wrapped last line \"COVID-19\" is never dropped as a booklet code", dropFooterRow(covid).length === 0);

// 2. CMS 2026 P-I page 9 (W 1541): "41." [738–826] overlaps its stem starting at 812.
const W = 1541, H = 2118;
const nb = (text: string, b: number[]): LayoutLine => ({ text, box: { x: b[0] / W, y: b[1] / H, w: (b[2] - b[0]) / W, h: (b[3] - b[1]) / H }, conf: 0.99 });
const p9 = [
  nb("40.", [70, 1452, 141, 1483]),
  nb("Which one of the following is true regarding", [150, 1452, 700, 1490]),
  nb("41.", [738, 149, 826, 182]),
  nb("Which of the following are the clinical features", [812, 142, 1439, 182]),
  nb("of multiple sclerosis ?", [827, 185, 1113, 223]),
  ...[1, 2, 3, 4].map((i) => nb(`${i}.`, [826, 190 + 50 * i, 865, 225 + 50 * i])),
  ...[1, 2, 3, 4].map((i) => nb(`Statement ${i}`, [900, 190 + 50 * i, 1300, 225 + 50 * i])),
  ...Array.from({ length: 8 }, (_, i) => nb(`left column line ${i}`, [70, 300 + 60 * i, 690, 335 + 60 * i])),
];
const g = findGutter(p9);
check("2a page 9 has a gutter between the columns", g !== null && g > 0.45 && g < 0.56, g);
attachNumberBoxes(p9, g!);
const n41 = p9.find((l) => l.text === "41.")!;
check("2b \"41.\" overlapping its stem by 14 px is moved to the right column", n41.box.x >= g!, { x: n41.box.x, g });
check("2c a left-column number keeps its place", p9.find((l) => l.text === "40.")!.box.x < g!);

// 3. Residue check pattern.
check("3a footer residue recognised", ["[P.T.O.", "[ P.T.O.", "(3-A)", "(19-A)", "KCSP-A-GMPK", "KCSP-B-SGOP/77A"].every((t) => STRONG_FOOTER(t)));
check("3b ordinary option text is not residue", ["COVID-19", "1-A, 2-B, 3-C", "2, 3 and 4", "HbA1c", "A-4", "Type-2"].every((t) => !STRONG_FOOTER(t)));

console.log(`\nredesign-hardening: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
