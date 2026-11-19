/* eslint-disable @typescript-eslint/no-explicit-any -- offline corpus tooling over untyped JSONL exports */
/**
 * Builds truth.json for each job of the importer regression corpus (/root/mts-scratch/redesign/corpus).
 * Pure file processing over the read-only export (questions.jsonl, keys.jsonl, job.json) — no DB, no AI.
 *
 * Truth is only taken from sources that are reliable, and every field names its source; unknown → null:
 *   content (stem/options): ADMIN_APPROVED (approved or imported row; editedData overlaid on data)
 *                           SIBLING_DOCX_UNREVIEWED (scanned re-upload of a DOCX paper: the DOCX job's text-layer reading,
 *                           not reviewed — reported as a separate tier by the metrics)
 *   answer:                 OWN_KEY (AiImportKeyEntry of this job) | SIBLING_KEY (same paper + series; the job's own key image
 *                           was read by OCR and discarded, C-keys.md: 89/89 and 85/85 entries identical to the sibling key)
 *   confirmedAnswer:        an administrator picked the answer by hand (finalAnswer with answerConfirmed)
 *
 * Usage: npx tsx scripts/ai-import-corpus-truth.ts [corpusDir]
 */
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] || "/root/mts-scratch/redesign/corpus";
// Same paper uploaded twice (B-parse.md §1, C-keys.md RC6): scanned job → DOCX job.
const SIBLING: Record<string, string> = {
  cmwk7cowy07y5xckzbr9avbty: "cmw2w5irk059z5hkzby3sgrzc",
  cmwm4rh1t0761xwkzcbzm8ktr: "cmw3rgq5q00eg01kzr3cd5yaw",
};

type Row = Record<string, any>;
const jsonl = (p: string): Row[] =>
  fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const content = (r: Row) => {
  const d = { ...r.data, ...(r.editedData ?? {}) };
  return {
    stem: typeof d.stem === "string" ? d.stem : null,
    options: Array.isArray(d.options) ? d.options.map((o: Row) => ({ label: o.label, text: o.text ?? "" })) : null,
    type: d.type ?? r.questionType ?? null,
  };
};
const mainNumber = (r: Row) => (typeof r.sourceNumber === "number" && /^#\d+$/.test(r.sourceKey) ? r.sourceNumber : null);

for (const jobId of fs.readdirSync(dir).filter((d) => d.startsWith("cmw")).sort()) {
  const job = jsonl(path.join(dir, jobId, "job.json"))[0];
  const rows = jsonl(path.join(dir, jobId, "questions.jsonl"));
  const sib = SIBLING[jobId];
  let keys = jsonl(path.join(dir, jobId, "keys.jsonl")).filter((k) => !k.section);
  let keySource = "OWN_KEY";
  if (!keys.length && sib) {
    keys = jsonl(path.join(dir, sib, "keys.jsonl")).filter((k) => !k.section);
    keySource = "SIBLING_KEY";
  }
  const sibRows = sib ? jsonl(path.join(dir, sib, "questions.jsonl")) : [];
  const n = job.expectedQuestions ?? Math.max(0, ...rows.map((r) => r.sourceNumber ?? 0));
  const out: Row[] = [];
  for (let num = 1; num <= n; num++) {
    const t: Row = { number: num, stem: null, options: null, type: null, contentSource: null, answer: null, answerStatus: null, answerSource: null, answerRaw: null, confirmedAnswer: null, notes: [] };
    const approved = rows.filter((r) => mainNumber(r) === num && (r.approved || r.status === "IMPORTED"));
    if (approved.length === 1) Object.assign(t, content(approved[0]), { contentSource: "ADMIN_APPROVED" });
    else if (approved.length > 1) t.notes.push(`${approved.length} approved rows for this number — content left unknown`);
    else {
      const s = sibRows.filter((r) => mainNumber(r) === num);
      if (s.length === 1) Object.assign(t, content(s[0]), { contentSource: s[0].approved ? "ADMIN_APPROVED_SIBLING" : "SIBLING_DOCX_UNREVIEWED" });
    }
    const k = keys.filter((e) => e.sourceNumber === num);
    if (k.length === 1) {
      t.answerSource = keySource;
      t.answerRaw = k[0].rawValue;
      // Only an unambiguous single key value is answer truth; WITHDRAWN / AMBIGUOUS keep their status, answer stays null.
      t.answerStatus = k[0].status === "UNMATCHED" ? "OK" : k[0].status; // UNMATCHED = key value fine, question not matched
      // AiImportKeyEntry.labels is empty in prod; derive from rawValue: one letter A–D, or one digit 1–4 (FSO prints 1–4 = A–D).
      const raw = String(k[0].rawValue ?? "").trim().toUpperCase();
      const label = /^[A-D]$/.test(raw) ? raw : /^[1-4]$/.test(raw) ? "ABCD"[Number(raw) - 1] : null;
      if (t.answerStatus === "OK" && label) t.answer = [label];
      else if (t.answerStatus === "OK") t.answerStatus = "AMBIGUOUS"; // e.g. "A/B": no single truth
    } else if (k.length > 1) t.notes.push(`${k.length} key entries for this number`);
    const conf = rows.filter((r) => mainNumber(r) === num && r.answerConfirmed && r.finalAnswer?.length);
    if (conf.length === 1) {
      t.confirmedAnswer = conf[0].finalAnswer;
      if (t.answer && t.answer.join() !== conf[0].finalAnswer.join()) t.notes.push(`admin confirmed ${conf[0].finalAnswer.join()} but key says ${t.answer.join()}`);
    }
    out.push(t);
  }
  const c = (f: (t: Row) => boolean) => out.filter(f).length;
  const summary = {
    expected: n,
    content: { ADMIN_APPROVED: c((t) => t.contentSource === "ADMIN_APPROVED"), SIBLING: c((t) => String(t.contentSource).startsWith("SIBLING") || t.contentSource === "ADMIN_APPROVED_SIBLING"), unknown: c((t) => !t.contentSource) },
    answer: { known: c((t) => !!t.answer), withdrawn: c((t) => t.answerStatus === "WITHDRAWN"), ambiguous: c((t) => t.answerStatus === "AMBIGUOUS"), unknown: c((t) => !t.answerStatus), source: keySource },
    confirmedByAdmin: c((t) => !!t.confirmedAnswer),
  };
  fs.writeFileSync(path.join(dir, jobId, "truth.json"), JSON.stringify({ jobId, title: job.title, exam: job.exam, sibling: sib ?? null, summary, questions: out }, null, 1));
  console.log(jobId, JSON.stringify(summary));
}
