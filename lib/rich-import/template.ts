import "server-only";
import sharp from "sharp";
import * as XLSX from "xlsx";
import { buildZip } from "@/lib/rich-import/zip-writer";

/**
 * The official RICH import template (NEET Phase 3): an example XLSX and a
 * matching sample image bundle. All content is synthetic. The header row IS
 * the canonical format (docs/RICH-IMPORT.md); its names reuse the existing
 * importer's columns wherever one existed.
 */

export const RICH_HEADERS: { header: string; required: "REQUIRED" | "OPTIONAL" | "CONDITIONAL"; note: string }[] = [
  { header: "Code", required: "OPTIONAL", note: "Your stable id for the question, unique in the file (letters, digits, space, _ . / -). Used for duplicate checks and image naming; the database code is still assigned automatically." },
  { header: "Exam", required: "OPTIONAL", note: "Exact Exam name. Blank = the Exam selected on the import page. A different existing exam is an ERROR (never substituted)." },
  { header: "Year", required: "OPTIONAL", note: "4-digit year. Blank = the Exam's year. Must match the target paper's year." },
  { header: "Paper Code", required: "CONDITIONAL", note: "Code of an existing Previous Year Paper of this exam (Exams → Previous Year Papers). Must match Year." },
  { header: "QNo", required: "OPTIONAL", note: "Question number in the paper (1–999), unique per paper/year in the file." },
  { header: "Subject", required: "REQUIRED", note: "Exact existing Subject name. Unknown names are ERRORS — the importer never creates taxonomy." },
  { header: "Chapter/Topic", required: "OPTIONAL", note: "Exact existing Topic under the Subject (the old header 'Topic' also works)." },
  { header: "Sub-topic", required: "OPTIONAL", note: "Exact existing Sub-topic under the Topic." },
  { header: "Question Type", required: "OPTIONAL", note: "SINGLE_CORRECT (default, also 'MCQ') or MATCH_THE_FOLLOWING (coded options, single-correct scoring). MULTIPLE_CORRECT is parsed but BLOCKED: the engine is not enabled yet." },
  { header: "Content Format", required: "OPTIONAL", note: "PLAIN (default — text is shown literally) or RICH_V1 ($…$, $$…$$, \\ce{…}, \\pu{…} render; images allowed)." },
  { header: "Question Text", required: "REQUIRED", note: "The stem. Line breaks are kept. RICH_V1: inline $v^2=u^2+2as$, display $$E=mc^2$$, chemistry \\ce{2H2 + O2 -> 2H2O}; write \\$ for a literal dollar." },
  { header: "Question Images", required: "OPTIONAL", note: "File names from the ZIP, separated by | . Optional alt text after :: (e.g. Q12-fig1.png :: Circuit with two resistors). Use ':: decorative' for purely decorative images. Max 8." },
  { header: "Option A", required: "CONDITIONAL", note: "Option text. May be empty only when Option A Image is given. Same for B, C, D." },
  { header: "Option A Image", required: "OPTIONAL", note: "Image(s) for option A, same format as Question Images (max 3 per option)." },
  { header: "Option B", required: "CONDITIONAL", note: "" },
  { header: "Option B Image", required: "OPTIONAL", note: "" },
  { header: "Option C", required: "CONDITIONAL", note: "" },
  { header: "Option C Image", required: "OPTIONAL", note: "" },
  { header: "Option D", required: "CONDITIONAL", note: "" },
  { header: "Option D Image", required: "OPTIONAL", note: "" },
  { header: "Correct", required: "REQUIRED", note: "One letter A–D. (Several letters, e.g. A,C, only for MULTIPLE_CORRECT — currently blocked.)" },
  { header: "Explanation", required: "OPTIONAL", note: "Shown to students only after review/reveal. Formulas allowed (RICH_V1). Missing = WARNING." },
  { header: "Explanation Images", required: "OPTIONAL", note: "Images for the explanation (max 8), same format as Question Images." },
  { header: "Difficulty", required: "OPTIONAL", note: "EASY, MEDIUM or HARD. Blank = MEDIUM (WARNING); anything else = ERROR." },
  { header: "Source", required: "OPTIONAL", note: "PYQ (needs a matching Previous Year Paper) or blank for Question Bank." },
  { header: "Review Required", required: "OPTIONAL", note: "TRUE/FALSE. TRUE puts the question in editorial stage NEEDS_REVIEW." },
  { header: "Review Reason", required: "CONDITIONAL", note: "Why it needs review (OCR uncertainty, image needs verification, answer key conflict, …)." },
  { header: "Status", required: "OPTIONAL", note: "Rich imports are ALWAYS saved as DRAFT. PUBLISHED/ARCHIVED is recorded as a WARNING, never applied. Publish later from Question Management." },
  { header: "List I", required: "CONDITIONAL", note: "MATCH_THE_FOLLOWING only. One entry per line (or | separated), each starting with its key: 'A. text'. Entry image: 'B. text @@ file.png :: alt'." },
  { header: "List II", required: "CONDITIONAL", note: "MATCH_THE_FOLLOWING only. 'I. text' per line." },
];

const EXAMPLES: Record<string, string>[] = [
  { Code: "SAMPLE-001", QNo: "1", Subject: "<Subject>", "Chapter/Topic": "<Topic>", "Question Type": "SINGLE_CORRECT", "Content Format": "PLAIN", "Question Text": "A plain text question. $5 and \\ce{H2O} are shown literally in PLAIN.", "Option A": "First", "Option B": "Second", "Option C": "Third", "Option D": "Fourth", Correct: "B", Explanation: "Plain explanation.", Difficulty: "EASY" },
  { Code: "SAMPLE-002", QNo: "2", Subject: "<Subject>", "Chapter/Topic": "<Topic>", "Content Format": "RICH_V1", "Question Text": "From rest, $v^2=u^2+2as$ gives $v$ after distance $s$ as:\n$$v=\\sqrt{2as}$$ Which is correct?", "Option A": "$\\sqrt{2as}$", "Option B": "$2as$", "Option C": "$\\frac{1}{2}as$", "Option D": "$\\sqrt{as}$", Correct: "A", Explanation: "With $u=0$, $v=\\sqrt{2as}$.", Difficulty: "MEDIUM" },
  { Code: "SAMPLE-003", QNo: "3", Subject: "<Subject>", "Chapter/Topic": "<Topic>", "Content Format": "RICH_V1", "Question Text": "For \\ce{N2 + 3H2 <=> 2NH3}, raising the pressure favours:", "Option A": "\\ce{NH3}", "Option B": "\\ce{N2}", "Option C": "\\ce{H2}", "Option D": "No change", Correct: "A", Explanation: "Fewer moles of gas on the right.", Difficulty: "MEDIUM" },
  { Code: "SAMPLE-004", QNo: "4", Subject: "<Subject>", "Chapter/Topic": "<Topic>", "Content Format": "RICH_V1", "Question Text": "In the circuit shown, find $R_{eq}$.", "Question Images": "SAMPLE-004-Q1.png :: Battery with two resistors in series", "Option A": "$6\\,\\Omega$", "Option B": "$3\\,\\Omega$", "Option C": "$2\\,\\Omega$", "Option D": "$9\\,\\Omega$", Correct: "A", Explanation: "Series: $R=R_1+R_2$.", "Explanation Images": "SAMPLE-004-EXP1.png :: Series resistors added", Difficulty: "MEDIUM" },
  { Code: "SAMPLE-005", QNo: "5", Subject: "<Subject>", "Chapter/Topic": "<Topic>", "Content Format": "RICH_V1", "Question Text": "Which figure is a triangle?", "Option A": "", "Option A Image": "SAMPLE-005-A.png :: A circle", "Option B": "", "Option B Image": "SAMPLE-005-B.png :: A square", "Option C": "", "Option C Image": "SAMPLE-005-C.png :: A triangle", "Option D": "", "Option D Image": "SAMPLE-005-D.png :: A hexagon", Correct: "C", Explanation: "Three sides.", Difficulty: "EASY" },
  { Code: "SAMPLE-006", QNo: "6", Subject: "<Subject>", "Chapter/Topic": "<Topic>", "Content Format": "RICH_V1", "Question Text": "Figures 1 and 2 show the same circuit before and after a change. Which statement is true?", "Question Images": "SAMPLE-004-Q1.png :: Circuit before | SAMPLE-006-Q2.png :: Circuit after", "Option A": "Current increases", "Option B": "Current decreases", "Option C": "No change", "Option D": "Cannot say", Correct: "B", Explanation: "More resistance, less current.", "Explanation Images": "SAMPLE-004-EXP1.png :: decorative", Difficulty: "HARD", "Review Required": "TRUE", "Review Reason": "image needs verification" },
  { Code: "SAMPLE-007", QNo: "7", Subject: "<Subject>", "Chapter/Topic": "<Topic>", "Question Type": "MATCH_THE_FOLLOWING", "Content Format": "RICH_V1", "Question Text": "Match List I with List II.", "List I": "A. \\ce{CH4}\nB. \\ce{C2H4}\nC. \\ce{C2H2}\nD. \\ce{C6H6}", "List II": "I. Benzene\nII. Methane\nIII. Ethene\nIV. Ethyne", "Option A": "A-II, B-III, C-IV, D-I", "Option B": "A-I, B-II, C-III, D-IV", "Option C": "A-III, B-IV, C-I, D-II", "Option D": "A-IV, B-I, C-II, D-III", Correct: "A", Explanation: "Methane, ethene, ethyne, benzene.", Difficulty: "MEDIUM" },
];

export function richTemplateXlsx(): Buffer {
  const headers = RICH_HEADERS.map((h) => h.header);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...EXAMPLES.map((r) => headers.map((h) => r[h] ?? ""))]), "Questions");
  const rules = [
    ["Column", "Required", "Rules"],
    ...RICH_HEADERS.map((h) => [h.header, h.required, h.note]),
    [],
    ["Image bundle", "", "One .zip (max 200 MB, 2000 files, 8 MB per image). PNG, JPEG, WebP or AVIF only — no SVG, scripts, executables or nested archives. Folders are allowed; matching uses the file NAME only (case-insensitive), so every name must be unique. No fuzzy matching."],
    ["Spreadsheet formulas", "", "Cells must hold values. A cell with an Excel formula is refused (never evaluated): copy → Paste Special → Values."],
    ["Status", "", "Import is not publish: every rich question is saved as DRAFT, editorial stage DRAFT or NEEDS_REVIEW (never VERIFIED)."],
    ["Replace duplicates", "", "Replace only updates questions that are already rich DRAFTs; old images stay on disk and past attempts keep showing them."],
    ["Placeholders", "", "Replace <Subject>/<Topic> with names that exist under the selected Exam before importing the examples."],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rules), "Instructions");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const svg = (w: number, h: number, body: string) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g fill="none" stroke="#000" stroke-width="3" font-family="DejaVu Sans" font-size="16">${body}</g></svg>`);
const label = (x: number, y: number, s: string) => `<text x="${x}" y="${y}" fill="#000" stroke="none">${s}</text>`;

export async function richTemplateZip(): Promise<Buffer> {
  const png = (b: Buffer) => sharp(b).png().toBuffer();
  const circuit = (r2: string) => svg(480, 260, `<path d="M60 60 H420 V200 H60 Z"/><path d="M60 110 V150 M48 120 H72 M54 136 H66"/><rect x="150" y="48" width="80" height="24" fill="#fff"/>${label(160, 40, "R1 = 3 Ω")}<rect x="290" y="48" width="80" height="24" fill="#fff"/>${label(300, 40, `R2 = ${r2}`)}`);
  const tile = (shape: string, l: string) => svg(160, 150, `${shape}${label(8, 144, l)}`);
  const files = [
    { name: "images/SAMPLE-004-Q1.png", data: await png(circuit("3 Ω")) },
    { name: "images/SAMPLE-006-Q2.png", data: await png(circuit("6 Ω")) },
    { name: "images/SAMPLE-004-EXP1.png", data: await png(svg(480, 140, `${label(20, 70, "R = R1 + R2 = 3 Ω + 3 Ω = 6 Ω")}`)) },
    { name: "options/SAMPLE-005-A.png", data: await png(tile(`<circle cx="80" cy="70" r="45"/>`, "A")) },
    { name: "options/SAMPLE-005-B.png", data: await png(tile(`<rect x="35" y="25" width="90" height="90"/>`, "B")) },
    { name: "options/SAMPLE-005-C.png", data: await png(tile(`<path d="M80 22 L130 118 L30 118 Z"/>`, "C")) },
    { name: "options/SAMPLE-005-D.png", data: await png(tile(`<path d="M80 20 L124 45 L124 95 L80 120 L36 95 L36 45 Z"/>`, "D")) },
  ];
  return buildZip(files);
}
