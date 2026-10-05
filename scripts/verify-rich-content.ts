/**
 * NEET Phase 1 — rich scientific content foundation (server side).
 *
 * Proves, against a DISPOSABLE database:
 *  - the renderer: Physics (inline/display, fractions, roots, Greek, vectors,
 *    sub/superscripts, scientific notation, units), Chemistry via mhchem
 *    (equations, ions, charges, arrows, equilibrium), mixed text + formulas;
 *  - malformed LaTeX / mhchem never throws; stored HTML/scripts are escaped;
 *    KaTeX runs with trust:false (\href, \url, \html*, \includegraphics inert);
 *  - PLAIN content is never parsed (exact text out);
 *  - snapshot v1 is written byte-identically for PLAIN questions without an
 *    explanation; v2 for RICH_V1 (or any explanation), with assets;
 *  - the player payload never carries correctLabel or the explanation before
 *    an authorized reveal; revealAnswer releases them together;
 *  - v1 and v2 readers, unknown additive keys, legacy imageUrl fields;
 *  - QuestionAsset can represent the four Phase 1 example questions;
 *  - a 180-question RICH_V1 paper: render time + payload size.
 *
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx scripts/verify-rich-content.ts
 *
 * `setup` / `cleanup <fixture.json>` prepare the browser suite
 * (scripts/verify-rich-content.mjs).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import argon2 from "argon2";
import { PrismaClient, QuestionDifficulty, QuestionSource, QuestionStatus, StudentAuthProvider, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { revealAnswer, startPreviousYearPaperAttempt, submitAttempt, type QuestionSnapshot } from "@/lib/test-attempt";
import { toPlayerQuestions } from "@/lib/test-player-data";
import {
  KATEX_OPTIONS,
  assetUrl,
  explanationView,
  liveRichViews,
  parseRich,
  readAssets,
  renderRichHtml,
  renderText,
  richQuestionView,
  snapshotVersion,
} from "@/lib/rich-content";
import { nextStudentId } from "@/lib/student-id";
import { ensureDefaultExamEnrollmentSafely } from "@/lib/default-enrollment";
import { createFixtureSubject, createFixtureTopic, deleteFixtureTaxonomy } from "./fixture-taxonomy";
import { PLAIN_TRICKY, SENTINEL, fixtureQuestions, perfQuestions, type FixtureQuestion } from "./rich-content-fixtures";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") && process.env.ALLOW_PRODUCTION_DB !== "1") {
  console.error("Refusing to run against what looks like the production database. Point DATABASE_URL at a disposable copy.");
  process.exit(2);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (!passed) failures++;
}

// KaTeX shows an undefined command in its error color instead of a katex-error span.
const KATEX_ERROR_COLOR = "#cc0000";
const katexOk = (html: string) =>
  html.includes('class="katex"') && !html.includes("katex-error") && !html.includes("rich-math-error") && !html.includes(KATEX_ERROR_COLOR);
const katexFlagged = (html: string) => html.includes("katex-error") || html.includes("rich-math-error") || html.includes(KATEX_ERROR_COLOR);

/**
 * Walks the REAL tags of rendered HTML (escaped text contains no `<`, so every
 * `<` opens a tag) and rejects anything executable or navigational: script-ish
 * elements, event handlers, href/src attributes, javascript: values. TeX
 * source shown as text (e.g. the annotation of a refused \href) is not a tag.
 */
const FORBIDDEN_TAGS = new Set(["script", "img", "a", "iframe", "object", "embed", "form", "input", "link", "meta", "style", "base", "foreignobject", "image", "use"]);
function activeHtmlProblems(html: string): string[] {
  const problems: string[] = [];
  for (const m of html.matchAll(/<\/?([a-zA-Z][\w:-]*)([^>]*)>/g)) {
    const tag = m[1].toLowerCase();
    if (FORBIDDEN_TAGS.has(tag)) problems.push(`tag <${tag}>`);
    for (const a of m[2].matchAll(/([^\s=]+)\s*=\s*"([^"]*)"/g)) {
      const name = a[1].toLowerCase();
      if (name.startsWith("on") || name === "href" || name === "src" || name === "xlink:href" || name === "formaction" || name === "srcdoc") problems.push(`attr ${name} on <${tag}>`);
      if (/javascript:|data:text\/html/i.test(a[2])) problems.push(`value ${a[2]}`);
    }
  }
  return problems;
}
const noActiveHtml = (html: string) => activeHtmlProblems(html).length === 0;

// ---------------------------------------------------------------------------
// Fixture DB helpers (shared with setup/cleanup)
// ---------------------------------------------------------------------------

async function seedPaper(examId: string, subjectId: string, topicId: string, title: string, codePrefix: string, questions: FixtureQuestion[]) {
  const paper = await prisma.previousYearPaper.create({ data: { examId, year: 2026, title, isActive: true } });
  const ids: Record<string, string> = {};
  // createdAt order = paper order (planPreviousYearPaperStart orders by createdAt, code).
  const t0 = Date.now() - questions.length * 1000;
  for (const [i, q] of questions.entries()) {
    const row = await prisma.question.create({
      data: {
        examId,
        subjectId,
        topicId,
        previousYearPaperId: paper.id,
        source: QuestionSource.PYQ,
        examYear: 2026,
        code: `${codePrefix}-${String(i + 1).padStart(3, "0")}`,
        text: q.text,
        imageUrl: q.imageUrl ?? null,
        contentFormat: q.contentFormat,
        explanation: q.explanation ?? null,
        status: QuestionStatus.PUBLISHED,
        difficulty: QuestionDifficulty.MEDIUM,
        createdAt: new Date(t0 + i * 1000),
        options: {
          create: q.options.map((o, order) => ({ label: o.label, text: o.text, isCorrect: !!o.isCorrect, imageUrl: o.imageUrl ?? null, order })),
        },
        assets: q.assets?.length
          ? {
              create: q.assets.map((a) => ({
                role: a.role,
                optionLabel: a.optionLabel ?? null,
                order: a.order,
                storageKey: a.storageKey,
                mime: "image/webp",
                width: a.width,
                height: a.height,
                bytes: 12345,
                sha256: a.storageKey.slice(2, 66),
                alt: a.alt,
                caption: a.caption ?? null,
                darkBacking: a.darkBacking ?? true,
              })),
            }
          : undefined,
      },
    });
    ids[q.key] = row.id;
  }
  return { paperId: paper.id, ids };
}

async function seedExam(suffix: string) {
  const exam = await prisma.exam.create({ data: { name: `RCV Exam ${suffix}`, code: `RCV-${suffix}`, isActive: true } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: "RCV Physics" });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: "RCV Topic" });
  const main = await seedPaper(exam.id, subject.id, topic.id, `RCV Paper ${suffix}`, `RCV-${suffix}`, fixtureQuestions(suffix));
  const perf = await seedPaper(exam.id, subject.id, topic.id, `RCV Perf Rich ${suffix}`, `RCVP-${suffix}`, perfQuestions(suffix));
  const plainPerf = await seedPaper(
    exam.id,
    subject.id,
    topic.id,
    `RCV Perf Plain ${suffix}`,
    `RCVL-${suffix}`,
    perfQuestions(suffix).map((q) => ({ ...q, contentFormat: "PLAIN" as const, explanation: null, assets: [] }))
  );
  return { examId: exam.id, subjectId: subject.id, main, perf, plainPerf };
}

async function cleanupExam(examId: string, studentIds: string[]) {
  await prisma.studentActivity.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.testAttempt.deleteMany({ where: { OR: [{ studentId: { in: studentIds } }, { examId }] } });
  await prisma.question.deleteMany({ where: { examId } }); // QuestionAsset cascades
  await prisma.previousYearPaper.deleteMany({ where: { examId } });
  await prisma.studentExamEnrollment.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentSession.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentDevice.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await deleteFixtureTaxonomy(prisma, [examId]);
  await prisma.exam.deleteMany({ where: { id: examId } });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

async function main() {
  const suffix = Date.now().toString(36);
  const students: string[] = [];
  const mkStudent = async (tag: string) => {
    const s = await prisma.student.create({
      data: { studentId: `RCV${tag}-${suffix}`, name: `RCV ${tag}`, email: `rcv-${tag.toLowerCase()}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    students.push(s.id);
    return s.id;
  };

  console.log("\n--- KaTeX configuration ---");
  check("trust is false", KATEX_OPTIONS.trust === false);
  check("throwOnError is false", KATEX_OPTIONS.throwOnError === false);
  check('strict is "warn"', KATEX_OPTIONS.strict === "warn");

  console.log("\n--- Physics rendering ---");
  for (const tex of ["$v^2 = u^2 + 2as$", "$\\frac{1}{f} = \\frac{1}{v} - \\frac{1}{u}$", "$E = \\frac{1}{2}mv^2$", "$\\lambda = \\frac{h}{p}$", "$\\sqrt{2gh}$"]) {
    const html = renderRichHtml(tex);
    check(`renders ${tex}`, katexOk(html) && html.includes("<math"), html.slice(0, 200));
  }
  const frac = renderRichHtml("$\\frac{1}{f}$");
  check("fraction produces a KaTeX mfrac", frac.includes("mfrac") && frac.includes("frac-line"));
  check("root produces a KaTeX sqrt", renderRichHtml("$\\sqrt{2gh}$").includes("sqrt"));
  const sup = renderRichHtml("$v^2$ and $\\omega_0$");
  check("superscript + subscript (msup / msub)", sup.includes("<msup>") && sup.includes("<msub>"));
  const greek = renderRichHtml("$\\alpha \\beta \\gamma \\Delta \\lambda \\omega \\pi \\theta \\mu$");
  check("Greek symbols", katexOk(greek) && ["α", "β", "γ", "Δ", "λ", "ω", "π", "θ", "μ"].every((g) => greek.includes(g)));
  const vec = renderRichHtml("$\\vec{F} = m\\vec{a}$ and $\\hat{i}$, $\\overrightarrow{AB}$");
  check("vectors (\\vec, \\hat, \\overrightarrow)", katexOk(vec) && vec.includes("→"), vec.slice(0, 200));
  const sci = renderRichHtml("$6.02 \\times 10^{23}$ and $1.6 \\times 10^{-19}\\ \\mathrm{C}$");
  check("scientific notation", katexOk(sci) && sci.includes("×") && sci.includes("23"));
  const units = renderRichHtml("$9.8\\ \\mathrm{m\\,s^{-2}}$, $\\pu{3.0e8 m/s}$ and \\pu{mol L-1 s-1}");
  check("units (\\mathrm and mhchem \\pu)", katexOk(units), units.slice(0, 200));
  const mixed = renderRichHtml("A body of mass $m$ falls a height $h$; its speed is $\\sqrt{2gh}$.");
  check("inline formulas inside English text", katexOk(mixed) && mixed.startsWith("A body of mass ") && (mixed.match(/class="rich-math"/g) ?? []).length === 3);
  const display = renderRichHtml("Energy:\n$$E = \\frac{1}{2}mv^2$$\nDone");
  check("display equation", katexOk(display) && display.includes("katex-display") && display.includes("rich-math-display") && display.includes('display="block"'));
  const many = renderRichHtml("$a$, $b$, $$c$$ and $d$");
  check("multiple formulas in one field", (many.match(/class="katex"/g) ?? []).length === 4);
  const long = fixtureQuestions(suffix).find((q) => q.key === "long")!;
  const longHtml = renderRichHtml(long.text);
  check("long equations render and are wrapped in scroll containers", katexOk(longHtml) && longHtml.includes("rich-math-display") && longHtml.includes('class="rich-math"'));
  const escapedDollar = renderRichHtml("Price \\$5 and $x$");
  check("\\$ is a literal dollar", escapedDollar.startsWith("Price $5 and ") && katexOk(escapedDollar));

  console.log("\n--- Chemistry rendering (mhchem) ---");
  const water = renderRichHtml("$\\ce{2H2 + O2 -> 2H2O}$");
  check("$\\ce{2H2 + O2 -> 2H2O}$ renders with a reaction arrow", katexOk(water) && water.includes("→"), water.slice(0, 300));
  const acid = renderRichHtml("$\\ce{H2SO4}$");
  check("$\\ce{H2SO4}$ renders with subscripts", katexOk(acid) && acid.includes("<msub>"));
  const ions = renderRichHtml("$\\ce{Fe^3+}$ $\\ce{SO4^2-}$ $\\ce{NH4+}$ $\\ce{OH-}$");
  check("ions and ionic charges (superscript + / −)", katexOk(ions) && ions.includes("<msup>") && (ions.includes("+") && (ions.includes("−") || ions.includes("-"))));
  const eq = renderRichHtml("$\\ce{N2 + 3H2 <=> 2NH3}$");
  check("equilibrium arrows (<=>)", katexOk(eq) && (eq.includes("⇌") || eq.includes("harpoon") || eq.includes("rightleftharpoons")), eq.slice(0, 300));
  const bare = renderRichHtml("Water \\ce{H2O} forms.");
  check("bare \\ce{} outside $…$ renders in text", katexOk(bare) && bare.startsWith("Water ") && bare.endsWith(" forms."));
  const cond = renderRichHtml("$\\ce{CH3CH2OH ->[H2SO4][443 K] CH2=CH2 + H2O}$");
  check("arrow with conditions and a double bond", katexOk(cond));
  const complex = renderRichHtml("\\ce{[Cu(NH3)4]^2+}");
  check("complex ion with nested braces", katexOk(complex));
  check("chemistry inside option text", katexOk(renderRichHtml("$\\ce{SO4^2-}$")));

  console.log("\n--- Malformed content never throws ---");
  const malformedSources = [
    "$\\frac{1}{$",
    "$\\notacommand{x}$",
    "$\\ce{->(}$",
    "\\ce{H2O",
    "unclosed $x + 1",
    "$$ y",
    "$}$",
    "$\\sqrt{$",
    "$\\def\\a{\\a}\\a$",
    "$" + "{".repeat(500) + "$",
    "$\\rule{1000em}{1000em}$",
    fixtureQuestions(suffix).find((q) => q.key === "malformed")!.text,
  ];
  for (const src of malformedSources) {
    let ok = true;
    let html = "";
    try {
      html = renderRichHtml(src);
    } catch (e) {
      ok = false;
      html = String(e);
    }
    check(`no throw: ${JSON.stringify(src).slice(0, 50)}`, ok && typeof html === "string", html.slice(0, 200));
  }
  check("an undefined command is flagged inline in the error color", katexFlagged(renderRichHtml("$\\notacommand{x}$")));
  check("a parse error shows the katex-error span", renderRichHtml("$\\frac{1}{$").includes("katex-error"));
  check("an unclosed $ is literal text", renderRichHtml("unclosed $x + 1") === "unclosed $x + 1");
  check("an unclosed \\ce{ is literal text", renderRichHtml("\\ce{H2O") === "\\ce{H2O");
  const recursion = renderRichHtml("$\\def\\a{\\a}\\a$");
  check("recursive macro is bounded (maxExpand) and shows an error", katexFlagged(recursion));

  console.log("\n--- Security: stored HTML / scripts / trust ---");
  const sec = fixtureQuestions(suffix).find((q) => q.key === "security")!;
  const secHtml = renderRichHtml(sec.text);
  check("no executable tag/attribute in rendered RICH text", noActiveHtml(secHtml), activeHtmlProblems(secHtml));
  check("<script> source is shown escaped", secHtml.includes("&lt;script&gt;window.__xss=1&lt;/script&gt;"));
  check("<img onerror> source is shown escaped", secHtml.includes("&lt;img src=x onerror=&quot;window.__xss=2&quot;&gt;"));
  for (const cmd of ["\\href{javascript:alert(1)}{x}", "\\url{javascript:alert(1)}", "\\htmlClass{evil}{y}", "\\htmlId{evil}{y}", "\\htmlStyle{color:red}{y}", "\\htmlData{x=1}{y}", "\\includegraphics{https://example.com/x.png}"]) {
    const html = renderRichHtml(`$${cmd}$`);
    check(`trust:false refuses ${cmd.split("{")[0]}`, katexFlagged(html) && noActiveHtml(html) && !html.includes('class="evil"') && !html.includes('id="evil"'), html.slice(0, 300));
  }
  check("the \\href source stays visible only as escaped text", secHtml.includes("\\href{javascript:window.__xss=3}{click}") && noActiveHtml(secHtml));
  for (const opt of sec.options) check(`option ${opt.label} is inert`, noActiveHtml(renderRichHtml(opt.text)));
  const textCmd = renderRichHtml("$\\text{<b>x</b>}$");
  check("\\text{<b>} is escaped by KaTeX", !textCmd.includes("<b>") && textCmd.includes("&lt;b&gt;"));
  const attrBreak = renderRichHtml('" onmouseover="x" \' <svg onload=1>');
  check("quotes and <svg> in text are escaped", noActiveHtml(attrBreak) && !attrBreak.includes("<svg"));
  check("asset URLs: only safe relative raster keys", assetUrl("q/abc.webp") === "/media/q/abc.webp" && assetUrl("../etc/passwd.png") === null && assetUrl("/abs.png") === null && assetUrl("q/x.svg") === null && assetUrl("javascript:alert(1)//.png") === null && assetUrl("q/a b.png") === null);
  check(
    "snapshot asset with a foreign url is dropped",
    readAssets([{ role: "QUESTION", url: "https://evil.example/x.png", storageKey: "../x.png", alt: "", width: 1, height: 1 }]).length === 0
  );

  console.log("\n--- PLAIN content is never parsed ---");
  const plain = renderText("PLAIN", PLAIN_TRICKY);
  check("renderText(PLAIN) returns the exact text", plain.format === "PLAIN" && plain.text === PLAIN_TRICKY);
  for (const f of [undefined, null, "", "plain", "RICH_V2", "rich_v1"]) {
    const r = renderText(f, PLAIN_TRICKY);
    check(`unknown format ${JSON.stringify(f)} falls back to PLAIN`, r.format === "PLAIN" && r.text === PLAIN_TRICKY);
  }
  check("parser output is 1:1 for text with no math", JSON.stringify(parseRich("plain text")) === JSON.stringify([{ kind: "text", value: "plain text" }]));

  const fixture = await seedExam(suffix);
  try {
    const ids = fixture.main.ids;

    console.log("\n--- Snapshot V1 (PLAIN, no explanation) is written exactly as before ---");
    const sExam = await mkStudent("E1");
    const examAttempt = await startPreviousYearPaperAttempt(sExam, fixture.main.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
    const examRows = await prisma.testAttemptQuestion.findMany({ where: { attemptId: examAttempt.id }, orderBy: { order: "asc" } });
    const snap = (key: string) => examRows.find((r) => r.questionId === ids[key])!.questionSnapshot as unknown as QuestionSnapshot & Record<string, unknown>;
    const plainSnap = snap("plain");
    check(
      "PLAIN snapshot has exactly the v1 keys",
      JSON.stringify(Object.keys(plainSnap).sort()) === JSON.stringify(["code", "correctLabel", "difficulty", "imageUrl", "options", "text"]),
      Object.keys(plainSnap)
    );
    const plainRow = await prisma.question.findUnique({ where: { id: ids.plain }, include: { options: { orderBy: { order: "asc" } } } });
    const expectedV1 = {
      code: plainRow!.code,
      text: plainRow!.text,
      imageUrl: plainRow!.imageUrl,
      difficulty: plainRow!.difficulty,
      options: plainRow!.options.map((o) => ({ label: o.label, text: o.text, imageUrl: o.imageUrl })),
      correctLabel: "A",
    };
    check("PLAIN snapshot equals the pre-Phase-1 v1 shape exactly (canonical JSON)", canonical(plainSnap) === canonical(expectedV1), { got: canonical(plainSnap), want: canonical(expectedV1) });
    check("legacy Question.imageUrl / QuestionOption.imageUrl frozen unchanged", plainSnap.imageUrl === "/storage/question-images/legacy-plain-fixture.webp" && plainSnap.options[0].imageUrl === "/storage/question-images/legacy-opt-a.webp");
    check("snapshotVersion(v1) = 1", snapshotVersion(plainSnap) === 1);

    console.log("\n--- Snapshot V2 ---");
    const phys = snap("physics");
    check("RICH_V1 snapshot is v2", phys.v === 2 && phys.contentFormat === "RICH_V1");
    check("v2 keeps every v1 key (old readers keep working)", ["code", "text", "imageUrl", "difficulty", "options", "correctLabel"].every((k) => k in phys));
    check("v2 freezes the explanation", typeof phys.explanation === "string" && (phys.explanation as string).includes(`${SENTINEL}-${suffix}-physics`));
    check("v2 text is the raw source (rendering happens at read time)", phys.text === fixtureQuestions(suffix).find((q) => q.key === "physics")!.text);
    const org = snap("organic");
    const orgAssets = org.assets as unknown as { role: string; optionLabel: string | null; url: string; alt: string; width: number; height: number; darkBacking: boolean; order: number }[];
    check("v2 freezes assets with role/optionLabel/url/alt/width/height/darkBacking/order", orgAssets.length === 5 && orgAssets.every((a) => a.url.startsWith("/media/q/") && a.alt && a.width > 0 && a.height > 0 && a.darkBacking === true && typeof a.order === "number"));
    const plainExpl = snap("plain-explained");
    check("PLAIN question WITH an explanation is v2 PLAIN (text not parsed)", plainExpl.v === 2 && plainExpl.contentFormat === "PLAIN" && Array.isArray(plainExpl.assets) && (plainExpl.assets as unknown[]).length === 0);
    const bio = snap("biology");
    const bioAssets = (bio.assets as unknown as { order: number; alt: string }[]).map((a) => a.order);
    check("assets are frozen in order", JSON.stringify(bioAssets) === JSON.stringify([0, 1]));

    console.log("\n--- Active player payload: EXAM mode (no reveal ever) ---");
    const examAttemptFull = await prisma.testAttempt.findUnique({ where: { id: examAttempt.id }, include: { questions: { orderBy: { order: "asc" }, include: { answer: true } } } });
    const examPayload = toPlayerQuestions(examAttemptFull!.questions, { instantMode: false });
    const examJson = JSON.stringify(examPayload);
    check("no correctLabel anywhere", !examJson.includes("correctLabel"));
    check("no explanation sentinel anywhere", !examJson.includes(SENTINEL));
    check("no 'explanation' key anywhere", !examJson.includes('"explanation"'));
    check("no EXPLANATION assets in the payload", !examJson.includes('"EXPLANATION"'));
    const pPlain = examPayload.find((q) => q.questionId === ids.plain)!;
    check(
      "PLAIN player question has exactly the pre-Phase-1 keys (no `rich`)",
      JSON.stringify(Object.keys(pPlain).sort()) === JSON.stringify(["difficulty", "imageUrl", "malformed", "markForReview", "options", "questionId", "reveal", "saved", "selectedOptionLabel", "text"]),
      Object.keys(pPlain).sort()
    );
    check("PLAIN player text is the raw text", pPlain.text === PLAIN_TRICKY);
    check("legacy images reach the player unchanged", pPlain.imageUrl === "/storage/question-images/legacy-plain-fixture.webp" && pPlain.options[0].imageUrl === "/storage/question-images/legacy-opt-a.webp");
    const pPhys = examPayload.find((q) => q.questionId === ids.physics)!;
    check("RICH player question carries server-rendered HTML", !!pPhys.rich && katexOk(pPhys.rich.textHtml) && Object.values(pPhys.rich.optionHtml).every((h) => h.includes("katex")));
    const pOrg = examPayload.find((q) => q.questionId === ids.organic)!;
    check("question + A–D option images reach the player", pOrg.rich!.assets.filter((a) => a.role === "QUESTION").length === 1 && ["A", "B", "C", "D"].every((l) => pOrg.rich!.assets.some((a) => a.role === "OPTION" && a.optionLabel === l)));
    const pExpl = examPayload.find((q) => q.questionId === ids.explained)!;
    check("explanation images are NOT in the player before reveal", pExpl.rich!.assets.length === 0);
    const pMal = examPayload.find((q) => q.questionId === ids.malformed)!;
    check("malformed RICH question still serializes (errors inline)", !!pMal.rich && pMal.rich.textHtml.includes("katex-error") && !pMal.malformed);
    check("security fixture is inert in the payload", noActiveHtml(examPayload.find((q) => q.questionId === ids.security)!.rich!.textHtml));

    console.log("\n--- Reveal rules: EXAM mode refuses, PRACTICE mode releases answer + explanation together ---");
    let refused = false;
    try {
      await revealAnswer(examAttempt.id, sExam, ids.physics, "A");
    } catch {
      refused = true;
    }
    check("EXAM-mode reveal is refused (no explanation path)", refused);

    const sPrac = await mkStudent("P1");
    const prac = await startPreviousYearPaperAttempt(sPrac, fixture.main.paperId, { answerMode: "INSTANT", durationMode: "FIXED" });
    const loadPrac = async () =>
      (await prisma.testAttempt.findUnique({ where: { id: prac.id }, include: { questions: { orderBy: { order: "asc" }, include: { answer: true } } } }))!.questions;
    const before = JSON.stringify(toPlayerQuestions(await loadPrac(), { instantMode: true }));
    check("Practice Mode, before any reveal: no correctLabel / explanation", !before.includes("correctLabel") && !before.includes(SENTINEL));
    const rev = await revealAnswer(prac.id, sPrac, ids.physics, "B");
    check("reveal returns the correct label", rev.correctLabel === "A" && rev.isCorrect === false);
    check("reveal returns the rendered human explanation", !!rev.explanation?.body && rev.explanation.body.format === "RICH_V1" && katexOk(rev.explanation.body.html) && rev.explanation.body.html.includes(`${SENTINEL}-${suffix}-physics`));
    const revExpl = await revealAnswer(prac.id, sPrac, ids.explained, "A");
    check("reveal returns the two EXPLANATION images in order", revExpl.explanation?.assets.length === 2 && revExpl.explanation.assets[0].alt.startsWith("Ray diagram"));
    const revPlain = await revealAnswer(prac.id, sPrac, ids.plain, "A");
    check("reveal of a v1 question has no explanation key (unchanged response)", !("explanation" in revPlain) && JSON.stringify(Object.keys(revPlain).sort()) === JSON.stringify(["correctLabel", "isCorrect", "selectedOptionLabel"]));
    const revPE = await revealAnswer(prac.id, sPrac, ids["plain-explained"], "A");
    check("PLAIN explanation is released as literal text", revPE.explanation?.body?.format === "PLAIN" && revPE.explanation.body.text.startsWith("Plain explanation $y$"));
    const after = toPlayerQuestions(await loadPrac(), { instantMode: true });
    const afterPhys = after.find((q) => q.questionId === ids.physics)!;
    const afterChem = after.find((q) => q.questionId === ids.chemistry)!;
    check("after reveal (reload): revealed question carries correctLabel + explanation", afterPhys.reveal?.correctLabel === "A" && !!afterPhys.reveal.explanation);
    check("after reveal (reload): an unrevealed question still carries neither", afterChem.reveal === null && !JSON.stringify(afterChem).includes(SENTINEL));
    const afterJson = JSON.stringify(after);
    check(
      "only the revealed questions' explanations are present",
      (afterJson.match(new RegExp(`${SENTINEL}-${suffix}-[a-z]+`, "g")) ?? []).sort().join(",") === [`${SENTINEL}-${suffix}-explained`, `${SENTINEL}-${suffix}-physics`, `${SENTINEL}-${suffix}-plainexpl`].sort().join(",")
    );
    check("instantMode=false never reveals, even with revealedAt set", !JSON.stringify(toPlayerQuestions(await loadPrac(), { instantMode: false })).includes(SENTINEL));

    console.log("\n--- Scoring is unchanged for v2 snapshots ---");
    await prisma.answer.updateMany({ where: { attemptId: examAttempt.id, questionId: ids.physics }, data: { selectedOptionLabel: "A", status: "ANSWERED" } });
    await prisma.answer.updateMany({ where: { attemptId: examAttempt.id, questionId: ids.plain }, data: { selectedOptionLabel: "A", status: "ANSWERED" } });
    await prisma.answer.updateMany({ where: { attemptId: examAttempt.id, questionId: ids.chemistry }, data: { selectedOptionLabel: "B", status: "ANSWERED" } });
    await submitAttempt(examAttempt.id, sExam);
    const scored = await prisma.answer.findMany({ where: { attemptId: examAttempt.id, questionId: { in: [ids.physics, ids.plain, ids.chemistry] } } });
    const byQ = new Map(scored.map((a) => [a.questionId, a.isCorrect]));
    check("v2 correct, v1 correct, v2 wrong scored as before", byQ.get(ids.physics) === true && byQ.get(ids.plain) === true && byQ.get(ids.chemistry) === false);

    console.log("\n--- Review (authorized) gets the explanation; V1 reader unchanged ---");
    const reviewView = explanationView(snap("explained"));
    check("review view: body + 2 explanation images", !!reviewView?.body && reviewView.assets.length === 2);
    check("review rich view excludes explanation images", richQuestionView(snap("explained"))!.assets.length === 0);
    check("v1 snapshot → no rich view, no explanation view", richQuestionView(plainSnap) === null && explanationView(plainSnap) === null);

    console.log("\n--- Reader robustness: unknown additive keys, future versions, garbage ---");
    const withUnknown = { ...expectedV1, futureKey: { a: 1 }, explanationHtml: "<script>x</script>" };
    const unk = toPlayerQuestions([{ questionId: "x", questionSnapshot: withUnknown, answer: null }], { instantMode: true })[0];
    check("v1 + unknown keys: serialized like v1, unknown keys dropped", !("rich" in unk) && !JSON.stringify(unk).includes("futureKey") && !JSON.stringify(unk).includes("explanationHtml") && unk.text === PLAIN_TRICKY);
    const v3 = { ...expectedV1, v: 3, contentFormat: "RICH_V1", explanation: "secret" };
    const u3 = toPlayerQuestions([{ questionId: "x", questionSnapshot: v3, answer: { selectedOptionLabel: "A", status: "ANSWERED", revealedAt: new Date() } }], { instantMode: true })[0];
    check("unknown version is read as v1 (no rich, no explanation)", !("rich" in u3) && !JSON.stringify(u3).includes("secret"));
    const garbage = { ...expectedV1, v: 2, contentFormat: "RICH_V1", assets: "nope", explanation: 42 };
    let gOk = true;
    try {
      const g = toPlayerQuestions([{ questionId: "x", questionSnapshot: garbage, answer: { selectedOptionLabel: "A", status: "ANSWERED", revealedAt: new Date() } }], { instantMode: true })[0];
      gOk = !!g.rich && g.rich.assets.length === 0 && g.reveal?.explanation === undefined;
    } catch {
      gOk = false;
    }
    check("garbled v2 keys never throw (assets/explanation dropped)", gOk);
    const malformedV2 = { v: 2, contentFormat: "RICH_V1", text: "$x$", options: [{ label: "A", text: "$y$" }] };
    const m2 = toPlayerQuestions([{ questionId: "x", questionSnapshot: malformedV2, answer: null }], { instantMode: false })[0];
    check("malformed v2 snapshot stays a skippable notice", m2.malformed && !("rich" in m2));

    console.log("\n--- QuestionAsset representation ---");
    const assetsOf = async (key: string) => prisma.questionAsset.findMany({ where: { questionId: ids[key] }, orderBy: [{ role: "asc" }, { optionLabel: "asc" }, { order: "asc" }] });
    const circuit = await assetsOf("circuit");
    check("Example 1 Physics: text + formula + circuit diagram", circuit.length === 1 && circuit[0].role === "QUESTION" && katexOk(renderRichHtml(fixtureQuestions(suffix).find((q) => q.key === "circuit")!.text)));
    const organic = await assetsOf("organic");
    check(
      "Example 2 Organic: reaction diagram + one structure image per option A–D",
      organic.filter((a) => a.role === "QUESTION").length === 1 &&
        JSON.stringify(organic.filter((a) => a.role === "OPTION").map((a) => a.optionLabel)) === JSON.stringify(["A", "B", "C", "D"])
    );
    const biology = await assetsOf("biology");
    check("Example 3 Biology: labelled diagram(s), multiple QUESTION assets ordered", biology.length === 2 && biology.every((a) => a.role === "QUESTION") && biology[0].order === 0 && biology[0].alt.includes("heart"));
    const explained = await assetsOf("explained");
    check("Example 4 Explanation: text + equation + two EXPLANATION diagrams", explained.length === 2 && explained.every((a) => a.role === "EXPLANATION"));
    check("accessibility + dimensions + immutable key stored", [...circuit, ...organic, ...biology, ...explained].every((a) => a.alt.length > 5 && a.width > 0 && a.height > 0 && /^q\/[0-9a-f]{64}\.webp$/.test(a.storageKey) && a.sha256.length === 64));
    const live = await prisma.question.findUnique({ where: { id: ids.organic }, include: { options: { orderBy: { order: "asc" } }, assets: true } });
    const lv = liveRichViews(live!);
    check("live view (Saved / admin preview) resolves the same assets", lv.rich!.assets.length === 5 && lv.explanation!.assets.length === 0);
    const dedup = await prisma.questionAsset.findMany({ where: { sha256: organic[0].sha256 } });
    check("sha256 index lookup works (dedup foundation)", dedup.length === 1);

    console.log("\n--- Legacy image compatibility ---");
    const legacyRich = await prisma.question.create({
      data: {
        examId: fixture.examId,
        subjectId: fixture.subjectId,
        code: `RCV-${suffix}-legacyrich`,
        text: "$x$ with a legacy image",
        imageUrl: "/storage/question-images/legacy-rich.webp",
        contentFormat: "RICH_V1",
        options: { create: [{ label: "A", text: "a", isCorrect: true, imageUrl: "/storage/question-images/legacy-rich-a.webp" }, { label: "B", text: "b" }] },
      },
    });
    const legacyRow = await prisma.question.findUnique({ where: { id: legacyRich.id }, include: { options: true, assets: true } });
    check("RICH_V1 with no assets keeps its legacy imageUrl fields untouched", legacyRow!.imageUrl === "/storage/question-images/legacy-rich.webp" && legacyRow!.options[0].imageUrl === "/storage/question-images/legacy-rich-a.webp" && liveRichViews(legacyRow!).rich!.assets.length === 0);

    console.log("\n--- Performance: 180-question paper ---");
    const sPerf = await mkStudent("F1");
    const sPlain = await mkStudent("F2");
    const t0 = performance.now();
    const perfAttempt = await startPreviousYearPaperAttempt(sPerf, fixture.perf.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
    const tStartRich = performance.now() - t0;
    const t1 = performance.now();
    const plainAttempt = await startPreviousYearPaperAttempt(sPlain, fixture.plainPerf.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
    const tStartPlain = performance.now() - t1;
    const perfQs = (await prisma.testAttempt.findUnique({ where: { id: perfAttempt.id }, include: { questions: { orderBy: { order: "asc" }, include: { answer: true } } } }))!.questions;
    const plainQs = (await prisma.testAttempt.findUnique({ where: { id: plainAttempt.id }, include: { questions: { orderBy: { order: "asc" }, include: { answer: true } } } }))!.questions;
    check("180 RICH questions frozen as v2", perfQs.length === 180 && perfQs.every((q) => (q.questionSnapshot as { v?: number }).v === 2));
    const r0 = performance.now();
    const richPayload = toPlayerQuestions(perfQs, { instantMode: false });
    const tRenderCold = performance.now() - r0;
    const r1 = performance.now();
    toPlayerQuestions(perfQs, { instantMode: false });
    const tRenderWarm = performance.now() - r1;
    const p0 = performance.now();
    const plainPayload = toPlayerQuestions(plainQs, { instantMode: false });
    const tPlain = performance.now() - p0;
    const richBytes = Buffer.byteLength(JSON.stringify(richPayload));
    const plainBytes = Buffer.byteLength(JSON.stringify(plainPayload));
    const richGz = gzipSync(JSON.stringify(richPayload)).length;
    const plainGz = gzipSync(JSON.stringify(plainPayload)).length;
    const formulaCount = perfQs.reduce((n, q) => {
      const s = q.questionSnapshot as { text: string; options: { text: string }[] };
      return n + [s.text, ...s.options.map((o) => o.text)].flatMap((t) => parseRich(t)).filter((x) => x.kind === "math").length;
    }, 0);
    console.log(
      `  INFO  start: rich ${tStartRich.toFixed(0)} ms / plain ${tStartPlain.toFixed(0)} ms; serialize+render: rich cold ${tRenderCold.toFixed(1)} ms, warm ${tRenderWarm.toFixed(1)} ms, plain ${tPlain.toFixed(1)} ms; payload JSON (${formulaCount} formulas): rich ${(richBytes / 1024).toFixed(0)} KiB (gzip ${(richGz / 1024).toFixed(0)} KiB) vs same text PLAIN ${(plainBytes / 1024).toFixed(0)} KiB (gzip ${(plainGz / 1024).toFixed(0)} KiB)`
    );
    check("180-question RICH render under 1.5 s cold", tRenderCold < 1500, tRenderCold);
    check("180-question RICH payload has no explanation / correctLabel", !JSON.stringify(richPayload).includes(SENTINEL) && !JSON.stringify(richPayload).includes("correctLabel"));
    const heap = process.memoryUsage().heapUsed / 1024 / 1024;
    console.log(`  INFO  heapUsed after perf run: ${heap.toFixed(0)} MiB`);
  } finally {
    console.log("\nCleaning up fixture data...");
    await cleanupExam(fixture.examId, students);
    await prisma.$disconnect();
  }

  console.log(failures === 0 ? "\nALL RICH-CONTENT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Browser-suite fixture (setup / cleanup)
// ---------------------------------------------------------------------------

const HTTP_PASSWORD = "RichContent!2345";

async function setup() {
  const suffix = Date.now().toString(36);
  const fixture = await seedExam(suffix);
  const students: Record<string, { id: string; email: string }> = {};
  for (const tag of ["exam", "practice", "review", "saved", "perf", "plain"]) {
    const s = await prisma.student.create({
      data: {
        studentId: await nextStudentId(),
        name: `RCV ${tag}`,
        email: `rcv-${tag}-${suffix}@example.test`,
        passwordHash: await argon2.hash(HTTP_PASSWORD),
        authProvider: StudentAuthProvider.CREDENTIALS,
      },
    });
    await prisma.studentProfile.create({ data: { studentId: s.id } });
    await ensureDefaultExamEnrollmentSafely(s.id);
    students[tag] = { id: s.id, email: s.email! };
  }
  // The Saved Questions student: a submitted attempt (answers revealable) with two saved questions.
  const saved = students.saved.id;
  const done = await startPreviousYearPaperAttempt(saved, fixture.main.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
  await submitAttempt(done.id, saved);
  await prisma.savedQuestion.createMany({ data: [fixture.main.ids.physics, fixture.main.ids.plain, fixture.main.ids.explained].map((questionId) => ({ studentId: saved, questionId })) });
  // The review student: a submitted attempt.
  const rv = await startPreviousYearPaperAttempt(students.review.id, fixture.main.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
  await submitAttempt(rv.id, students.review.id);
  // Running attempts the browser opens directly (Exam Mode, Practice Mode, 180-question RICH and PLAIN papers).
  const examRun = await startPreviousYearPaperAttempt(students.exam.id, fixture.main.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
  const practiceRun = await startPreviousYearPaperAttempt(students.practice.id, fixture.main.paperId, { answerMode: "INSTANT", durationMode: "FIXED" });
  const perfRun = await startPreviousYearPaperAttempt(students.perf.id, fixture.perf.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
  const plainRun = await startPreviousYearPaperAttempt(students.plain.id, fixture.plainPerf.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
  // Saved while the test is still running: the answer key AND the explanation must stay locked.
  await prisma.savedQuestion.create({ data: { studentId: students.exam.id, questionId: fixture.main.ids.physics } });

  console.log(
    JSON.stringify(
      {
        suffix,
        sentinel: SENTINEL,
        password: HTTP_PASSWORD,
        examId: fixture.examId,
        paperId: fixture.main.paperId,
        perfPaperId: fixture.perf.paperId,
        plainPerfPaperId: fixture.plainPerf.paperId,
        ids: fixture.main.ids,
        students,
        reviewAttemptId: rv.id,
        examAttemptId: examRun.id,
        practiceAttemptId: practiceRun.id,
        perfAttemptId: perfRun.id,
        plainAttemptId: plainRun.id,
      } satisfies Prisma.JsonObject,
      null,
      2
    )
  );
  await prisma.$disconnect();
}

async function cleanup(fixturePath: string) {
  const F = JSON.parse(readFileSync(fixturePath, "utf8"));
  const ids = Object.values(F.students as Record<string, { id: string }>).map((s) => s.id);
  await prisma.savedQuestion.deleteMany({ where: { studentId: { in: ids } } });
  await cleanupExam(F.examId, ids);
  await prisma.$disconnect();
  console.log("cleaned up");
}

const mode = process.argv[2];
const run = mode === "setup" ? setup() : mode === "cleanup" ? cleanup(process.argv[3]) : main();
run.catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
