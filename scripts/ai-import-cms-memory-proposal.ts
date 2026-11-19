/**
 * CMS initial paper memory — PROPOSED only, offline (P3 of the importer redesign). Reads the approved corpus export of
 * the 4 CMS jobs and writes the rules the learner would propose to a JSON file. It never writes to any database and
 * never calls AI; every rule is PROPOSED and must still be confirmed by an administrator in the memory admin page.
 *
 * Same evidence rules as lib/ai-import/paper-learn.ts: Word sources re-read locally, an official key only when matched to
 * ≥ 50 % approved questions, subjects of approved questions, and corrections of approved questions (here: stored read →
 * approved edit, since the corpus has no version rows; OCR fixes only when the page's source text shows them).
 *
 *   DOTENV_CONFIG_PATH=/dev/null DATABASE_URL=<scratch, unused> NODE_OPTIONS=--conditions=react-server \
 *   npx tsx scripts/ai-import-cms-memory-proposal.ts [corpusDir] [outFile]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readDocx } from "@/lib/ai-import/docx";
import { docxQuestions } from "@/lib/ai-import/process";
import { numberStyles } from "@/lib/ai-import/paper-learn";
import { correctionProposals, editionOf, learnPaperRules, mergePaperRules, paperOf, type CorrectionItem, type LearnInput, type PaperRuleProposal } from "@/lib/ai-import/paper-memory";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

const CORPUS = process.argv[2] ?? "/root/mts-scratch/redesign/corpus";
const OUT = process.argv[3] ?? "/root/mts-scratch/redesign/p3/cms-memory-proposal.json";
const CMS_JOBS = ["cmw2w5irk059z5hkzby3sgrzc", "cmw3rgq5q00eg01kzr3cd5yaw", "cmwk38t5g04yvxckz5qrs111k", "cmwhg4ksj01ksbzkzxy4l1w2k"];
// "cMS 2024 2" names no paper; in production it is linked to the UPSC CMS 2024 Paper II Previous Year Paper (D-memory.md §3).
const PAPER_OVERRIDE: Record<string, string> = { cmw3rgq5q00eg01kzr3cd5yaw: "PAPER II" };

type Row = Record<string, unknown>;
const jsonl = (f: string): Row[] => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row) : []);

export async function proposeCms(corpus = CORPUS) {
  const proposals: PaperRuleProposal[] = [];
  const sources: Row[] = [];
  for (const jobId of CMS_JOBS) {
    const dir = path.join(corpus, jobId);
    const job = JSON.parse(readFileSync(path.join(dir, "job.json"), "utf8")) as { id: string; title: string; year: number | null; expectedQuestions: number | null; exam: string };
    if (job.exam !== "UPSC CMS") throw new Error(`${jobId} is not a CMS job (${job.exam}) — refusing.`);
    const files = jsonl(path.join(dir, "files.jsonl")) as { id: string; role: string; originalName: string; ext: string; sha256: string | null; paperFileId: string | null }[];
    const questions = jsonl(path.join(dir, "questions.jsonl")) as { id: string; fileId: string; sourceLabel: string; status: string; approved: boolean; pages: number[]; data: ExtractedQuestion; editedData: ExtractedQuestion | null; subjectName: string | null }[];
    const keys = jsonl(path.join(dir, "keys.jsonl")) as { keyFileId: string; sourceNumber: number; rawValue: string; status: string; matchedQuestionId: string | null }[];
    const pages = jsonl(path.join(dir, "pages.jsonl")) as { fileId: string; pageNumber: number; textLayer: string | null; ocrText: string | null }[];
    const paper = PAPER_OVERRIDE[jobId] ?? paperOf(job.title) ?? paperOf(files.find((f) => f.role === "PAPER")?.originalName);
    const edition = editionOf(job.year, job.title);
    const at = new Date().toISOString();
    const approved = questions.filter((q) => q.approved || q.status === "IMPORTED" || q.status === "PUBLISHED");
    for (const file of files.filter((f) => f.role === "PAPER")) {
      let source: LearnInput["source"] = null;
      const local = readdirSync(path.join(dir, "files")).find((n) => n.startsWith("PAPER__") && n.includes(file.sha256 ?? "§"));
      if (file.ext === "docx" && local) {
        const doc = await readDocx(path.join(dir, "files", local));
        const fresh = docxQuestions(doc).map((q) => ({ ...q, heading: q.hints?.subject ?? null }));
        source = { questions: fresh, numberStyles: numberStyles(doc.lines.map((l) => l.text), fresh), sectionRestarts: new Set(fresh.map((q) => q.section)).size - 1 };
      }
      let approvedKey: LearnInput["approvedKey"] = null;
      const approvedIds = new Set(approved.filter((q) => q.fileId === file.id).map((q) => q.id));
      for (const k of files.filter((x) => x.role === "ANSWER_KEY" && (!x.paperFileId || x.paperFileId === file.id))) {
        const rows = keys.filter((r) => r.keyFileId === k.id);
        const expected = job.expectedQuestions ?? null;
        if (!expected) continue;
        const values = new Map(rows.filter((r) => (!!r.matchedQuestionId && approvedIds.has(r.matchedQuestionId)) || r.status === "WITHDRAWN").map((r) => [r.sourceNumber, r.rawValue.trim()] as const));
        if (values.size < Math.ceil(expected * 0.5)) continue;
        approvedKey = { fileName: k.originalName, fileSha256: k.sha256, values, expected, fileKind: k.ext, read: "text layer" };
      }
      const subjects = new Map<string, number>();
      for (const q of approved.filter((x) => x.fileId === file.id && x.subjectName)) subjects.set(q.subjectName!, (subjects.get(q.subjectName!) ?? 0) + 1);
      proposals.push(...learnPaperRules({ jobId, jobTitle: job.title, paper, edition, fileName: file.originalName, fileSha256: file.sha256, at, source, approvedKey, approvedSubjects: subjects.size ? subjects : null, ocrCorrections: [] }));
    }
    const pageText = new Map(pages.map((p) => [`${p.fileId}#${p.pageNumber}`, [p.textLayer, p.ocrText].filter(Boolean).join("\n")]));
    const items: CorrectionItem[] = approved.filter((q) => q.editedData).map((q) => ({ fileId: q.fileId, label: q.sourceLabel, kind: "EDIT", before: q.data, after: q.editedData, aiRead: /^AI/.test(q.data.method ?? ""), acceptedSuggestion: false, sourceText: q.pages.map((n) => pageText.get(`${q.fileId}#${n}`) ?? "").join("\n") }));
    proposals.push(...correctionProposals({ jobId, jobTitle: job.title, paper, edition, at, files: new Map(files.map((f) => [f.id, { name: f.originalName, sha: f.sha256 }])), items }));
    sources.push({ jobId, title: job.title, paper, edition, approved: approved.length, corrections: items.length });
  }
  let n = 0;
  const { rules } = mergePaperRules([], proposals, new Date().toISOString(), () => `cms-p${++n}`);
  if (rules.some((r) => r.status !== "PROPOSED")) throw new Error("A proposal must never be confirmed.");
  return { exam: "UPSC CMS", status: "PROPOSED" as const, generatedAt: new Date().toISOString(), note: "Offline proposal only. Nothing was written to any database. An administrator reviews and confirms each rule.", sources, rules };
}

if (process.argv[1]?.endsWith("ai-import-cms-memory-proposal.ts")) {
  proposeCms()
    .then((out) => {
      writeFileSync(OUT, JSON.stringify(out, null, 2));
      console.log(`Wrote ${out.rules.length} PROPOSED rule(s) to ${OUT}`);
      for (const s of out.sources) console.log(" ", JSON.stringify(s));
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
