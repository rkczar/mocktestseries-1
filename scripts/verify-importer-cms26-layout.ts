/**
 * CMS 2026 layout regressions (2026-11-16 screenshots) + exam-memory isolation — pure, synthetic, no DB / AI / network.
 *   Q26 (local OCR): printed line wraps joined; statements and the answer instruction kept on their own lines.
 *   Q4  (AI read):   statements read as options → back in the question text; options only the (a)–(d) combinations.
 *   Q5  (AI read):   List I / List II keys echoed the row text, code table read as options → labels / flags, nothing invented.
 *   Memory:          new patterns learned only from administrator-confirmed corrections; per exam, confirmed-only, safe merge.
 *   npx tsx scripts/verify-importer-cms26-layout.ts
 */
import { joinWrappedLines, parseMatchLists } from "@/lib/ai-import/local-parse";
import { incompleteReading, matchLayoutProblems, NO_OCR, repairLayout, statementsAsOptions } from "@/lib/ai-import/reading-checks";
import { correctionProposals, detectPattern, memoryBrief, memoryFindings, mergePaperRules, type PaperRule } from "@/lib/ai-import/paper-memory";
import { readFileSync } from "node:fs";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

let pass = 0;
let fail = 0;
function ok(name: string, cond: unknown, info?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}`, info ?? "");
  }
}
const opt = (label: string, text: string) => ({ label, printed: `(${label.toLowerCase()})`, text });
const Q = (p: Partial<ExtractedQuestion>): ExtractedQuestion => ({ section: "", number: 1, label: "1", pages: [1], type: "SINGLE_CORRECT", stem: "", options: [], listI: null, listII: null, printedAnswer: [], contentFormat: "PLAIN", confidence: 0.95, unreadable: [], figures: [], method: "AI_VISION", notes: [], ...p });

// ---- Q26: wrapped lines ------------------------------------------------------------------------------------------
const q26 = "Patients suffering from which of the following\ncondition(s) can get symptomatic relief by\nconsuming a gluten-free diet ?\n1. Coeliac disease\n2. Peptic ulcer disease\n3. Dermatitis herpetiformis\nSelect the correct answer using the code given\nbelow :";
const j26 = joinWrappedLines(q26);
ok("Q26 joined", j26 === "Patients suffering from which of the following condition(s) can get symptomatic relief by consuming a gluten-free diet ?\n1. Coeliac disease\n2. Peptic ulcer disease\n3. Dermatitis herpetiformis\nSelect the correct answer using the code given below :", j26);
ok("Q26 words unchanged", j26.replace(/\s+/g, "") === q26.replace(/\s+/g, ""));
const q29 = "Consider the following statements regarding\n'Barrett's Oesophagus' :\n1. It is a pre-malignant condition.\n2. The normal columnar mucosa of lower\noesophagus is replaced by squamous\ncells.\n3. It is an adaptive response to chronic\ngastro-\noesophageal reflux.";
ok("wrapped statement rows joined, hyphen kept", joinWrappedLines(q29) === "Consider the following statements regarding 'Barrett's Oesophagus' :\n1. It is a pre-malignant condition.\n2. The normal columnar mucosa of lower oesophagus is replaced by squamous cells.\n3. It is an adaptive response to chronic gastro-oesophageal reflux.", joinWrappedLines(q29));
ok("paragraphs + table rows + Assertion/Reason kept", joinWrappedLines("First para line\n\nSecond para\nDrug | Action\nMetoprolol | Beta-blocker\nAssertion (A): x\nReason (R): y") === "First para line\n\nSecond para\nDrug | Action\nMetoprolol | Beta-blocker\nAssertion (A): x\nReason (R): y");
ok("Hindi / English lines never joined", joinWrappedLines("Which of the following\nनिम्नलिखित में से कौन\nis correct") === "Which of the following\nनिम्नलिखित में से कौन\nis correct");
ok("DOCX table rows (cells joined by two spaces) kept apart", joinWrappedLines("Drug  Action\nMetoprolol  Beta-blocker\nTelmisartan  ARB") === "Drug  Action\nMetoprolol  Beta-blocker\nTelmisartan  ARB");
ok("already joined text unchanged", joinWrappedLines(j26) === j26);

// ---- Q4: statements read as options --------------------------------------------------------------------------------
const q4read = Q({ number: 4, stem: "Consider the following statements regarding Takotsubo cardiomyopathy :", options: [opt("A", "1. There is acute right ventricular dysfunction characterized by dilatation of the right ventricular apex."), opt("B", "2. It can be precipitated by acute emotional stress and is frequently associated with an underlying neuro-psychiatric disorder."), opt("C", "3. Symptoms and ECG findings often mimic acute ST-elevation myocardial infarction."), opt("D", "4. Ventriculography shows normal left ventricle and apical ballooning of the right ventricle.")], printedAnswer: ["B"] });
ok("Q4 detected", statementsAsOptions(q4read));
const ocr4 = "4. Consider the following statements regarding Takotsubo cardiomyopathy :\n1. There is acute ...\nWhich of the statements given above are correct ?\n(a) 1 and 2\n(b) 2 and 3\n(c) 1 and 4\n(d) 3 and 4";
const [r4] = repairLayout([q4read], (n) => (n === 4 ? ocr4 : null));
ok("Q4 statements in stem", /\n1\. There is[\s\S]*\n4\. Ventriculography/.test(r4.stem), r4.stem);
ok("Q4 options = combinations", r4.options.map((o) => `${o.label}:${o.text}`).join("|") === "A:1 and 2|B:2 and 3|C:1 and 4|D:3 and 4", r4.options);
ok("Q4 flagged for check", (r4.confidence ?? 1) < 0.8 && r4.notes!.some((n) => /statements had been read as options/.test(n)));
const [r4b] = repairLayout([q4read], () => null);
ok("Q4 no OCR → no invented options", r4b.options.length === 0 && /\n4\. Ventriculography/.test(r4b.stem) && r4b.notes!.some((n) => /enter them from the source/.test(n)));
ok("Q4 repaired read keeps the page (not degenerate)", incompleteReading([r4b]).length === 0);
const [r4c] = repairLayout([q4read], () => "4. text\n(a) 1. There is a\n(b) 2. It can\n(c) 3. Symptoms\n(d) 4. Ventriculography");
ok("Q4 OCR options that are statements are refused", r4c.options.length === 0);

// ---- Q5: match the following ----------------------------------------------------------------------------------------
const q5stem = "With regard to Hypertrophic Cardiomyopathy, match List I with List II and select the correct answer using the code given below the lists :";
const q5a = Q({ number: 5, type: "MATCH_THE_FOLLOWING", stem: q5stem, listI: [{ key: "BETA-MYOSINHEAVY1CHAINMUTATIONS", text: "Beta-myosin heavy 1 chain mutations" }, { key: "TROPONINMUTATIONS", text: "Troponin mutations" }, { key: "MYOSIN-BINDINGPROTEIN-CMUTATIONS", text: "Myosin-binding protein-C mutations" }], listII: [{ key: "MARKEDVENTRICULARHYPERTROPHY", text: "Marked ventricular hypertrophy" }, { key: "HYPERTENSION", text: "Hypertension" }, { key: "MYOCARDIALFIBREDISARRAYWITHMINIMALHYPERTROPHY", text: "Myocardial fibre disarray with minimal hypertrophy" }], options: [opt("A", "1 and 2"), opt("B", "2 and 3"), opt("C", "1 and 4"), opt("D", "3 and 4")] });
ok("Q5a problems found", matchLayoutProblems(q5a).length === 2, matchLayoutProblems(q5a));
const [r5a] = repairLayout([q5a], () => null);
ok("Q5a echoed keys → positional labels, texts kept", r5a.listI!.map((e) => e.key).join() === "A,B,C" && r5a.listII!.map((e) => e.key).join() === "1,2,3" && r5a.listI![0].text === "Beta-myosin heavy 1 chain mutations");
ok("Q5a other question's options → Needs Correction, unchanged", (r5a.confidence ?? 1) <= 0.4 && r5a.options[0].text === "1 and 2" && r5a.notes!.some((n) => /combinations/.test(n)));
const ocr5 = "5. With regard to ... lists :\nList I List II\nA. Beta-myosin heavy 1. Marked\nCode :\nA B C\n(a) 1 2 3\n(b) 1 3 2\n(c) 2 1 3\n(d) 3 2 1";
const [r5ok] = repairLayout([q5a], (n) => (n === 5 ? ocr5 : null));
ok("Q5a code rows from OCR", r5ok.options.map((o) => o.text).join("|") === "1 2 3|1 3 2|2 1 3|3 2 1" && matchLayoutProblems(r5ok).length === 0, r5ok.options);
const q5b = Q({ number: 5, type: "MATCH_THE_FOLLOWING", stem: "Match List I with List II and select the correct answer using the code given below the lists :", listI: [{ key: "A", text: "Beta-myosin heavy 1 chain mutations" }], listII: [{ key: "1", text: "Marked ventricular hypertrophy" }, { key: "2", text: "Hypertension" }, { key: "3", text: "Troponin and arrhythmia mutations" }, { key: "4", text: "Myocardial fibre disarray with minimal hypertrophy" }], options: ["B", "A", "(a) 3", "(b) 3", "(c) 1", "(d) 2", "1", "2"].map((t, i) => opt(String.fromCharCode(65 + i), t)) });
const [r5b] = repairLayout([q5b], () => null);
ok("Q5b mixed columns + code table as options → Needs Correction", (r5b.confidence ?? 1) <= 0.4 && /List I has 1 row/.test(r5b.notes!.join(" ")) && r5b.options.length === 8);
const good = Q({ type: "MATCH_THE_FOLLOWING", stem: "Match", listI: [{ key: "A", text: "x" }, { key: "B", text: "y" }], listII: [{ key: "1", text: "p" }, { key: "2", text: "q" }], options: ["1 2", "2 1", "1 1", "2 2"].map((t, i) => opt(String.fromCharCode(65 + i), t)) });
ok("valid match read untouched", repairLayout([good], () => null)[0] === good);
const plain = Q({ stem: "Which is X?", options: ["a", "b", "c", "d"].map((t, i) => opt(String.fromCharCode(65 + i), t)) });
ok("ordinary question untouched", repairLayout([plain], () => null)[0] === plain);

// ---- Exam memory: learning, confirmed-only use, isolation, safe merge ------------------------------------------------
ok("patterns detect", !!detectPattern("STATEMENTS_AS_OPTIONS", q4read) && !!detectPattern("MATCH_LAYOUT", q5a) && !!detectPattern("WRAPPED_LINES", Q({ stem: q26 })) && !detectPattern("WRAPPED_LINES", Q({ stem: j26 })));
const files = new Map([["f1", { name: "QP-CMSE-26-Paper-I.pdf", sha: "abc" }]]);
const items = [
  { fileId: "f1", label: "4", kind: "EDIT" as const, before: q4read, after: { ...r4 }, aiRead: true, acceptedSuggestion: false },
  { fileId: "f1", label: "26", kind: "EDIT" as const, before: Q({ number: 26, stem: q26, method: "LOCAL_OCR" }), after: Q({ number: 26, stem: j26 }), aiRead: false, acceptedSuggestion: false },
];
const props = correctionProposals({ jobId: "jobCMS", jobTitle: "UPSC CMS 2026 Paper I", paper: "PAPER I", at: "2026-11-16T00:00:00Z", files, items });
const keys = props.map((p) => p.key);
ok("learned from confirmed corrections", keys.includes("EXTRACTION_ERROR:STATEMENTS_AS_OPTIONS") && keys.includes("EXTRACTION_ERROR:WRAPPED_LINES"), keys);
ok("evidence = admin-confirmed with source file + sha", props.every((p) => p.evidence.source === "ADMIN_CONFIRMED" && p.evidence.fileSha256 === "abc" && p.evidence.jobId === "jobCMS"));
ok("uncorrected (still wrong) item teaches nothing", correctionProposals({ jobId: "j", jobTitle: "t", paper: "PAPER I", at: "x", files, items: [{ ...items[0], after: q4read }] }).length === 0);
let n = 0;
const id = () => `r${++n}`;
const cms = mergePaperRules([], props, "2026-11-16T00:00:00Z", id).rules;
ok("new rules start PROPOSED", cms.every((r) => r.status === "PROPOSED"));
ok("PROPOSED rules never reach the prompt", memoryBrief(cms, "PAPER I", "extract") === "");
const confirmed: PaperRule[] = cms.map((r) => ({ ...r, status: "CONFIRMED", decidedById: "admin", decidedAt: "2026-11-16T01:00:00Z" }));
const brief = memoryBrief(confirmed, "PAPER I", "extract");
ok("confirmed rules in the extract prompt", /numbered statements read as options/.test(brief) && /line wraps/.test(brief), brief);
ok("other paper of the same exam gets no paper rules", memoryBrief(confirmed, "PAPER II", "extract") === "");
ok("confirmed rule flags a repeat (never changes it)", memoryFindings(confirmed, "PAPER I", q4read, { aiRead: true, officialAnswer: false, finalAnswer: [], subjectName: null, fileSha256: null }).some((f) => /read as options/.test(f.detail)));
const remerge = mergePaperRules(confirmed, props.map((p) => ({ ...p, evidence: { ...p.evidence, jobId: "jobCMS-2" } })), "2026-11-17T00:00:00Z", id).rules;
ok("re-learning keeps a confirmed rule confirmed and adds evidence", remerge.filter((r) => r.kind === "EXTRACTION_ERROR").every((r) => r.status === "CONFIRMED" && r.evidence.length === 2 && r.decidedById === "admin"));
// Isolation: memory is one Setting per exam id; rules of one exam's list are never consulted for another exam.
ok("memory stored per exam id (Setting key prefix + examId)", /TAXONOMY_MEMORY_PREFIX\s*=\s*"ai\.importer\.taxonomyMemory:"/.test(readFileSync("lib/ai-import/taxonomy-memory.ts", "utf8")) && /key: `\$\{TAXONOMY_MEMORY_PREFIX\}\$\{examId\}`/.test(readFileSync("lib/ai-import/taxonomy-memory.ts", "utf8")));
const ruhsRules: PaperRule[] = [];
ok("RUHS memory empty while CMS has confirmed rules", memoryBrief(ruhsRules, "PAPER I", "extract") === "" && memoryFindings(ruhsRules, "PAPER I", q4read, { aiRead: true, officialAnswer: false, finalAnswer: [], subjectName: null, fileSha256: null }).length === 0);

// ---- Q5 side-by-side lists (local OCR) + Verify 2 structural-only repair ---------------------------------------------
const side = parseMatchLists("Match List I with List II :\nList I List II\n(Mutation) (Phenotype)\nA. Beta-myosin heavy chain mutations 1. Marked ventricular hypertrophy\nB. Troponin mutations 2. Hypertension and arrhythmia\nC. Myosin-binding protein-C mutations 3. Myocardial fibre disarray\nCode :\nA B C");
ok("side-by-side rows aligned", side?.listI.map((e) => `${e.key}=${e.text}`).join("|") === "A=Beta-myosin heavy chain mutations|B=Troponin mutations|C=Myosin-binding protein-C mutations" && side?.listII.map((e) => e.key).join() === "1,2,3" && side?.listII[1].text === "Hypertension and arrhythmia", side);
ok("side-by-side headings kept in text", side?.rest === "Match List I with List II :\nList I (Mutation) — List II (Phenotype)", side?.rest);
ok("wrapped two-column cells → not parsed (no guess)", parseMatchLists("Match :\nList I List II\nA. Beta-myosin heavy 1. Marked\nchain mutations ventricular\nB. Troponin 2. Hypertension") === null);
ok("List II longer by a row accepted", parseMatchLists("M\nList I List II\nA. a 1. p\nB. b 2. q\n3. r")?.listII.length === 3);
ok("row after a List II-only line → not parsed", parseMatchLists("M\nList I List II\nA. a 1. p\n2. q\nB. b 3. r") === null);
const v2 = repairLayout([q4read], NO_OCR)[0];
ok("Verify 2: statements moved, OCR never borrowed (difference stays visible)", v2.options.length === 0 && /\n4\. Ventriculography/.test(v2.stem));
ok("Verify 2: echoed keys relabelled the same way", repairLayout([q5a], NO_OCR)[0].listI!.map((e) => e.key).join() === "A,B,C");

console.log(`\ncms26-layout: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
