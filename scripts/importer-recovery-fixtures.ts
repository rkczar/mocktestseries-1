/**
 * Synthetic BILINGUAL scanned paper for scripts/verify-importer-recovery.ts (importer recovery, 2026-11-11) — no real
 * exam content except the Pinacol / Kw wording, copied as test text. Writes into <dir>:
 *   recovery-paper.pdf — 3 scanned pages (1240×1754 images), Q1–Q11 with Q8 NOT read by the first pass;
 *   mock-vision.json   — what the mock vision reader (scripts/mock-openrouter-vision.mjs) returns per marker.
 *
 * Markers (the mock decodes the colour square at the TOP-RIGHT corner of the image it receives):
 *   1/2/3 — whole pages 1/2/3 (the first reading, and whole-page re-scans);
 *   4 — the band of Q2 on page 1 (a question-level cut-out re-scan; drawn where that band starts);
 *   7 — the band between Q7 and Q9 on page 2 (the missing Q8; marker 5 is the mock's built-in synthetic paper);
 *   6 — Q10's band at the end of page 2, stacked with the top of page 3 (a question across two pages).
 * A cut-out that starts anywhere else carries no marker, so the mock answers "nothing recognized" (NOT_FOUND).
 *
 *   npx tsx scripts/importer-recovery-fixtures.ts <dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: importer-recovery-fixtures.ts <dir>");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

// Same palette as the mock (scripts/mock-openrouter-vision.mjs; 7 and 8 added for this suite).
const PALETTE: [number, number, number][] = [[0, 0, 0], [230, 0, 0], [0, 150, 0], [0, 0, 230], [240, 140, 0], [150, 0, 150], [0, 160, 170], [255, 230, 0], [120, 60, 20]];
const W = 1240;
const H = 1754;
/** Re-scan band margin (lib/ai-import/rescan-target.ts BAND_PAD): a band starts this far above a question's region. */
const PAD = 0.025;

const marker = (n: number, yFrac: number) => {
  const [r, g, b] = PALETTE[n];
  return `<rect x="${W - 80}" y="${Math.floor(yFrac * H)}" width="80" height="${Math.round(0.035 * H)}" fill="rgb(${r},${g},${b})"/>`;
};
const box = (x: number, y: number, w: number, h: number, fill = "#9ab") => `<rect x="${x * W}" y="${y * H}" width="${w * W}" height="${h * H}" fill="${fill}"/>`;
const text = (y: number, s: string) => `<text x="60" y="${y * H}" font-size="26" font-family="DejaVu Sans">${s}</text>`;
async function page(parts: string[]): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fafaf7"/>${parts.join("")}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Regions of the first reading (fractions; the mock returns them as 0–1000 integers). */
const R = {
  q1: { x: 0.05, y: 0.06, w: 0.9, h: 0.22 },
  q2: { x: 0.05, y: 0.32, w: 0.9, h: 0.13 },
  q3: { x: 0.05, y: 0.47, w: 0.9, h: 0.12 },
  q4: { x: 0.05, y: 0.62, w: 0.9, h: 0.12 },
  q5: { x: 0.05, y: 0.77, w: 0.9, h: 0.2 },
  q6: { x: 0.05, y: 0.05, w: 0.9, h: 0.15 },
  q7: { x: 0.05, y: 0.22, w: 0.9, h: 0.18 },
  q9: { x: 0.05, y: 0.62, w: 0.9, h: 0.15 },
  q10: { x: 0.05, y: 0.82, w: 0.9, h: 0.16 },
  q10b: { x: 0.05, y: 0.02, w: 0.9, h: 0.15 },
  q11: { x: 0.05, y: 0.2, w: 0.9, h: 0.15 },
};
const k = (b: { x: number; y: number; w: number; h: number }) => ({ x: Math.round(b.x * 1000), y: Math.round(b.y * 1000), w: Math.round(b.w * 1000), h: Math.round(b.h * 1000) });
const opts = (xs: string[]) => xs.map((t, i) => ({ label: `(${i + 1})`, text: t }));
const hi = (stem: string, options: string[], extra: Record<string, unknown> = {}) => ({ stem, options: opts(options), confidence: 0.95, unreadable: [], same_option_order: true, figures_differ: false, ...extra });

// Q1 — Hindi stem, four chemical-structure options (LaTeX + a cropped image each). Option D's LaTeX has one O less
// than its image description (the formula / image consistency warning).
const pinacol = [
  "$$\\text{H}_3\\text{C}-\\underset{\\underset{\\text{CH}_3}{|}}{\\overset{\\overset{\\text{CH}_3}{|}}{\\text{C}}}-\\underset{\\underset{\\text{OH}}{|}}{\\overset{\\overset{\\text{CH}_3}{|}}{\\text{C}}}-\\text{CH}_3$$",
  "$$\\text{H}_3\\text{C}-\\underset{\\underset{\\text{OH}}{|}}{\\overset{\\overset{\\text{CH}_3}{|}}{\\text{C}}}-\\underset{\\underset{\\text{OH}}{|}}{\\overset{\\overset{\\text{CH}_3}{|}}{\\text{C}}}-\\text{CH}_3$$",
  "$$\\text{H}_3\\text{C}-\\overset{\\overset{\\text{CH}_3}{|}}{\\text{CH}}-\\underset{\\underset{\\text{OH}}{|}}{\\overset{\\overset{\\text{CH}_3}{|}}{\\text{C}}}-\\text{CH}_3$$",
  "$$\\text{CH}_3-\\underset{\\underset{\\text{H}}{|}}{\\overset{\\overset{\\text{H}}{|}}{\\text{C}}}-\\underset{\\underset{\\text{OH}}{|}}{\\overset{\\overset{\\text{H}}{|}}{\\text{C}}}-\\text{CH}_3$$",
];
const pinacolDesc = ["Chemical structure: H3C - C(CH3)(CH3) - C(CH3)(OH) - CH3", "Chemical structure: H3C - C(CH3)(OH) - C(CH3)(OH) - CH3", "Chemical structure: H3C - CH(CH3) - C(CH3)(OH) - CH3", "Chemical structure: CH3 - C(H)(OH) - C(H)(OH) - CH3"];
const optFig = (i: number) => ({ x: 0.1 + i * 0.21, y: 0.17, w: 0.18, h: 0.09 });
const q1 = { number: 1, type: "SINGLE_CORRECT", stem: "Chemical structure of Pinacol is", options: opts(pinacol), figures: pinacol.map((_, i) => ({ owner: "OPTION", option_label: `(${i + 1})`, box: k(optFig(i)), description: pinacolDesc[i] })), region: k(R.q1), confidence: 0.95, printed_answer: [], hi: hi("पिनेकॉल की रासायनिक संरचना है", pinacol) };
// Q2 — first read garbled; the cut-out re-scan reads it correctly (Hindi stem, English technical options).
const cell = ["Mitochondria", "Ribosome", "Golgi body", "Lysosome"];
const q2bad = { number: 2, type: "SINGLE_CORRECT", stem: "Garbled: powerh0use of cel", options: opts(cell), region: k(R.q2), confidence: 0.6, printed_answer: [], hi: hi("कोशिका का ऊर्जा घर कौन है?", cell) };
const q2good = { number: 2, type: "SINGLE_CORRECT", stem: "Which is the powerhouse of the cell?", options: opts(cell), region: { x: 50, y: 139, w: 900, h: 722 }, confidence: 0.97, printed_answer: [], hi: hi("कोशिका का ऊर्जा घर कौन है?", cell) };
// Q3 — Hindi stem with a formula, numeric/unit options.
const kw = ["$1 \\times 10^{-14}\\text{ M}^{2}$", "$1 \\times 10^{-7}\\text{ M}$", "$1 \\times 10^{-14}\\text{ M}$", "$1 \\times 10^{-9}\\text{ M}^{2}$"];
const q3 = { number: 3, type: "SINGLE_CORRECT", stem: "The value of $\\text{K}_{\\text{w}}$ at 298 K is", options: opts(kw), region: k(R.q3), confidence: 0.95, printed_answer: [], explanation: "Ionic product of water at 298 K.", hi: hi("298 K पर $\\text{K}_{\\text{w}}$ का मान है", kw) };
// Q4 — a GENUINE Hindi OCR error (a vowel sign without its letter): must still block, naming the field.
const metals = ["Iron", "Copper", "Zinc", "Lead"];
const q4 = { number: 4, type: "SINGLE_CORRECT", stem: "Which metal is used in galvanisation?", options: opts(metals), region: k(R.q4), confidence: 0.95, printed_answer: [], hi: hi("जस्तीकरण में ि कस धातु का प्रयोग होता है", ["लोहा", "तांबा", "जस्ता", "सीसा"]) };
// Q5 — Match the Following: English List I / List II, the Hindi lists inside the Hindi question text.
const mtfOpts = ["A-1, B-2, C-3, D-4", "A-2, B-1, C-4, D-3", "A-3, B-4, C-1, D-2", "A-4, B-3, C-2, D-1"];
const q5 = {
  number: 5,
  type: "MATCH_THE_FOLLOWING",
  stem: "Match List I with List II",
  list_i: [{ key: "A", text: "Vitamin A" }, { key: "B", text: "Vitamin B1" }, { key: "C", text: "Vitamin C" }, { key: "D", text: "Vitamin D" }],
  list_ii: [{ key: "1", text: "Night blindness" }, { key: "2", text: "Beri-beri" }, { key: "3", text: "Scurvy" }, { key: "4", text: "Rickets" }],
  options: opts(mtfOpts),
  region: k(R.q5),
  confidence: 0.95,
  printed_answer: [],
  hi: hi("सूची I को सूची II से सुमेलित कीजिए\nA. विटामिन A  B. विटामिन B1  C. विटामिन C  D. विटामिन D\n1. रतौंधी  2. बेरी-बेरी  3. स्कर्वी  4. रिकेट्स", mtfOpts),
};
const simple = (n: number, region: { x: number; y: number; w: number; h: number }, extra: Record<string, unknown> = {}) => ({ number: n, type: "SINGLE_CORRECT", stem: `Synthetic recovery question ${n}: which option is correct?`, options: opts(["Alpha", "Beta", "Gamma", "Delta"].map((t) => `${t} ${n}`)), region: k(region), confidence: 0.95, printed_answer: [], hi: hi(`कृत्रिम प्रश्न ${n}: कौन सा विकल्प सही है?`, ["अल्फा", "बीटा", "गामा", "डेल्टा"].map((t) => `${t} ${n}`)), ...extra });
// Q10 — starts at the end of page 2, its options on page 3 (option D is an image on page 3).
const q10first = { ...simple(10, R.q10), options: [], continues_on_next_page: true, hi: hi("कृत्रिम प्रश्न 10 (दो पृष्ठों पर): कौन सा विकल्प सही है?", []) };
const q10fig = { x: 0.6, y: 0.05, w: 0.25, h: 0.07 };
const q10cont = { number: null, type: "SINGLE_CORRECT", stem: "", continued_from_previous_page: true, options: opts(["Alpha 10", "Beta 10", "Gamma 10", "(figure)"]), figures: [{ owner: "OPTION", option_label: "(4)", box: k(q10fig), description: "Diagram for option D" }], region: k(R.q10b), confidence: 0.95, printed_answer: [], hi: hi("", ["अल्फा 10", "बीटा 10", "गामा 10", "(चित्र)"]) };
// The stacked cut-out of Q10: page 2 from Q10's band start to the bottom, then page 3 down to Q11 (+ margin).
const h1 = 1 - (R.q10.y - PAD);
const h2 = R.q11.y + PAD;
const sy = (pageY: number) => h1 / (h1 + h2) + pageY / (h1 + h2);
const q10stacked = {
  ...simple(10, { x: 0.05, y: PAD / (h1 + h2), w: 0.9, h: 0.9 }),
  stem: "Synthetic recovery question 10 (two pages): which option is correct?",
  options: opts(["Alpha 10", "Beta 10", "Gamma 10", "(figure)"]),
  figures: [{ owner: "OPTION", option_label: "(4)", box: { x: Math.round(q10fig.x * 1000), y: Math.round(sy(q10fig.y) * 1000), w: Math.round(q10fig.w * 1000), h: Math.round((q10fig.h / (h1 + h2)) * 1000) }, description: "Diagram for option D" }],
  hi: hi("कृत्रिम प्रश्न 10 (दो पृष्ठों पर): कौन सा विकल्प सही है?", ["अल्फा 10", "बीटा 10", "गामा 10", "(चित्र)"]),
};
const q8 = { ...simple(8, { x: 50, y: 150, w: 900, h: 700 }), stem: "Synthetic recovery question 8 (missing from the first read): which option is correct?", region: { x: 50, y: 150, w: 900, h: 700 } };

async function main() {
  const doc = await PDFDocument.create();
  const pages = [
    // Page 1: page marker 1, Q2's band marker 4, Q1 option structure images.
    await page([marker(1, 0), marker(4, R.q2.y - PAD), ...pinacol.map((_, i) => box(optFig(i).x, optFig(i).y, optFig(i).w, optFig(i).h, ["#c96", "#6c9", "#96c", "#c69"][i])), text(0.08, "1. Pinacol"), text(0.34, "2. Cell"), text(0.49, "3. Kw"), text(0.64, "4. Metal"), text(0.79, "5. Match")]),
    // Page 2: page marker 2, Q8's band marker 5 (between Q7 and Q9), Q10's band marker 6.
    await page([marker(2, 0), marker(7, R.q7.y + R.q7.h - PAD), marker(6, R.q10.y - PAD), box(0.1, 0.27, 0.4, 0.08, "#444"), box(0.1, 0.66, 0.4, 0.08, "#444"), text(0.07, "6."), text(0.24, "7."), text(0.5, "8. (not read by the first pass)"), text(0.64, "9."), text(0.84, "10. (continued)")]),
    // Page 3: page marker 3, Q10 option D image, Q11.
    await page([marker(3, 0), box(q10fig.x, q10fig.y, q10fig.w, q10fig.h, "#5a8"), text(0.04, "(continued)"), text(0.22, "11.")]),
  ];
  for (const png of pages) {
    const p = doc.addPage([595, 842]);
    p.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: 595, height: 842 });
  }
  writeFileSync(path.join(dir, "recovery-paper.pdf"), await doc.save());
  const mock = {
    pages: {
      "1": { questions: [q1, q2bad, q3, q4, q5] },
      "2": { questions: [simple(6, R.q6), simple(7, R.q7), simple(9, R.q9), q10first] },
      "3": { questions: [q10cont, simple(11, R.q11)] },
      "4": { questions: [q2good] },
      "7": { questions: [q8] },
      "6": { questions: [q10stacked] },
    },
    keys: {},
  };
  writeFileSync(path.join(dir, "mock-vision.json"), JSON.stringify(mock, null, 1));
  console.log(`fixtures written to ${dir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
