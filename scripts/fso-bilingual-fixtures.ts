/**
 * Synthetic BILINGUAL (Hindi + English) paper for scripts/verify-fso-bilingual.ts — no real exam content. Writes into
 * <dir>: bilingual-paper.pdf (2 scanned pages, Hindi column left / English right, coloured page markers), key-2022.pdf
 * (an RPSC-style text answer key: a year in the title, a 2-column "Q. No. RES" grid, `*` = deleted) and
 * mock-vision.json (what the mock vision reader returns for each page; scripts/mock-openrouter-vision.mjs).
 *
 *   npx tsx scripts/fso-bilingual-fixtures.ts <dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument, StandardFonts } from "pdf-lib";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: fso-bilingual-fixtures.ts <dir>");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

// Same palette as scripts/ai-import-fixtures.ts (the mock decodes the top-right square).
const PALETTE: [number, number, number][] = [[0, 0, 0], [230, 0, 0], [0, 150, 0], [0, 0, 230], [240, 140, 0], [150, 0, 150], [0, 160, 170]];

async function scannedPage(marker: number, lines: string[]): Promise<Buffer> {
  const W = 1240;
  const H = 1754;
  const [r, g, b] = PALETTE[marker];
  const text = lines.map((l, i) => `<text x="${i % 2 ? 660 : 60}" y="${160 + Math.floor(i / 2) * 60}" font-size="26" font-family="DejaVu Sans">${l}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fafaf7"/>
    <rect x="${W - 80}" y="0" width="80" height="80" fill="rgb(${r},${g},${b})"/>
    <line x1="620" y1="100" x2="620" y2="1650" stroke="#333" stroke-width="2"/>
    <rect x="700" y="300" width="400" height="220" fill="#cde"/><circle cx="900" cy="410" r="80" fill="#456"/>
    ${text}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const opts = (xs: string[]) => xs.map((t, i) => ({ label: `(${i + 1})`, text: t }));
const hi = (stem: string, options: string[], extra: Record<string, unknown> = {}) => ({ stem, options: opts(options), confidence: 0.95, unreadable: [], same_option_order: true, figures_differ: false, ...extra });

async function main() {
  const doc = await PDFDocument.create();
  for (const [marker, lines] of [
    [3, ["1. जैल का उदाहरण है", "1. Example of Gel is", "2. (Hindi column cut off)", "2. Which bacteria produce alpha toxin?", "3. वाटर एक्टिविटी", "3. Limiting water activity"]],
    [4, ["4. एफ्लाटॉक्सिन", "4. Aflatoxin is produced by", "5. नाइट्रोजन", "5. Methods for nitrogen", "6. विटामिन", "6. Vitamin deficiency", "7. विलोपित", "7. Deleted question"]],
  ] as const) {
    const page = doc.addPage([595, 842]);
    page.drawImage(await doc.embedPng(await scannedPage(marker, [...lines])), { x: 0, y: 0, width: 595, height: 842 });
  }
  writeFileSync(path.join(dir, "bilingual-paper.pdf"), await doc.save());

  // RPSC-style key: the year in the title must never become "Q202 = 2"; `*` = deleted.
  const key = await PDFDocument.create();
  const font = await key.embedFont(StandardFonts.Helvetica);
  const kp = key.addPage([595, 842]);
  const rows = [
    "RAJASTHAN PUBLIC SERVICE COMMISSION, AJMER",
    "Synthetic Officer Comp. Exam - 2022",
    "Exam Date : 27-06-2023",
    "Q. No.     RES",
    "1          2",
    "2          1",
    "3          4",
    "4          1",
    "5          3",
    "6          2",
    "7          *",
    "* Means deleted",
  ];
  rows.forEach((s, i) => kp.drawText(s, { x: 50, y: 790 - i * 20, size: 11, font }));
  writeFileSync(path.join(dir, "key-2022.pdf"), await key.save());

  // Q1 good pair with a shared diagram · Q2 Hindi missing · Q3 numbers differ · Q4 Hindi low confidence (and the second
  // read disagrees) · Q5 "Hindi" that is not Devanagari (the OCR failure mode) · Q6 option count differs · Q7 deleted in key.
  const page1 = [
    { number: 1, type: "SINGLE_CORRECT", stem: "Example of Gel is", options: opts(["Smoke", "Fog", "Milk", "Butter"]), figures: [{ box: { x: 560, y: 170, w: 330, h: 130 }, owner: "STEM", description: "shared diagram" }], confidence: 0.95, hi: hi("जैल का उदाहरण है", ["धुआँ", "कोहरा", "दूध", "मक्खन"]) },
    { number: 2, type: "SINGLE_CORRECT", stem: "Which of the following bacteria produce alpha toxin?", options: opts(["Salmonella typhi", "Listeria monocytogenes", "Clostridium perfringens", "Toxoplasma gondii"]), figures: [], confidence: 0.95, unreadable: ["Hindi version not visible"], hi: null },
    { number: 3, type: "SINGLE_CORRECT", stem: "What is the limiting value of water activity for the growth of any micro-organism?", options: opts(["$A_{w}$ 0.75", "$A_{w}$ 0.88", "$A_{w}$ 0.60", "$A_{w}$ greater than 0.91"]), rich: true, figures: [], confidence: 0.95, hi: hi("किसी भी सूक्ष्मजीव की वृद्धि के लिए 'वाटर एक्टिविटी' का सीमांकन मान होगा", ["$A_{w}$ 0.75", "$A_{w}$ 0.88", "$A_{w}$ 0.66", "$A_{w}$ 0.91 से अधिक"]) },
  ];
  const page2 = [
    { number: 4, type: "SINGLE_CORRECT", stem: "Aflatoxin is produced by", options: opts(["Aspergillus species", "Salmonella species", "Fusarium species", "Streptococcal species"]), figures: [], confidence: 0.95, hi: hi("एफ्लाटॉक्सिन उत्पन्न की जाती है", ["एस्परजिलस जाति द्वारा", "साल्मोनेला जाति द्वारा", "फ्यूजेरियम जाति द्वारा", "स्ट्रेप्टोकोकल जाति द्वारा"], { confidence: 0.6, unreadable: ["matra on option 3 unclear"] }) },
    { number: 5, type: "SINGLE_CORRECT", stem: "Methods for estimation of nitrogen are", options: opts(["Dumas and Carius method", "Kjeldahl's and Carius method", "Dumas and Kjeldahl's method", "Carius method"]), figures: [], confidence: 0.95, hi: hi("3π HRH Tor Fe", ["Rer HRH", "fen 3T", "RT TR", "Ha"]) },
    { number: 6, type: "SINGLE_CORRECT", stem: "Deficiency of which vitamin causes conjunctivitis?", options: opts(["Vitamin A", "Nicotinic acid", "Riboflavin", "Vitamin B2"]), figures: [], confidence: 0.95, hi: hi("किस विटामिन की कमी से कन्जक्टिवाइटिस होती है?", ["विटामिन A", "निकोटिनिक अम्ल", "राइबोफ्लेविन"]) },
    { number: 7, type: "SINGLE_CORRECT", stem: "A question the commission later deleted", options: opts(["One", "Two", "Three", "Four"]), figures: [], confidence: 0.95, hi: hi("एक प्रश्न जिसे आयोग ने हटा दिया", ["एक", "दो", "तीन", "चार"]) },
  ];
  // The independent second read agrees on page 3 and differs on Q4's Hindi on page 4.
  const page2Checker = page2.map((q) => (q.number === 4 ? { ...q, hi: { ...q.hi!, stem: "अफ्लाटॉक्सिन किसके द्वारा बनता है", options: opts(["एस्परजिलस", "साल्मोनेला", "फ्यूजेरियम", "स्ट्रेप्टोकोकस"]) } } : q));
  const mock = { pages: { "3": { questions: page1, checker: { questions: page1 } }, "4": { questions: page2, checker: { questions: page2Checker } } }, keys: {} };
  writeFileSync(path.join(dir, "mock-vision.json"), JSON.stringify(mock, null, 1));
  console.log(`fixtures written to ${dir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
