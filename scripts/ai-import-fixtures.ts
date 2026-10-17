/**
 * Synthetic fixtures for the AI Question Importer suites (no real exam
 * content). Writes papers, answer keys and hostile files into <dir>, plus
 * mock-vision.json: what the vision mock (scripts/mock-openrouter-vision.mjs)
 * "reads" from each scanned / unreliable page, keyed by a coloured marker
 * square drawn in the page corner.
 *
 *   npx tsx scripts/ai-import-fixtures.ts <dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import * as XLSX from "xlsx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { buildZip } from "../lib/rich-import/zip-writer";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: ai-import-fixtures.ts <dir>");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

/** Marker colour for fixture page id n (decoded by the mock from the top-right corner). */
const PALETTE: [number, number, number][] = [[0, 0, 0], [230, 0, 0], [0, 150, 0], [0, 0, 230], [240, 140, 0], [150, 0, 150], [0, 160, 170]];
export const markerRgb = (n: number) => ({ r: PALETTE[n][0], g: PALETTE[n][1], b: PALETTE[n][2] });

async function figure(label: string, hue: number, w = 240, h = 140): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${hue},70%,85%)"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 3}" fill="hsl(${hue},70%,40%)"/><text x="10" y="22" font-size="18" font-family="DejaVu Sans">${label}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function markerPdfPage(doc: PDFDocument, n: number) {
  const page = doc.addPage([595, 842]);
  const c = markerRgb(n);
  page.drawRectangle({ x: 595 - 40, y: 842 - 40, width: 40, height: 40, color: rgb(c.r / 255, c.g / 255, c.b / 255) });
  return page;
}

type Q = Record<string, unknown>;
const mock: { pages: Record<string, { questions: Q[]; answer_key?: { number: number; answer: string }[]; checker?: { questions: Q[] } }>; keys: Record<string, { entries: { number: number; answer: string }[] }> } = { pages: {}, keys: {} };

async function main() {
  // ---------------------------------------------------------------- digital-clean.pdf (local parse, no AI)
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([595, 842]);
    let y = 800;
    const t = (page: typeof p1, s: string, x = 50) => page.drawText(s, { x, y, size: 11, font });
    t(p1, "General instructions: Each question carries one mark.");
    y -= 26;
    t(p1, "1. Head & Neck: Which nerve supplies the deltoid muscle?");
    y -= 18;
    t(p1, "(A) Radial nerve   (B) Axillary nerve   (C) Ulnar nerve   (D) Median nerve");
    y -= 30;
    t(p1, "2. Cardiovascular System: Identify the chamber marked in the figure.");
    y -= 150;
    p1.drawImage(await doc.embedPng(await figure("Fig 2", 200)), { x: 70, y, width: 240, height: 140 });
    y -= 20;
    t(p1, "(A) Right atrium   (B) Left atrium   (C) Right ventricle   (D) Left ventricle");
    y -= 30;
    t(p1, "3. Cardiovascular System: Which ECG strip shows atrial fibrillation?");
    for (const [i, l] of ["A", "B", "C", "D"].entries()) {
      y -= 62;
      t(p1, `(${l})`, 60);
      p1.drawImage(await doc.embedPng(await figure(`ECG ${l}`, 30 + i * 70, 200, 56)), { x: 95, y: y - 18, width: 200, height: 56 });
    }
    y -= 40;
    t(p1, "4. Nutrition: Assertion (A): Vitamin C deficiency causes scurvy.");
    y -= 16;
    t(p1, "Reason (R): Vitamin C is needed for collagen synthesis.");
    y -= 18;
    t(p1, "(A) Both A and R are true and R explains A");
    y -= 16;
    t(p1, "(B) Both A and R are true but R does not explain A");
    y -= 16;
    t(p1, "(C) A is true but R is false");
    y -= 16;
    t(p1, "(D) A is false but R is true");

    const p2 = doc.addPage([595, 842]);
    y = 800;
    t(p2, "5. Enzymes: Match List-I with List-II");
    for (const s of ["List-I", "A. Pepsin", "B. Trypsin", "List-II", "I. Pancreas", "II. Stomach"]) {
      y -= 16;
      t(p2, s, 60);
    }
    y -= 18;
    t(p2, "(A) A-I, B-II   (B) A-II, B-I   (C) A-I, B-I   (D) A-II, B-II");
    y -= 30;
    t(p2, "6. Histology: Which of these is a five-option question?");
    y -= 18;
    t(p2, "(A) one   (B) two   (C) three   (D) four   (E) five");
    y -= 30;
    t(p2, "7. Nutrition: How many grams of protein per kg body weight are advised? (answer in integer)");
    y -= 30;
    t(p2, "8. Nutrition: Which vitamin deficiency causes night blindness?");
    y -= 18;
    t(p2, "(A) Vitamin D   (B) Vitamin K   (C) Vitamin A   (D) Vitamin E");
    y -= 16;
    t(p2, "Ans: (C)");
    y -= 30;
    t(p2, "9. Neuroanatomy: Which cranial nerve supplies the lateral rectus muscle?");
    y -= 18;
    t(p2, "(A) Abducens nerve   (B) Trochlear nerve   (C) Oculomotor nerve   (D) Facial nerve");
    y -= 30;
    t(p2, "10. Cardiovascular System: As shown in the diagram, which valve is stenosed?");
    y -= 18;
    t(p2, "(A) Mitral   (B) Aortic   (C) Tricuspid   (D) Pulmonary");
    writeFileSync(path.join(dir, "digital-clean.pdf"), await doc.save());
  }

  // ---------------------------------------------------------------- answer key for digital-clean (text layer)
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([595, 842]);
    p.drawText("ANSWER KEY", { x: 50, y: 800, size: 14, font });
    const lines = ["1. B    2. E    3. D    4. A", "5. B    6. A    7. D    9. A", "10. Bonus    11. C"];
    lines.forEach((s, i) => p.drawText(s, { x: 50, y: 770 - i * 20, size: 12, font }));
    writeFileSync(path.join(dir, "key-digital.pdf"), await doc.save());
  }

  // ---------------------------------------------------------------- formula.pdf: notation the text layer flattens → AI page
  {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = await markerPdfPage(doc, 1);
    page.drawText("1. Enzymes: The chemical formula of water is H", { x: 50, y: 790, size: 11, font });
    page.drawText("2", { x: 296, y: 786, size: 7, font });
    page.drawText("O. Which bond holds two water molecules together?", { x: 301, y: 790, size: 11, font });
    page.drawText("(A) Ionic bond   (B) Hydrogen bond   (C) Covalent bond   (D) Metallic bond", { x: 50, y: 770, size: 11, font });
    page.drawText("2. Enzymes: If v = u + at, what is v when u = 2, a = 3 and t = 4?", { x: 50, y: 740, size: 11, font });
    page.drawText("(A) 14   (B) 12   (C) 20   (D) 9", { x: 50, y: 720, size: 11, font });
    writeFileSync(path.join(dir, "formula.pdf"), await doc.save());
    mock.pages["1"] = {
      questions: [
        { number: 1, type: "SINGLE_CORRECT", stem: "Enzymes: The chemical formula of water is \\ce{H2O}. Which bond holds two water molecules together?", rich: true, options: [{ label: "(A)", text: "Ionic bond" }, { label: "(B)", text: "Hydrogen bond" }, { label: "(C)", text: "Covalent bond" }, { label: "(D)", text: "Metallic bond" }], figures: [], confidence: 0.95 },
        { number: 2, type: "SINGLE_CORRECT", stem: "Enzymes: If $v = u + at$, what is $v$ when $u = 2$, $a = 3$ and $t = 4$?", rich: true, options: [{ label: "(A)", text: "14" }, { label: "(B)", text: "12" }, { label: "(C)", text: "20" }, { label: "(D)", text: "9" }], figures: [], confidence: 0.95 },
      ],
    };
  }

  // ---------------------------------------------------------------- scanned.pdf: page image only → AI vision (+ second read)
  {
    const W = 1240;
    const H = 1754;
    const c = markerRgb(2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fafaf7"/>
      <rect x="${W - 80}" y="0" width="80" height="80" fill="rgb(${c.r},${c.g},${c.b})"/>
      <text x="90" y="140" font-size="30" font-family="DejaVu Sans">1. Lower Limb: Name the bone shown in the figure.</text>
      <rect x="120" y="180" width="420" height="260" fill="#ddd"/><circle cx="330" cy="310" r="90" fill="#555"/>
      <text x="90" y="500" font-size="28" font-family="DejaVu Sans">(1) Femur   (2) Tibia   (3) Fibula   (4) Patella</text>
      <text x="90" y="620" font-size="30" font-family="DejaVu Sans">Questions 2 and 3 refer to the diagram below.</text>
      <rect x="120" y="650" width="420" height="200" fill="#cde"/>
      <text x="90" y="920" font-size="30" font-family="DejaVu Sans">2. Special Senses: Which layer is labelled X?</text>
      <text x="90" y="970" font-size="28" font-family="DejaVu Sans">(1) Cornea  (2) Retina  (3) Choroid  (4) Sclera</text>
      <text x="90" y="1060" font-size="30" font-family="DejaVu Sans">3. Special Senses: Which layer is labelled Y?</text>
      <text x="90" y="1110" font-size="28" font-family="DejaVu Sans">(1) Cornea  (2) Retina  (3) Choroid  (4) Sclera</text>
      </svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    page.drawImage(await doc.embedPng(png), { x: 0, y: 0, width: 595, height: 842 });
    writeFileSync(path.join(dir, "scanned.pdf"), await doc.save());
    const box = (x: number, y: number, w: number, h: number) => ({ x: Math.round((x / W) * 1000), y: Math.round((y / H) * 1000), w: Math.round((w / W) * 1000), h: Math.round((h / H) * 1000) });
    const opts = (a: string[]) => a.map((t, i) => ({ label: `(${i + 1})`, text: t }));
    const scanned = [
      { number: 1, type: "SINGLE_CORRECT", stem: "Lower Limb: Name the bone shown in the figure.", options: opts(["Femur", "Tibia", "Fibula", "Patella"]), figures: [{ box: box(120, 180, 420, 260), owner: "STEM", description: "Long bone" }], confidence: 0.92 },
      { number: 2, type: "SINGLE_CORRECT", instructions: "Questions 2 and 3 refer to the diagram below.", stem: "Special Senses: Which layer is labelled X?", options: opts(["Cornea", "Retina", "Choroid", "Sclera"]), figures: [{ box: box(120, 650, 420, 200), owner: "SHARED", shared_with: [2, 3], description: "Eye layers diagram" }], confidence: 0.9 },
      { number: 3, type: "SINGLE_CORRECT", instructions: "Questions 2 and 3 refer to the diagram below.", stem: "Special Senses: Which layer is labelled Y?", options: opts(["Cornea", "Retina", "Choroid", "Sclera"]), figures: [{ box: box(120, 650, 420, 200), owner: "SHARED", shared_with: [2, 3], description: "Eye layers diagram" }], confidence: 0.6, unreadable: ["label Y is faint"] },
    ];
    mock.pages["2"] = {
      questions: scanned,
      // The independent second read disagrees on Q3's options (a misread) and agrees on Q1/Q2.
      checker: { questions: [scanned[0], scanned[1], { ...scanned[2], options: opts(["Cornea", "Retina", "Choroid", "Lens"]) }] },
    };
  }

  // ---------------------------------------------------------------- photo.png: a phone screenshot of one question
  {
    const c = markerRgb(3);
    const W = 1080;
    const H = 1400;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/>
      <rect x="${W - 80}" y="0" width="80" height="80" fill="rgb(${c.r},${c.g},${c.b})"/>
      <text x="60" y="160" font-size="34" font-family="DejaVu Sans">12. Nutrition: Which mineral is part of haemoglobin?</text>
      <text x="60" y="240" font-size="32" font-family="DejaVu Sans">A. Iron  B. Zinc  C. Copper  D. Calcium</text></svg>`;
    writeFileSync(path.join(dir, "photo.png"), await sharp(Buffer.from(svg)).png().toBuffer());
    mock.pages["3"] = { questions: [{ number: 12, type: "SINGLE_CORRECT", stem: "Nutrition: Which mineral is part of haemoglobin?", options: ["Iron", "Zinc", "Copper", "Calcium"].map((t, i) => ({ label: `${"ABCD"[i]}.`, text: t })), figures: [], confidence: 0.97 }] };
  }

  // ---------------------------------------------------------------- scanned-key.png: a scanned answer key (AI key reader)
  {
    const c = markerRgb(4);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="400"><rect width="100%" height="100%" fill="#fff"/><rect x="820" y="0" width="80" height="80" fill="rgb(${c.r},${c.g},${c.b})"/><text x="40" y="120" font-size="30" font-family="DejaVu Sans">KEY: 1-(1)  2-(2)  3-(2)</text></svg>`;
    writeFileSync(path.join(dir, "scanned-key.png"), await sharp(Buffer.from(svg)).png().toBuffer());
    mock.keys["4"] = { entries: [{ number: 1, answer: "(1)" }, { number: 2, answer: "(2)" }, { number: 3, answer: "(2)" }] };
  }

  // ---------------------------------------------------------------- paper.docx (exact text, numbering, subscripts, OMML, option image)
  {
    const optImg = await figure("Opt B", 120, 160, 90);
    const stemImg = await figure("Stem", 280, 260, 140);
    const p = (inner: string, num = false) => `<w:p>${num ? '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' : ""}${inner}</w:p>`;
    const r = (t: string, vert?: string) => `<w:r>${vert ? `<w:rPr><w:vertAlign w:val="${vert}"/></w:rPr>` : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
    const img = (rid: string) => `<w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const omml = `<m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath>`;
    const body = [
      p(r("Instructions: answer all questions.")),
      p(r("Metabolic Integration: The molecule H") + r("2", "subscript") + r("O is formed in which pathway?"), true),
      p(r("(A) Glycolysis")),
      p(r("(B) ") + img("rIdImg1")),
      p(r("(C) Oxidative phosphorylation")),
      p(r("(D) Urea cycle")),
      p(r("Clinical Biochemistry: What fraction ") + `<w:r><w:t xml:space="preserve"> </w:t></w:r>` + omml + r(" of a 10 mg dose is 5 mg?"), true),
      p(r("(A) One half   (B) One third   (C) One quarter   (D) Two thirds")),
      p(r("Molecular Biology: Identify the structure in the image."), true),
      p(img("rIdImg2")),
      p(r("(A) DNA   (B) RNA   (C) Ribosome   (D) Golgi body")),
    ].join("");
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${body}</w:body></w:document>`;
    const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rIdImg2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/></Relationships>`;
    const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
    const docx = buildZip([
      { name: "[Content_Types].xml", data: Buffer.from(ct) },
      { name: "word/document.xml", data: Buffer.from(documentXml) },
      { name: "word/numbering.xml", data: Buffer.from(numbering) },
      { name: "word/_rels/document.xml.rels", data: Buffer.from(rels) },
      { name: "word/media/image1.png", data: optImg, store: true },
      { name: "word/media/image2.png", data: stemImg, store: true },
    ]);
    writeFileSync(path.join(dir, "paper.docx"), docx);
    writeFileSync(path.join(dir, "key.csv"), "Q,Answer\n1,C\n2,A\n3,C\n");
    // Hostile: same container with a macro project.
    writeFileSync(path.join(dir, "macro.docx"), buildZip([{ name: "[Content_Types].xml", data: Buffer.from(ct) }, { name: "word/document.xml", data: Buffer.from(documentXml) }, { name: "word/vbaProject.bin", data: Buffer.from("not really vba") }]));
  }

  // ---------------------------------------------------------------- sheet.xlsx (Bulk Import rich headers)
  {
    const rows = [
      ["QNo", "Subject", "Chapter/Topic", "Question Text", "Option A", "Option B", "Option C", "Option D", "Correct", "Difficulty"],
      [1, "Physiology", "Renal Physiology", "Which hormone acts on the collecting duct to retain water?", "ADH", "Aldosterone", "Renin", "ANP", "A", "EASY"],
      [2, "Physiology", "Respiratory System", "Normal tidal volume in an adult is about", "100 mL", "500 mL", "1500 mL", "3000 mL", "B", "MEDIUM"],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Questions");
    writeFileSync(path.join(dir, "sheet.xlsx"), XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
  }

  // ---------------------------------------------------------------- hostile / refused files
  writeFileSync(path.join(dir, "fake.pdf"), await figure("not a pdf", 10));
  writeFileSync(path.join(dir, "old.docx"), Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(4096)]));
  writeFileSync(path.join(dir, "paper.doc"), Buffer.from("old word"));
  writeFileSync(path.join(dir, "mock-vision.json"), JSON.stringify(mock, null, 1));
  console.log(JSON.stringify({ dir, files: ["digital-clean.pdf", "key-digital.pdf", "formula.pdf", "scanned.pdf", "photo.png", "scanned-key.png", "paper.docx", "key.csv", "sheet.xlsx", "macro.docx", "fake.pdf", "old.docx", "paper.doc"] }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
