/* eslint-disable @typescript-eslint/no-explicit-any -- offline corpus tooling over untyped JSONL exports */
/**
 * Importer regression metrics: compares a list of extracted rows with a corpus job's truth.json.
 * Pure file processing — no DB, no AI.
 *
 *   npx tsx scripts/ai-import-corpus-metrics.ts <corpus/jobId> <rows.json>   one job, rows = ExtractedRow[] (prints JSON)
 *   npx tsx scripts/ai-import-corpus-metrics.ts <corpus/jobId> --stored      same, rows = the stored prod rows (questions.jsonl `data`)
 *   npx tsx scripts/ai-import-corpus-metrics.ts --all-stored <corpusDir> [out.md]   BEFORE table for every job
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

export type ExtractedRow = {
  number: number | null; // printed question number; null = unnumbered fragment
  section?: string;
  stem: string;
  options: { label: string; text: string }[];
  answer?: string[]; // answer the pipeline assigned (official key mapping), labels A–D
  issueCodes?: string[];
};

const jsonl = (p: string) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

export function norm(s: string): string {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/^\s*(\(\s*[a-e1-5]\s*\)|[a-e]\s*[.)])\s+/, "") // a leading printed option marker is layout, not text
    .replace(/\s+/g, " ")
    .trim();
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

export function storedRows(jobDir: string): ExtractedRow[] {
  return jsonl(path.join(jobDir, "questions.jsonl")).map((r) => ({
    number: typeof r.sourceNumber === "number" ? r.sourceNumber : null,
    section: r.data?.section ?? "",
    stem: r.data?.stem ?? "",
    options: (r.data?.options ?? []).map((o: any) => ({ label: o.label, text: o.text ?? "" })),
    answer: r.officialAnswer ?? [],
    issueCodes: r.issueCodes ?? [],
  }));
}

const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : null);

export function metrics(jobDir: string, rows: ExtractedRow[]) {
  const truth = JSON.parse(fs.readFileSync(path.join(jobDir, "truth.json"), "utf8"));
  const expected: number = truth.summary.expected;
  const byNum = new Map<number, ExtractedRow[]>();
  for (const r of rows) if (r.number != null) byNum.set(r.number, [...(byNum.get(r.number) ?? []), r]);
  // The row a number is judged by: the main-section one first (a restarted section "S2" is the defect, not the answer).
  const pick = (n: number) => (byNum.get(n) ?? []).sort((a, b) => Number(!!a.section) - Number(!!b.section))[0];

  const inRange = [...byNum.keys()].filter((n) => n >= 1 && n <= expected);
  const missing = Array.from({ length: expected }, (_, i) => i + 1).filter((n) => !byNum.has(n));
  const duplicates = [...byNum].filter(([, v]) => v.length > 1).map(([n]) => n).sort((a, b) => a - b);
  const outOfRange = [...byNum.keys()].filter((n) => n < 1 || n > expected);
  const unnumbered = rows.filter((r) => r.number == null).length;
  const optsNot4 = rows.filter((r) => r.options.length !== 4);

  // Text accuracy, reported per truth tier (admin-approved vs unreviewed sibling DOCX).
  const tiers: Record<string, { q: number; opt: number; optExact: number; optSim: number; allExact: number; stemExact: number; stemSim: number; notFound: number }> = {};
  const ans = { truth: 0, assigned: 0, correct: 0, wrong: 0, missing: 0, wrongNumbers: [] as number[] };
  for (const t of truth.questions) {
    const r = pick(t.number);
    if (t.options && t.contentSource) {
      const k = (tiers[t.contentSource] ??= { q: 0, opt: 0, optExact: 0, optSim: 0, allExact: 0, stemExact: 0, stemSim: 0, notFound: 0 });
      k.q++;
      if (!r) k.notFound++;
      const s = r ? similarity(norm(r.stem), norm(t.stem ?? "")) : 0;
      k.stemSim += s;
      if (s === 1) k.stemExact++;
      let all = t.options.length > 0 && r?.options.length === t.options.length;
      for (const o of t.options) {
        const got = r?.options.find((x) => x.label === o.label);
        const sim = got ? similarity(norm(got.text), norm(o.text)) : 0;
        k.opt++;
        k.optSim += sim;
        if (sim === 1) k.optExact++;
        else all = false;
      }
      if (all) k.allExact++;
    }
    if (t.answer) {
      ans.truth++;
      const a = r?.answer ?? [];
      if (!a.length) ans.missing++;
      else {
        ans.assigned++;
        if ([...a].sort().join() === [...t.answer].sort().join()) ans.correct++;
        else (ans.wrong++, ans.wrongNumbers.push(t.number));
      }
    }
  }
  const text = Object.fromEntries(
    Object.entries(tiers).map(([tier, k]) => [
      tier,
      { questions: k.q, notDetected: k.notFound, stemExactPct: pct(k.stemExact, k.q), stemMeanSim: +(k.stemSim / k.q).toFixed(3), options: k.opt, optionExactPct: pct(k.optExact, k.opt), optionMeanSim: +(k.optSim / k.opt).toFixed(3), allOptionsExactPct: pct(k.allExact, k.q) },
    ]),
  );
  const flags: Record<string, number> = {};
  for (const r of rows) for (const c of r.issueCodes ?? []) flags[c] = (flags[c] ?? 0) + 1;
  return {
    job: truth.jobId,
    title: truth.title,
    expected,
    rows: rows.length,
    detected: inRange.length,
    missing,
    duplicates,
    outOfRange,
    unnumbered,
    optionsNot4: optsNot4.length,
    optionsNot4Numbers: optsNot4.map((r) => r.number),
    text,
    answers: { ...ans, source: truth.summary.answer.source, accuracyPct: pct(ans.correct, ans.truth) },
    flags: Object.fromEntries(Object.entries(flags).sort((a, b) => b[1] - a[1])),
  };
}

function selfTest() {
  assert.equal(norm("(b)  Folic  acid"), "folic acid");
  assert.equal(norm("A. 1, 2 and 3"), "1, 2 and 3");
  assert.equal(similarity("kitten", "sitting"), 1 - 3 / 7);
  assert.equal(similarity("", "x"), 0);
}

function beforeMd(dir: string): string {
  const all = fs.readdirSync(dir).filter((d) => d.startsWith("cmw") && fs.existsSync(path.join(dir, d, "truth.json"))).sort();
  const res = all.map((j) => metrics(path.join(dir, j), storedRows(path.join(dir, j))));
  const tier = (m: any, t: string) => (m.text[t] ? `${m.text[t].questions}: ${m.text[t].optionExactPct}% / ${m.text[t].optionMeanSim}` : "—");
  const lines = [
    `# Importer regression corpus — BEFORE (stored prod rows, prod ab3ade2), generated ${new Date().toISOString()}`,
    "",
    "Rows = stored AiImportQuestion `data` (the extraction; admin `editedData` not used). Answer = `officialAnswer` as matched by the pipeline.",
    "Option accuracy = per option label, normalised exact % / mean similarity, over questions that have content truth (`q:`).",
    "ADMIN = admin-approved/imported rows; SIBLING = unreviewed DOCX text of the same paper (scanned re-uploads only).",
    "",
    "| Job | Paper | rows | detected/expected | missing | dup numbers | unnumbered | ≠4 opts | opt acc ADMIN | opt acc SIBLING | answers correct/wrong/missing (of truth) | ans acc |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...res.map((m) => `| ${m.job.slice(0, 9)} | ${m.title} | ${m.rows} | ${m.detected}/${m.expected} | ${m.missing.length ? m.missing.join(",") : 0} | ${m.duplicates.length ? m.duplicates.join(",") : 0} | ${m.unnumbered} | ${m.optionsNot4} | ${tier(m, "ADMIN_APPROVED")} | ${tier(m, "SIBLING_DOCX_UNREVIEWED")} | ${m.answers.correct}/${m.answers.wrong}/${m.answers.missing} (${m.answers.truth}, ${m.answers.source}) | ${m.answers.accuracyPct}% |`),
    "",
    "## Review flags by code (all rows)",
    "",
    ...res.map((m) => `- **${m.job.slice(0, 9)}**: ${Object.entries(m.flags).map(([c, n]) => `${c} ${n}`).join(", ") || "none"}`),
    "",
    "## Details",
    "",
    ...res.map((m) => `- **${m.job.slice(0, 9)}**: ≠4 at ${JSON.stringify(m.optionsNot4Numbers)}; wrong answers at ${JSON.stringify(m.answers.wrongNumbers)}; text ${JSON.stringify(m.text)}`),
  ];
  return lines.join("\n") + "\n";
}

selfTest();
const [a, b, c] = process.argv.slice(2);
if (a === "--all-stored") {
  const md = beforeMd(b);
  if (c) fs.writeFileSync(c, md);
  console.log(md);
} else if (a && b) {
  const rows: ExtractedRow[] = b === "--stored" ? storedRows(a) : JSON.parse(fs.readFileSync(b, "utf8"));
  console.log(JSON.stringify(metrics(a, rows), null, 1));
} else console.error("usage: see header");
