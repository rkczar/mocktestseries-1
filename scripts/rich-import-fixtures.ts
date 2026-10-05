/**
 * Synthetic packages for the NEET Phase 3 rich importer (XLSX + ZIP image
 * bundle). Every question and image here is invented for testing — no real
 * NEET material. Images are the Phase 2 SVG drawings (scripts/media-fixtures.ts)
 * with a numbered tag composited on, so distinct figures hash differently while
 * deliberately repeated ones deduplicate.
 *
 *   npx tsx scripts/rich-import-fixtures.ts <outDir>
 * writes torture10.{xlsx,zip}, failures.{xlsx,zip}, pilot45.{xlsx,zip},
 * scale180.{xlsx,zip}, legacy-ruhs.{csv,xlsx} and hostile-*.zip.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import * as XLSX from "xlsx";
import { buildZip, type ZipWriteEntry } from "../lib/rich-import/zip-writer";
import { diagramPng, noisePng, type DrawingName } from "./media-fixtures";

export const HEADERS = [
  "Code", "Exam", "Year", "Paper Code", "QNo", "Subject", "Chapter/Topic", "Sub-topic", "Question Type", "Content Format",
  "Question Text", "Question Images", "Option A", "Option A Image", "Option B", "Option B Image", "Option C", "Option C Image",
  "Option D", "Option D Image", "Correct", "Explanation", "Explanation Images", "Difficulty", "Source", "Review Required",
  "Review Reason", "Status", "List I", "List II",
] as const;
export type Header = (typeof HEADERS)[number];
export type FixtureRow = Partial<Record<Header, string>> & { __formula?: Partial<Record<Header, string>> };

export const TAX = {
  physics: { s: "PHYSICS", kin: "2. Kinematics", cur: "12. Current Electricity", opt: "16. Optics", mag: "13. Magnetic Effects of Current and Magnetism", work: "4. Work, Energy and Power" },
  chem: { s: "Chemistry", basic: "1. Some Basic Concepts in Chemistry", eq: "6. Equilibrium", hc: "15. Hydrocarbons", oxy: "17. Organic Compounds Containing Oxygen" },
  bot: { s: "Botany", cell: "6. Cell: The Unit of Life", photo: "9. Photosynthesis in Higher Plants" },
  zoo: { s: "ZOOLOGY", circ: "4. Body Fluids and Circulation", neural: "7. Neural Control and Coordination" },
};

/** A drawing with a numbered tag in the corner → distinct bytes per tag. */
export async function figure(name: DrawingName, tag: string, scale = 1): Promise<Buffer> {
  const base = await diagramPng(name, scale);
  const meta = await sharp(base).metadata();
  const w = meta.width ?? 300;
  const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="24"><text x="${w - 8}" y="18" text-anchor="end" font-family="DejaVu Sans" font-size="13" fill="#555">${tag}</text></svg>`);
  return sharp(base).composite([{ input: label, top: 0, left: 0 }]).png().toBuffer();
}

/** A small labelled option tile (A–D image options). */
export async function optionTile(label: string, shape: "circle" | "square" | "triangle" | "hexagon", tag: string): Promise<Buffer> {
  const body = {
    circle: `<circle cx="80" cy="70" r="45"/>`,
    square: `<rect x="35" y="25" width="90" height="90"/>`,
    triangle: `<path d="M80 22 L130 118 L30 118 Z"/>`,
    hexagon: `<path d="M80 20 L124 45 L124 95 L80 120 L36 95 L36 45 Z"/>`,
  }[shape];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="150"><g fill="none" stroke="#000" stroke-width="3">${body}</g><text x="6" y="144" font-family="DejaVu Sans" font-size="12" fill="#000">${label} ${tag}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export function toXlsx(rows: FixtureRow[]): Buffer {
  const aoa: (string | number)[][] = [HEADERS as unknown as string[]];
  for (const r of rows) aoa.push(HEADERS.map((h) => r[h] ?? ""));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  rows.forEach((r, i) => {
    for (const [h, f] of Object.entries(r.__formula ?? {})) {
      const c = HEADERS.indexOf(h as Header);
      ws[XLSX.utils.encode_cell({ r: i + 1, c })] = { t: "s", v: String(r[h as Header] ?? ""), f };
    }
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Questions");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const common = (code: string, qno: number, subject: string, topic: string): FixtureRow => ({
  Code: code,
  Year: "2025",
  "Paper Code": "SYN-25",
  QNo: String(qno),
  Subject: subject,
  "Chapter/Topic": topic,
  "Question Type": "SINGLE_CORRECT",
  "Content Format": "RICH_V1",
  Difficulty: "MEDIUM",
  Source: "PYQ",
  Status: "DRAFT",
});

/** The 10-question torture package (spec §40). */
export async function torture10(prefix = "SYN-2025"): Promise<{ rows: FixtureRow[]; files: ZipWriteEntry[] }> {
  const c = (n: number) => `${prefix}-${String(n).padStart(3, "0")}`;
  const f = (n: number, s: string) => `${c(n)}-${s}.png`;
  const files: ZipWriteEntry[] = [
    { name: `images/${f(3, "Q1")}`, data: await figure("circuit", `${prefix} 3`) },
    { name: `images/${f(4, "Q1")}`, data: await figure("graph", `${prefix} 4`) },
    { name: `images/${f(6, "Q1")}`, data: await figure("benzene", `${prefix} 6`) },
    { name: `images/${f(7, "Q1")}`, data: await figure("biology", `${prefix} 7`) },
    { name: `images/${f(8, "A")}`, data: await optionTile("A", "circle", prefix) },
    { name: `images/${f(8, "B")}`, data: await optionTile("B", "square", prefix) },
    { name: `images/${f(8, "C")}`, data: await optionTile("C", "triangle", prefix) },
    { name: `images/${f(8, "D")}`, data: await optionTile("D", "hexagon", prefix) },
    { name: `images/${f(9, "Q1")}`, data: await figure("ray", `${prefix} 9a`) },
    { name: `images/${f(9, "Q2")}`, data: await figure("snell", `${prefix} 9b`) },
    { name: `images/${f(9, "EXP1")}`, data: await figure("tir", `${prefix} 9c`) },
    { name: `images/${f(9, "EXP2")}`, data: await figure("reaction", `${prefix} 9d`) },
    { name: `images/${f(10, "L-B")}`, data: await figure("ethene", `${prefix} 10`) },
    { name: "__MACOSX/._junk.png", data: Buffer.from("mac metadata") },
  ];
  const rows: FixtureRow[] = [
    {
      ...common(c(1), 1, TAX.zoo.s, TAX.zoo.circ),
      "Content Format": "PLAIN",
      "Question Text": "Which chamber of the synthetic heart model pumps oxygenated blood to the body?",
      "Option A": "Right atrium", "Option B": "Right ventricle", "Option C": "Left atrium", "Option D": "Left ventricle",
      Correct: "D", Explanation: "In this synthetic model the left ventricle pumps oxygenated blood into the aorta.", Difficulty: "EASY",
    },
    {
      ...common(c(2), 2, TAX.physics.s, TAX.physics.kin),
      "Question Text": "A body starts from rest with acceleration $a$. Using $v^2=u^2+2as$ and $s=ut+\\frac{1}{2}at^2$, its speed after covering $s$ is:",
      "Option A": "$\\sqrt{2as}$", "Option B": "$2as$", "Option C": "$\\frac{1}{2}as$", "Option D": "$\\sqrt{as}$",
      Correct: "A", Explanation: "With $u=0$: $v^2=2as \\Rightarrow v=\\sqrt{2as}$.",
    },
    {
      ...common(c(3), 3, TAX.physics.s, TAX.physics.cur),
      "Question Text": "In the circuit shown, the equivalent resistance between the battery terminals is given by\n$$R_{eq}=R_1+\\frac{R_2R_3}{R_2+R_3}$$\nFind $R_{eq}$.",
      "Question Images": `${f(3, "Q1")} :: Circuit: 12 V battery, R1 = 4 ohm in series with R2 = 6 ohm and R3 = 3 ohm in parallel`,
      "Option A": "$6\\,\\Omega$", "Option B": "$13\\,\\Omega$", "Option C": "$2\\,\\Omega$", "Option D": "$4\\,\\Omega$",
      Correct: "A", Explanation: "$R_{23}=\\frac{6\\times3}{6+3}=2\\,\\Omega$, so $R_{eq}=4+2=6\\,\\Omega$.", Difficulty: "HARD",
    },
    {
      ...common(c(4), 4, TAX.physics.s, TAX.physics.kin),
      "Question Text": "The velocity–time graph of a synthetic trolley is shown. The distance covered in the first 4 s is:",
      "Question Images": `${f(4, "Q1")} :: Velocity-time graph rising from 0 to 20 m/s in 4 s, constant to 10 s, falling to 0 at 14 s`,
      "Option A": "40 m", "Option B": "80 m", "Option C": "20 m", "Option D": "60 m",
      Correct: "A", Explanation: "Area of the triangle: $\\frac{1}{2}\\times4\\times20=40$ m.",
    },
    {
      ...common(c(5), 5, TAX.chem.s, TAX.chem.eq),
      "Question Text": "For the synthetic equilibrium \\ce{N2 + 3H2 <=> 2NH3}, increasing pressure shifts the equilibrium towards:",
      "Option A": "\\ce{NH3}", "Option B": "\\ce{N2} and \\ce{H2}", "Option C": "no shift", "Option D": "\\ce{N2} only",
      Correct: "A", Explanation: "Fewer gas moles on the right (\\ce{2NH3}). Also \\ce{2H2 + O2 -> 2H2O} at \\pu{298 K} is unrelated.",
    },
    {
      ...common(c(6), 6, TAX.chem.s, TAX.chem.oxy),
      "Question Text": "The structure shown is:",
      "Question Images": `${f(6, "Q1")} :: Benzene ring with an OH group`,
      "Option A": "Phenol (\\ce{C6H5OH})", "Option B": "Benzene (\\ce{C6H6})", "Option C": "Ethanol (\\ce{C2H5OH})", "Option D": "Toluene",
      Correct: "A", Explanation: "A hydroxyl group on a benzene ring is phenol.",
    },
    {
      ...common(c(7), 7, TAX.zoo.s, TAX.zoo.circ),
      "Question Text": "In the labelled diagram, the vessel marked X carries:",
      "Question Images": `${f(7, "Q1")} :: Labelled heart diagram with the aorta marked X`,
      "Option A": "Oxygenated blood to the body", "Option B": "Deoxygenated blood to the lungs", "Option C": "Lymph", "Option D": "Bile",
      Correct: "A", Explanation: "X is the aorta in this synthetic figure.",
    },
    {
      ...common(c(8), 8, TAX.chem.s, TAX.chem.basic),
      "Question Text": "Which figure has six sides?",
      "Option A": "", "Option A Image": `${f(8, "A")} :: A circle`,
      "Option B": "", "Option B Image": `${f(8, "B")} :: A square`,
      "Option C": "", "Option C Image": `${f(8, "C")} :: A triangle`,
      "Option D": "", "Option D Image": `${f(8, "D")} :: A hexagon`,
      Correct: "D", Explanation: "Only the hexagon has six sides.",
    },
    {
      ...common(c(9), 9, TAX.physics.s, TAX.physics.opt),
      "Question Text": "Figures 1 and 2 show refraction at a glass surface. If the angle of incidence exceeds the critical angle $C$ where $\\sin C=\\frac{1}{n}$, the ray:",
      "Question Images": `${f(9, "Q1")} :: Ray diagram through a convex lens | ${f(9, "Q2")} :: Refraction from air into glass with critical angle C`,
      "Option A": "is totally internally reflected", "Option B": "passes undeviated", "Option C": "is absorbed", "Option D": "splits into colours",
      Correct: "A", Explanation: "Beyond $C$ the ray reflects completely (see figure), and the energy balance is shown in the second figure.",
      "Explanation Images": `${f(9, "EXP1")} :: Total internal reflection for angle greater than C | ${f(9, "EXP2")} :: decorative`,
    },
    {
      ...common(c(10), 10, TAX.chem.s, TAX.chem.hc),
      "Question Type": "MATCH_THE_FOLLOWING",
      "Question Text": "Match List I with List II and choose the correct option.",
      "List I": "A. \\ce{CH4}\nB. Alkene (figure) @@ " + f(10, "L-B") + " :: Ethene structure\nC. $sp$ hybridised carbon\nD. \\ce{C6H6}",
      "List II": "I. Benzene\nII. Methane\nIII. Ethene\nIV. Ethyne",
      "Option A": "A-II, B-III, C-IV, D-I", "Option B": "A-I, B-II, C-III, D-IV", "Option C": "A-III, B-IV, C-I, D-II", "Option D": "A-IV, B-I, C-II, D-III",
      Correct: "A", Explanation: "Methane, ethene, ethyne ($sp$) and benzene.", "Review Required": "TRUE", "Review Reason": "formula needs verification",
    },
  ];
  return { rows, files };
}

/** A package where every row is broken in one specific way (spec §40). */
export async function failures(prefix = "SYN-FAIL"): Promise<{ rows: FixtureRow[]; files: ZipWriteEntry[] }> {
  const ok = await figure("graph", prefix);
  const files: ZipWriteEntry[] = [
    { name: "good.png", data: ok },
    { name: "corrupt.png", data: Buffer.concat([ok.subarray(0, 60), Buffer.from("this is not the rest of a png")]) },
    { name: "notes.txt", data: Buffer.from("not an image") },
    { name: "a/dup.png", data: await figure("circuit", "dup-a") },
    { name: "b/DUP.png", data: await figure("circuit", "dup-b") },
    { name: "unused.png", data: await figure("benzene", "unused") },
  ];
  const base = (code: string, q: number): FixtureRow => ({
    ...common(code, q, TAX.physics.s, TAX.physics.kin),
    "Question Text": "Synthetic failure probe $x^2$.",
    "Option A": "1", "Option B": "2", "Option C": "3", "Option D": "4", Correct: "A", Explanation: "probe",
  });
  const rows: FixtureRow[] = [
    { ...base(`${prefix}-001`, 1), "Question Images": "missing-file.png :: A missing figure" },
    { ...base(`${prefix}-002`, 2), Subject: "Physicks" },
    { ...base(`${prefix}-003`, 3) },
    { ...base(`${prefix}-003`, 4) }, // duplicate code with the row above
    { ...base(`${prefix}-005`, 5), Correct: "E" },
    { ...base(`${prefix}-006`, 6), "Question Images": "corrupt.png :: Corrupt figure" },
    { ...base(`${prefix}-007`, 7), "Question Type": "MULTIPLE_CORRECT", Correct: "A,C" },
    { ...base(`${prefix}-008`, 8), "Question Images": "dup.png :: Ambiguous" },
    { ...base(`${prefix}-009`, 9), "Question Images": "notes.txt :: Text file" },
    { ...base(`${prefix}-010`, 10), "Option A": "2", __formula: { "Option A": "1+1" } },
    { ...base(`${prefix}-011`, 11), "Chapter/Topic": "99. Nonexistent Chapter" },
    { ...base(`${prefix}-012`, 12), "Content Format": "PLAIN", "Question Images": "good.png :: A graph" },
    { ...base(`${prefix}-013`, 13), "Question Text": "Unclosed $x^2 and \\frac{1}{ broken $\\frac{1}{$", "Explanation": "" },
    { ...base(`${prefix}-014`, 14), "Question Images": "../etc/passwd.png" },
    { ...base(`${prefix}-015`, 15), Status: "PUBLISHED" },
  ];
  return { rows, files };
}

/**
 * A realistic mixed paper of `n` questions (45 pilot / 180 scale): ~40 % text +
 * formula only, ~15 % chemistry notation, ~25 % one diagram, ~8 % four image
 * options, ~7 % two figures + explanation figures, ~5 % match-the-following.
 * Every 9th question reuses an earlier figure (exact duplicate → dedup).
 */
export async function mixedPaper(n: number, prefix: string, scale = 1): Promise<{ rows: FixtureRow[]; files: ZipWriteEntry[] }> {
  const rows: FixtureRow[] = [];
  const files: ZipWriteEntry[] = [];
  const drawings: DrawingName[] = ["circuit", "graph", "ray", "biology", "benzene", "reaction", "snell", "tir", "ethene", "ethanal", "ether", "acid"];
  const subjects = [
    [TAX.physics.s, TAX.physics.kin], [TAX.physics.s, TAX.physics.cur], [TAX.physics.s, TAX.physics.opt], [TAX.physics.s, TAX.physics.mag],
    [TAX.chem.s, TAX.chem.eq], [TAX.chem.s, TAX.chem.hc], [TAX.chem.s, TAX.chem.oxy], [TAX.bot.s, TAX.bot.cell], [TAX.bot.s, TAX.bot.photo],
    [TAX.zoo.s, TAX.zoo.circ], [TAX.zoo.s, TAX.zoo.neural],
  ];
  let firstFigure: string | null = null;
  for (let i = 1; i <= n; i++) {
    const code = `${prefix}-${String(i).padStart(3, "0")}`;
    const [s, t] = subjects[i % subjects.length];
    const row: FixtureRow = {
      ...common(code, i, s, t),
      "Question Text": `${code} · Synthetic Q${i}: if $F = ma$ with $m=${i}\\,\\text{kg}$ and $a=2\\,\\text{m/s}^2$, then $F$ equals:`,
      "Option A": `$${2 * i}\\,\\text{N}$`, "Option B": `$${i}\\,\\text{N}$`, "Option C": `$${i + 2}\\,\\text{N}$`, "Option D": `$${4 * i}\\,\\text{N}$`,
      Correct: "A", Explanation: `$F=${i}\\times2=${2 * i}$ N.`,
      Difficulty: ["EASY", "MEDIUM", "HARD"][i % 3],
    };
    const kind = i % 20;
    if (kind >= 8 && kind <= 10) {
      row["Question Text"] = `${code} · Synthetic Q${i}: in \\ce{CaCO3 -> CaO + CO2}, heating ${i} mol of \\ce{CaCO3} at \\pu{1200 K} gives how many moles of \\ce{CO2}?`;
      row["Option A"] = `${i}`; row["Option B"] = `${2 * i}`; row["Option C"] = `${i + 1}`; row["Option D"] = "0";
      row.Explanation = `1:1 stoichiometry: \\ce{CaCO3 -> CaO + CO2}.`;
    } else if (kind >= 11 && kind <= 15) {
      const name = `${code}-Q1.png`;
      if (i % 9 === 0 && firstFigure) row["Question Images"] = `${firstFigure} :: Repeated synthetic diagram`;
      else {
        files.push({ name: `fig/${name}`, data: await figure(drawings[i % drawings.length], code, scale) });
        row["Question Images"] = `${name} :: Synthetic ${drawings[i % drawings.length]} diagram ${i}`;
        firstFigure ??= name;
      }
    } else if (kind === 16 || (kind === 17 && i % 2 === 0)) {
      for (const [L, shape] of [["A", "circle"], ["B", "square"], ["C", "triangle"], ["D", "hexagon"]] as const) {
        files.push({ name: `opt/${code}-${L}.png`, data: await optionTile(L, shape, code) });
        row[`Option ${L}` as Header] = "";
        row[`Option ${L} Image` as Header] = `${code}-${L}.png :: Option ${L} ${shape}`;
      }
      row["Question Text"] = `${code} · Synthetic Q${i}: which tile shows a hexagon?`;
      row.Correct = "D";
    } else if (kind === 18) {
      files.push({ name: `fig/${code}-Q1.png`, data: await figure("ray", `${code}a`, scale) });
      files.push({ name: `fig/${code}-Q2.png`, data: await figure("snell", `${code}b`, scale) });
      files.push({ name: `fig/${code}-EXP1.png`, data: await figure("tir", `${code}c`, scale) });
      files.push({ name: `fig/${code}-EXP2.png`, data: await figure("graph", `${code}d`, scale) });
      row["Question Images"] = `${code}-Q1.png :: Ray diagram | ${code}-Q2.png :: Refraction diagram`;
      row["Explanation Images"] = `${code}-EXP1.png :: Total internal reflection | ${code}-EXP2.png :: Graph`;
    } else if (kind === 19) {
      row["Question Type"] = "MATCH_THE_FOLLOWING";
      row["Question Text"] = `${code} · Synthetic Q${i}: match List I with List II.`;
      row["List I"] = "A. \\ce{CH4} | B. \\ce{C2H4} | C. \\ce{C2H2} | D. \\ce{C6H6}";
      row["List II"] = "I. Benzene | II. Methane | III. Ethene | IV. Ethyne";
      row["Option A"] = "A-II, B-III, C-IV, D-I"; row["Option B"] = "A-I, B-II, C-III, D-IV"; row["Option C"] = "A-III, B-IV, C-I, D-II"; row["Option D"] = "A-IV, B-I, C-II, D-III";
    }
    rows.push(row);
  }
  return { rows, files };
}

/** Hostile / broken archives the reader must refuse (or flag). */
export async function hostileZips(): Promise<Record<string, Buffer>> {
  const png = await figure("graph", "hostile");
  return {
    traversal: buildZip([{ name: "../../evil.png", data: png }]),
    absolute: buildZip([{ name: "/etc/evil.png", data: png }]),
    backslash: buildZip([{ name: "..\\evil.png", data: png }]),
    symlink: buildZip([{ name: "link.png", data: Buffer.from("/etc/passwd"), store: true, raw: { unixMode: 0o120777 } }]),
    executable: buildZip([{ name: "ok.png", data: png }, { name: "run.sh", data: Buffer.from("#!/bin/sh\necho hi") }]),
    svg: buildZip([{ name: "x.svg", data: Buffer.from("<svg onload='alert(1)'/>") }]),
    nested: buildZip([{ name: "inner.zip", data: buildZip([{ name: "a.png", data: png }]) }]),
    bomb: buildZip([{ name: "bomb.png", data: Buffer.alloc(7 * 1024 * 1024, 0) }]),
    encrypted: buildZip([{ name: "enc.png", data: png, raw: { flags: 0x1 } }]),
    duplicate: buildZip([{ name: "same.png", data: png }, { name: "same.png", data: png }]),
    lyingSize: buildZip([{ name: "liar.png", data: png, raw: { declaredSize: 100 } }]),
    badCrc: buildZip([{ name: "crc.png", data: png, raw: { crc: 12345 } }]),
    notZip: Buffer.from("PK this is not really a zip archive at all, just text pretending"),
    deep: buildZip([{ name: "a/b/c/d/e/f.png", data: png }]),
  };
}

/** A representative LEGACY (RUHS-style) file using the original headers — must import exactly as before. */
export function legacyRows(): Record<string, string>[] {
  return [
    { "Question Code": "", Exam: "", Year: "", Subject: "Anatomy", Topic: "", SubTopic: "", Source: "", "Question Text": "Legacy Q1: the longest bone is? Price $5 and \\ce{H2O} stay literal.", "Option A": "Femur", "Option B": "Tibia", "Option C": "Humerus", "Option D": "Radius", "Correct Answer": "a", Explanation: "Femur.", Difficulty: "easy", Status: "PUBLISHED", "Question Type": "MCQ", "Review Required": "TRUE" },
    { "Question Code": "", Exam: "", Year: "", Subject: "Anatomy", Topic: "", SubTopic: "", Source: "", "Question Text": "Legacy Q2: no correct answer given", "Option A": "1", "Option B": "2", "Option C": "3", "Option D": "4", "Correct Answer": "", Explanation: "", Difficulty: "", Status: "PUBLISHED", "Question Type": "", "Review Required": "" },
    { "Question Code": "", Exam: "", Year: "", Subject: "Unknown Subject Zz", Topic: "", SubTopic: "", Source: "", "Question Text": "Legacy Q3: unmapped subject", "Option A": "1", "Option B": "2", "Option C": "3", "Option D": "4", "Correct Answer": "B", Explanation: "", Difficulty: "HARD", Status: "DRAFT", "Question Type": "", "Review Required": "" },
    { "Question Code": "", Exam: "", Year: "", Subject: "Anatomy", Topic: "", SubTopic: "", Source: "", "Question Text": "", "Option A": "1", "Option B": "2", "Option C": "3", "Option D": "4", "Correct Answer": "C", Explanation: "", Difficulty: "", Status: "", "Question Type": "", "Review Required": "" },
    { "Question Code": "", Exam: "", Year: "", Subject: "Anatomy", Topic: "", SubTopic: "", Source: "", "Question Text": "Legacy Q5: image filename column", "Option A": "1", "Option B": "2", "Option C": "3", "Option D": "4", "Correct Answer": "D", Explanation: "", Difficulty: "MEDIUM", Status: "DRAFT", "Question Type": "", "Review Required": "", "Question Image Filename": "no-such-file-xyz.png" },
  ];
}

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error("usage: rich-import-fixtures.ts <outDir>");
  mkdirSync(out, { recursive: true });
  for (const [name, pkg] of [
    ["torture10", await torture10()],
    ["failures", await failures()],
    ["pilot45", await mixedPaper(45, "SYN-P45")],
    ["scale180", await mixedPaper(180, "SYN-S180", 2.5)],
  ] as const) {
    writeFileSync(path.join(out, `${name}.xlsx`), toXlsx(pkg.rows));
    writeFileSync(path.join(out, `${name}.zip`), buildZip(pkg.files));
    console.log(`${name}: ${pkg.rows.length} rows, ${pkg.files.length} files`);
  }
  // Stress variant: same 180 rows, 12 figures replaced by incompressible
  // photo-like PNGs (~6 MB each) → a multi-chunk (> 20 MB) bundle and the
  // heaviest Sharp path (lossless ceiling → lossy re-encode).
  {
    const pkg = await mixedPaper(180, "SYN-X180", 2.5);
    let swapped = 0;
    const files = [];
    for (const f of pkg.files) {
      if (swapped < 12 && f.name.startsWith("fig/") && /-Q1\.png$/.test(f.name)) {
        files.push({ name: f.name, data: await noisePng(1400 + swapped, 1400), store: true });
        swapped++;
      } else files.push(f);
    }
    writeFileSync(path.join(out, "stress180.xlsx"), toXlsx(pkg.rows));
    writeFileSync(path.join(out, "stress180.zip"), buildZip(files));
    console.log(`stress180: ${pkg.rows.length} rows, ${files.length} files (${swapped} photo-like)`);
  }
  for (const [name, buf] of Object.entries(await hostileZips())) writeFileSync(path.join(out, `hostile-${name}.zip`), buf);
  const legacy = legacyRows();
  const headers = [...new Set(legacy.flatMap((r) => Object.keys(r)))];
  const csv = [headers.join(","), ...legacy.map((r) => headers.map((h) => `"${(r[h] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
  writeFileSync(path.join(out, "legacy-ruhs.csv"), csv);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(legacy, { header: headers }), "Sheet1");
  writeFileSync(path.join(out, "legacy-ruhs.xlsx"), XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

if (process.argv[1]?.endsWith("rich-import-fixtures.ts")) main().catch((e) => { console.error(e); process.exit(1); });
