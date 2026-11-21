/**
 * Markdown importer regression (pure parser + upload detection, synthetic fixtures only, no DB).
 * Run: NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-importer-markdown.ts
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeMarkdown, parseMarkdown } from "@/lib/ai-import/markdown";
import { checkFilename, detectFile } from "@/lib/ai-import/detect";

let pass = 0;
const fails: string[] = [];
async function t(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass++;
  } catch (e) {
    fails.push(`${name}: ${e instanceof Error ? e.message : e}`);
  }
}
const opts = (q: { options: { label: string; text: string }[] }) => q.options.map((o) => `${o.label}=${o.text}`).join("|");

const HEADINGS = `# Synthetic Board 2031 - Medicine Paper I

## 1. Document Metadata
- Items: 4

## 2. Questions
### Q1 (p2) | High
A 40 year old man has **chest pain** for 2 hours.
His BP is 90/60 mm Hg and SpO₂ 88%.

Which one of the following is the *next* step?
A. Aspirin 325 mg
B. CT head
C. Observe ≥ 6 h
D. Discharge

### Q2 (p2) | High
Which of the following are true?
1. Statement one
2. Statement two
3. Statement three
Select the correct answer using the code given below :
A. 1 and 2 only
B. 2 and 3 only
C. 1 and 3 only
D. 1, 2 and 3

### Q3 (p3; contains a table) | High
Ages of patients:
| Age | 0–4 | 5–9 |
|---|---|---|
| Number | 22 | 12 |
What is the mean?
A. 2
B. 4
C. 5
D. 6

### Q4 (p3) | High
Dropped item text
A. a
B. b
C. c
D. d
[Official key: dropped]

## 7. Complete Answer Key
| Q | Key | Src |
|---|---|---|
| 1 | A | p1 |
| 2 | D | p1 |
| 3 | C | p1 |
| 4 | X (dropped) | p1 |

## 8. Question-Answer Mapping
| Q | Key | Status |
|---|---|---|
| 1 | A | Mapped |
| 2 | D | Mapped |
`;

const MULTI = `# Synthetic Board 2031

## Paper I
Q1. First paper question one
(a) one
(b) two
(c) three
(d) four

Q2. First paper question two
(a) w
(b) x
(c) y
(d) z

### Paper I Answer Key
1. B
2. C

## Paper II
Q1. Second paper question one
A) p
B) q
C) r
D) s

### Answer Key
| 1 | D |
| 2 | A |
`;

const PLAIN = `Practice set

1. Which drugs are oral?
1. Drug one
2. Drug two
A. 1 only
B. 2 only
C. Both
D. Neither
Answer: C
Explanation: Both are oral.

2. A child aged 3 years — what is next?
A. α-blocker
B. β-blocker
C. Ca²⁺ channel blocker
D. \`code\` & <tag>
Ans: (b)
Subject: Pediatrics
Topic: Growth
`;

async function main() {
await t("BOM + CRLF normalised", () => {
  assert.equal(normalizeMarkdown("﻿a\r\nb\rc"), "a\nb\nc");
  const r = parseMarkdown("﻿" + PLAIN.replace(/\n/g, "\r\n"));
  assert.equal(r.papers[0].questions.length, 2);
});

await t("heading questions: count, numbering, metadata, numbered section headings ignored", () => {
  const r = parseMarkdown(HEADINGS);
  assert.equal(r.papers.length, 1);
  const p = r.papers[0];
  assert.deepEqual(p.questions.map((q) => q.number), [1, 2, 3, 4]);
  assert.equal(p.section, "");
  assert.equal(p.year, 2031);
  assert.equal(p.paper, "Paper I");
  assert.equal(p.exam, "Synthetic Board");
});

await t("clinical multi-paragraph stem kept verbatim (bold/italic/symbols)", () => {
  const q = parseMarkdown(HEADINGS).papers[0].questions[0];
  assert.equal(q.stem, "A 40 year old man has **chest pain** for 2 hours.\nHis BP is 90/60 mm Hg and SpO₂ 88%.\n\nWhich one of the following is the *next* step?");
  assert.equal(opts(q), "A=Aspirin 325 mg|B=CT head|C=Observe ≥ 6 h|D=Discharge");
  assert.equal(q.confidence, 0.98);
  assert.equal(q.method, "MARKDOWN");
});

await t("numbered statements stay in the stem", () => {
  const q = parseMarkdown(HEADINGS).papers[0].questions[1];
  assert.match(q.stem, /^Which of the following are true\?\n1\. Statement one\n2\. Statement two\n3\. Statement three\nSelect/);
  assert.equal(q.options.length, 4);
});

await t("markdown table preserved row for row, stored as a rich table + flagged", () => {
  const q = parseMarkdown(HEADINGS).papers[0].questions[2];
  assert.ok(q.stem.includes("| Age | 0–4 | 5–9 |\n|---|---|---|\n| Number | 22 | 12 |"));
  assert.equal(q.contentFormat, "RICH_V1");
  assert.ok(q.notes!.some((n) => /contains a table/.test(n)));
});

await t("each question keeps its exact source block (for the Original vs Extracted view)", () => {
  const md = "# Paper\n\n### Q1\nStem one\n\nA. a\nB. b\nC. c\nD. d\n\n### Q2\nStem two\nA. w\nB. x\nC. y\nD. z\n\n## Answer Key\n| 1 | A |\n";
  const [q1, q2] = parseMarkdown(md).papers[0].questions;
  assert.equal(q1.sourceText, "### Q1\nStem one\n\nA. a\nB. b\nC. c\nD. d");
  assert.equal(q2.sourceText, "### Q2\nStem two\nA. w\nB. x\nC. y\nD. z");
  const plain = parseMarkdown("1. First stem\nA. a\nB. b\nC. c\nD. d\n2. Second stem\nA. e\nB. f\nC. g\nD. h\n").papers[0].questions;
  assert.equal(plain[0].sourceText, "1. First stem\nA. a\nB. b\nC. c\nD. d");
  assert.equal(plain[1].sourceText, "2. Second stem\nA. e\nB. f\nC. g\nD. h");
});

await t("table question: a literal $ is escaped (never a formula); a non-table | line stays PLAIN", () => {
  const md = "### Q1\nCost table\n| Drug | Price |\n|---|---|\n| X | $5 |\n\nA. a\nB. b\nC. c\nD. d\n\n### Q2\nRatio a | b is shown |\n\nA. a\nB. b\nC. c\nD. d\n";
  const [q1, q2] = parseMarkdown(md).papers[0].questions;
  assert.ok(q1.stem.includes("| X | \\$5 |"), q1.stem);
  assert.equal(q2.contentFormat, "PLAIN");
});

await t("answer key table + duplicate mapping table agree; dropped kept as X", () => {
  const p = parseMarkdown(HEADINGS).papers[0];
  assert.deepEqual(p.key, [{ number: 1, raw: "A" }, { number: 2, raw: "D" }, { number: 3, raw: "C" }, { number: 4, raw: "X" }]);
  assert.equal(p.keyProblems.length, 0);
  assert.ok(p.questions[3].notes!.some((n) => /Source note: Official key: dropped/.test(n)));
});

await t("multiple papers: separate sections, numbering and keys", () => {
  const r = parseMarkdown(MULTI);
  assert.deepEqual(r.papers.map((p) => [p.section, p.questions.length]), [["Paper I", 2], ["Paper II", 1]]);
  assert.deepEqual(r.papers[0].key, [{ number: 1, raw: "B" }, { number: 2, raw: "C" }]);
  assert.deepEqual(r.papers[1].key, [{ number: 1, raw: "D" }]);
  assert.deepEqual(r.papers[1].keyProblems, ["Key entry 2 (A) names no question in Paper II — not applied."]);
  assert.ok(r.papers.every((p) => p.questions.every((q) => q.section === p.section)));
  assert.equal(opts(r.papers[0].questions[0]), "A=one|B=two|C=three|D=four");
});

await t("plain numbering: statements not split, inline answer/explanation/meta, special chars", () => {
  const qs = parseMarkdown(PLAIN).papers[0].questions;
  assert.equal(qs.length, 2);
  assert.equal(qs[0].stem, "Which drugs are oral?\n1. Drug one\n2. Drug two");
  assert.deepEqual(qs[0].printedAnswer, ["C"]);
  assert.equal(qs[0].hints!.explanation, "Both are oral.");
  assert.deepEqual(qs[1].printedAnswer, ["B"]);
  assert.equal(qs[1].hints!.subject, "Pediatrics");
  assert.equal(qs[1].hints!.topic, "Growth");
  assert.equal(opts(qs[1]), "A=α-blocker|B=β-blocker|C=Ca²⁺ channel blocker|D=`code` & <tag>");
});

await t("missing option flagged, low confidence, kept", () => {
  const q = parseMarkdown("### Q1\nStem\nA. a\nB. b\nC. c\n").papers[0].questions[0];
  assert.equal(q.options.length, 3);
  assert.equal(q.confidence, 0.4);
  assert.ok(q.notes!.some((n) => /expected exactly A, B, C, D/.test(n)));
});

await t("question missing from the key flagged (never guessed)", () => {
  const p = parseMarkdown("### Q1\nOne\nA. a\nB. b\nC. c\nD. d\n### Q2\nTwo\nA. a\nB. b\nC. c\nD. d\n## Answer Key\n| 1 | B |\n").papers[0];
  assert.deepEqual(p.key, [{ number: 1, raw: "B" }]);
  assert.ok(p.questions[1].notes!.some((n) => /no answer in the Markdown answer key/.test(n)));
  assert.deepEqual(p.questions[1].printedAnswer, []);
});

await t("identical options flagged", () => {
  const q = parseMarkdown("### Q1\nStem\nA. x\nB. y\nC. z\nD. y\n").papers[0].questions[0];
  assert.ok(q.notes!.some((n) => /identical text/.test(n)));
});

await t("duplicate numbering: both kept and flagged", () => {
  const r = parseMarkdown("### Q1\nOne\nA. a\nB. b\nC. c\nD. d\n### Q1\nAgain\nA. a\nB. b\nC. c\nD. d\n");
  assert.equal(r.papers[0].questions.length, 2);
  assert.ok(r.papers[0].questions[1].notes!.some((n) => /more than once/.test(n)));
  assert.ok(r.warnings.some((w) => /appears more than once/.test(w)));
});

await t("numbering gap flagged", () => {
  const q = parseMarkdown("### Q1\nOne\nA. a\nB. b\nC. c\nD. d\n### Q3\nThree\nA. a\nB. b\nC. c\nD. d\n").papers[0].questions[1];
  assert.ok(q.notes!.some((n) => /not continuous/.test(n)));
});

await t("conflicting key entries not applied", () => {
  const p = parseMarkdown("### Q1\nOne\nA. a\nB. b\nC. c\nD. d\n## Answer Key\n| 1 | A |\n| 1 | B |\n").papers[0];
  assert.equal(p.key.length, 0);
  assert.match(p.keyProblems[0], /different answers \(A \/ B\)/);
});

await t("inline answer vs key disagreement flagged", () => {
  const q = parseMarkdown("### Q1\nOne\nA. a\nB. b\nC. c\nD. d\nAnswer: A\n## Answer Key\n| 1 | B |\n").papers[0].questions[0];
  assert.ok(q.notes!.some((n) => /differs from the answer key/.test(n)));
});

await t("ambiguous boundary: stray text after options kept + flagged (never dropped)", () => {
  const q = parseMarkdown("### Q1\nOne\nA. a\nB. b\nC. c\nD. d\nSome stray line\n").papers[0].questions[0];
  assert.equal(q.confidence, 0.4);
  assert.ok(q.notes!.some((n) => /Some stray line/.test(n)));
});

await t("five options kept (not forced to four)", () => {
  const q = parseMarkdown("### Q1\nOne\nA. a\nB. b\nC. c\nD. d\nE. e\n").papers[0].questions[0];
  assert.equal(q.options.length, 4); // "E." is not an option label A–D → kept as trailing text, flagged
  assert.ok(q.notes!.some((n) => /E\. e/.test(n)));
});

await t("code fence content kept verbatim", () => {
  const q = parseMarkdown("### Q1\nRead:\n```\nA. not an option\n```\nA. a\nB. b\nC. c\nD. d\n").papers[0].questions[0];
  assert.ok(q.stem.includes("```\nA. not an option\n```"));
  assert.equal(opts(q), "A=a|B=b|C=c|D=d");
});

await t("separate key-only document", () => {
  const r = parseMarkdown("# Synthetic Board 2031 Paper II - Answer Key\n| Q | Key |\n|---|---|\n| 1 | C |\n| 2 | X (dropped) |\n");
  assert.equal(r.papers.length, 1);
  assert.deepEqual(r.papers[0].key, [{ number: 1, raw: "C" }, { number: 2, raw: "X" }]);
});

await t("no questions → warning", () => {
  assert.ok(parseMarkdown("# Notes\nNothing here").warnings.some((w) => /No numbered questions/.test(w)));
});

await t("upload: .md name accepted, content detection", async () => {
  assert.deepEqual(checkFilename("paper.md"), { ok: true, ext: "md" });
  const dir = mkdtempSync(join(tmpdir(), "mdimp-"));
  writeFileSync(join(dir, "a.md"), "﻿# Title\r\n### Q1\r\nStem — α\r\n");
  assert.equal((await detectFile(join(dir, "a.md"), "md")).kind, "md");
  writeFileSync(join(dir, "b.md"), Buffer.from([0x23, 0x00, 0x01]));
  assert.equal((await detectFile(join(dir, "b.md"), "md")).ok, false);
  writeFileSync(join(dir, "c.md"), Buffer.from("%PDF-1.4 fake"));
  assert.equal((await detectFile(join(dir, "c.md"), "md")).ok, false);
});

  console.log(`markdown importer: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL", f);
}
main().then(() => process.exit(fails.length ? 1 : 0));
