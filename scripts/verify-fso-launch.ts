/**
 * Library-level verification for the multi-exam + Rajasthan FSO launch (feat/fso-multi-exam).
 * Scratch DB only (name must start with mts_fsol), seeded by critical-flows-synthetic-seed.ts +
 * fso-launch-fixture.ts + fso-setup.ts --apply. Synthetic data only. Temporary changes (FSO briefly
 * activated, test students) are undone in `finally`.
 *
 *   NODE_OPTIONS=--conditions=react-server DATABASE_URL=<mts_fsol_*> STORAGE_DIR=<scratch> npx tsx scripts/verify-fso-launch.ts
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { enrollInExam, getEnrolledExams, getScheduledMockTestsForStudent } from "@/lib/student-data";
import { ensureDefaultExamEnrollment } from "@/lib/default-enrollment";
import { evaluateCoupon, validateCouponExamScope } from "@/lib/payments/coupons";
import { getContentAccess } from "@/lib/payments/access";
import { findPracticeOmrSheet } from "@/lib/omr-sheet";
import { numberedOmrLayout, buildNumberedOmrPdf, A4, MM } from "@/lib/omr-numbered";
import { getExamFeatures, setExamFeature } from "@/lib/exam-features";
import { FSO_PAPERS } from "@/lib/fso-official";
import { keyMismatches, loadPrintedQuestions, supportedLangs } from "./build-paper-pdfs";
import { startPreviousYearPaperAttempt, saveAnswer, submitAttempt } from "@/lib/test-attempt";
import { selectPublishedQuestions } from "@/lib/question-selection";
import { formatNegativeMarking } from "@/lib/negative-marking";
import { teacherScope } from "@/lib/teacher/scope";
import { getPublicExamBySlug } from "@/lib/exam-public";
import { getEditorialPage, editorialPagePaths } from "@/lib/exam-editorial-pages";
import { stampPaperPdf } from "@/lib/paper-pdf-stamp";
import { PDFDocument } from "pdf-lib";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.startsWith("mts_fsol")) {
  console.error("Refusing: not an mts_fsol* scratch database.");
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${detail}` : ""}`);
}

const TAG = `vfl${Date.now().toString(36)}`;
const createdStudents: string[] = [];

async function newStudent(label: string) {
  const s = await prisma.student.create({ data: { name: `VFL ${label}`, email: `${TAG}-${label}@example.test`, studentId: `${TAG}-${label}`, authProvider: "CREDENTIALS" } });
  createdStudents.push(s.id);
  return s;
}

async function main() {
  const ruhs = await prisma.exam.findUniqueOrThrow({ where: { code: "CFSYN" } });
  const fso = await prisma.exam.findUniqueOrThrow({ where: { code: "RUHS-FSO" } });
  const fsoProduct = await prisma.product.findUniqueOrThrow({ where: { code: "rpsc-fso-full-access" } });
  const ruhsProduct = await prisma.product.findFirstOrThrow({ where: { examId: ruhs.id, productType: "TEST_SERIES", accessType: "PAID" } });
  const paidMock = await prisma.mockTest.findFirstOrThrow({ where: { examId: ruhs.id, accessType: "PAID", status: "PUBLISHED" } });
  const fsoPaper2022 = await prisma.previousYearPaper.findFirstOrThrow({ where: { examId: fso.id, year: 2022 } });
  const fsoActiveBefore = fso.isActive;

  try {
    // ---------------------------------------------------------------- enrollment
    const a = await newStudent("enroll");
    check("E1 inactive FSO: new student auto-enrolled into the only active exam (today's behaviour)", (await ensureDefaultExamEnrollment(a.id)).status === "ENROLLED");
    check("E2 enrollInExam refuses an inactive exam (FSO draft)", (await enrollInExam(a.id, fso.id)) === false);
    check("E3 no FSO enrollment row written", (await prisma.studentExamEnrollment.count({ where: { studentId: a.id, examId: fso.id } })) === 0);
    check("E4 switcher list = active exams only", (await getEnrolledExams(a.id)).every((e) => e.isActive));

    await prisma.exam.update({ where: { id: fso.id }, data: { isActive: true } });
    const b = await newStudent("multi");
    check("E5 two active exams: new student is NOT auto-enrolled (NEEDS_CHOICE)", (await ensureDefaultExamEnrollment(b.id)).status === "NEEDS_CHOICE");
    check("E6 …and has no enrollment row", (await prisma.studentExamEnrollment.count({ where: { studentId: b.id } })) === 0);
    const enrolledBefore = await prisma.studentExamEnrollment.count();
    check("E7 existing student keeps enrollment (ALREADY_ENROLLED, no write)", (await ensureDefaultExamEnrollment(a.id)).status === "ALREADY_ENROLLED" && (await prisma.studentExamEnrollment.count()) === enrolledBefore);
    check("E8 student can add FSO while active", (await enrollInExam(a.id, fso.id)) === true);
    const list = await getEnrolledExams(a.id);
    check("E9 oldest enrollment first → RUHS stays the default view", list[0]?.id === ruhs.id && list[1]?.id === fso.id, JSON.stringify(list.map((e) => e.code)));
    const mocksForFsoOnly = await (async () => {
      const c = await newStudent("fsoonly");
      await enrollInExam(c.id, fso.id);
      return (await getScheduledMockTestsForStudent(c.id)).all.map((r) => r.mockTest.examId);
    })();
    check("E10 FSO-only student's test-series list has no RUHS mocks", mocksForFsoOnly.every((id) => id === fso.id));
    const ruhsList = (await getScheduledMockTestsForStudent(a.id)).all.filter((r) => r.mockTest.examId === ruhs.id).length;
    check("E11 RUHS student still sees RUHS mocks", ruhsList > 0);

    // ---------------------------------------------------------------- coupons
    const now = new Date();
    const coupon = (code: string, product: typeof fsoProduct, price: number) => evaluateCoupon(prisma, { code, studentId: a.id, product, pricePaise: price, now });
    const l10ruhs = await coupon("LIMITED10", ruhsProduct, 99900);
    check("C1 LIMITED10 (All exams) still works on the RUHS product: ₹100 off", l10ruhs.ok && l10ruhs.discountPaise === 10000);
    check("C2 LIMITED10 refused on the FSO product (couponsAllowed=false)", !(await coupon("LIMITED10", fsoProduct, 20000)).ok);
    check("C3 FSOONLY refused on the RUHS product", !(await coupon("FSOONLY", ruhsProduct, 99900)).ok);
    check("C4 RUHSONLY works on RUHS", (await coupon("RUHSONLY", ruhsProduct, 99900)).ok);
    const fsoOpen = { ...fsoProduct, couponsAllowed: true };
    check("C5 RUHSONLY refused on FSO even when FSO allows coupons", !(await coupon("RUHSONLY", fsoOpen, 20000)).ok);
    check("C6 FSOONLY works on FSO when FSO allows coupons", (await coupon("FSOONLY", fsoOpen, 20000)).ok);
    check("C7 GROUP20 (RUHS product-scoped) refused on FSO", !(await coupon("GROUP20", fsoOpen, 20000)).ok);
    check("C8 scope validation: Selected with no exam rejected", validateCouponExamScope({ examScope: "SELECTED", examIds: [], products: [], series: [] }) !== null);
    check(
      "C9 scope validation: RUHS product under FSO-only scope rejected",
      validateCouponExamScope({ examScope: "SELECTED", examIds: [fso.id], products: [{ id: ruhsProduct.id, examId: ruhs.id }], series: [] }) !== null
    );
    check("C10 scope validation: All exams accepted", validateCouponExamScope({ examScope: "ALL", examIds: [], products: [], series: [] }) === null);
    check("C11 existing coupon rows unchanged (LIMITED10 still unrestricted)", (await prisma.coupon.findUniqueOrThrow({ where: { code: "LIMITED10" } })).examIds.length === 0);

    // ---------------------------------------------------------------- entitlements
    const fsoContent = { kind: "PREVIOUS_YEAR_PAPER" as const, id: fsoPaper2022.id, examId: fso.id, accessType: "PAID" as const };
    const ruhsContent = { kind: "MOCK_TEST" as const, id: paidMock.id, examId: ruhs.id, testSeriesId: paidMock.testSeriesId, accessType: "PAID" as const };
    check("P1 FSO paper locked before purchase (hidden product → not on sale, still locked)", (await getContentAccess(a.id, fsoContent)).allowed === false);
    await prisma.studentEntitlement.create({ data: { studentId: a.id, productId: ruhsProduct.id, status: "ACTIVE", source: "ADMIN_GRANT", startsAt: new Date(Date.now() - 1000) } });
    check("P2 RUHS purchase unlocks RUHS paid mock", (await getContentAccess(a.id, ruhsContent)).status === "ACTIVE_SUBSCRIPTION");
    check("P3 RUHS purchase does NOT unlock FSO", (await getContentAccess(a.id, fsoContent)).allowed === false);
    const fsoBuyer = await newStudent("fsobuyer");
    await prisma.studentEntitlement.create({ data: { studentId: fsoBuyer.id, productId: fsoProduct.id, status: "ACTIVE", source: "ADMIN_GRANT", startsAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 30 * 86400_000) } });
    check("P4 FSO purchase unlocks the FSO paper", (await getContentAccess(fsoBuyer.id, fsoContent)).status === "ACTIVE_SUBSCRIPTION");
    check("P5 FSO purchase does NOT unlock RUHS paid mock", (await getContentAccess(fsoBuyer.id, ruhsContent)).allowed === false);

    // ---------------------------------------------------------------- scoring (1/3 negative marking)
    check("S1 FSO negativeMarking stored as exactly 1/3", Math.abs((await prisma.exam.findUniqueOrThrow({ where: { id: fso.id } })).negativeMarking! - 1 / 3) < 1e-12);
    check("S2 displayed as 1/3; RUHS 0 and 0.25 print unchanged", formatNegativeMarking(1 / 3) === "1/3" && formatNegativeMarking(0) === "0" && formatNegativeMarking(0.25) === "0.25");
    await enrollInExam(fsoBuyer.id, fso.id);
    const started = (await startPreviousYearPaperAttempt(fsoBuyer.id, fsoPaper2022.id)) as { attemptId?: string; id?: string };
    const attemptId = started.attemptId ?? started.id ?? (await prisma.testAttempt.findFirstOrThrow({ where: { studentId: fsoBuyer.id }, orderBy: { startedAt: "desc" } })).id;
    const attempt = await prisma.testAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { questions: true } });
    check("S3 attempt froze negativeMarking 1/3 and 2022 duration 150 min", Math.abs(attempt.negativeMarking - 1 / 3) < 1e-12 && attempt.durationMinutes === 150, `${attempt.negativeMarking} ${attempt.durationMinutes}`);
    const facts = FSO_PAPERS[2022];
    let right = 0;
    let wrong = 0;
    for (const tq of attempt.questions) {
      const q = await prisma.question.findUniqueOrThrow({ where: { id: tq.questionId }, select: { paperQuestionNumber: true, options: { orderBy: { order: "asc" }, select: { label: true, isCorrect: true } } } });
      const n = q.paperQuestionNumber ?? 0;
      if (n < 1 || n > 30 || facts.answers[n - 1] === 0) continue;
      const correct = q.options.find((o) => o.isCorrect)!.label;
      const pick = n <= 24 ? correct : q.options.find((o) => !o.isCorrect)!.label;
      await saveAnswer(attemptId, fsoBuyer.id, tq.questionId, pick, false);
      if (n <= 24) right++;
      else wrong++;
    }
    await submitAttempt(attemptId, fsoBuyer.id);
    const done = await prisma.testAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    const expected = right - wrong / 3;
    check(`S4 score = correct − wrong/3 (${right} right, ${wrong} wrong → ${expected.toFixed(2)})`, Math.abs((done.score ?? NaN) - expected) < 1e-9, `got ${done.score}`);

    // ---------------------------------------------------------------- 7 RPSC-deleted questions: excluded, records unchanged
    const fp = async () => {
      const rows = await prisma.question.findMany({
        where: { examId: fso.id, OR: [{ previousYearPaper: { year: 2019 }, paperQuestionNumber: 71 }, { previousYearPaper: { year: 2022 }, paperQuestionNumber: { in: [16, 43, 50, 72, 106, 130] } }] },
        orderBy: { id: "asc" },
        select: { id: true, code: true, text: true, textHi: true, status: true, updatedAt: true, paperQuestionNumber: true, options: { orderBy: { id: "asc" }, select: { id: true, label: true, text: true, textHi: true, isCorrect: true, order: true } } },
      });
      return { n: rows.length, hash: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
    };
    const fpBefore = await fp();
    check("K1 fixture has the 7 deleted-key questions stored PUBLISHED", fpBefore.n === 7);
    const snaps = attempt.questions.map((q) => ({ qid: q.questionId, snap: q.questionSnapshot as { withdrawn?: boolean; correctLabel?: string } }));
    const deletedIds2022 = (await prisma.question.findMany({ where: { previousYearPaperId: fsoPaper2022.id, paperQuestionNumber: { in: facts.deleted } }, select: { id: true } })).map((q) => q.id);
    check("K2 2022 attempt: the 6 deleted questions are frozen as withdrawn (no answer key)", deletedIds2022.length === 6 && deletedIds2022.every((id) => snaps.find((x) => x.qid === id)?.snap.withdrawn === true && snaps.find((x) => x.qid === id)?.snap.correctLabel === ""));
    check("K3 2022 attempt keeps all 150 stored questions in place but scores 144", attempt.questions.length === 150 && attempt.totalQuestions === 144, `${attempt.questions.length}/${attempt.totalQuestions}`);
    const answerRows = await prisma.answer.count({ where: { attemptId, questionId: { in: deletedIds2022 } } });
    check("K4 no Answer rows for deleted questions", answerRows === 0);
    check("K5 maxScore = 144 and done.totalQuestions unchanged", done.maxScore === 144 && done.totalQuestions === 144, `${done.maxScore}`);
    const accuracy = done.correctCount != null && done.incorrectCount != null ? done.correctCount / (done.correctCount + done.incorrectCount) : null;
    check("K6 correct / incorrect / accuracy count only scored questions", done.correctCount === right && done.incorrectCount === wrong && accuracy !== null && Math.abs(accuracy - right / (right + wrong)) < 1e-9, `${done.correctCount}/${done.incorrectCount}`);
    const b2 = await newStudent("fsobuyer2");
    await prisma.studentEntitlement.create({ data: { studentId: b2.id, productId: fsoProduct.id, status: "ACTIVE", source: "ADMIN_GRANT", startsAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400_000) } });
    const a2 = (await startPreviousYearPaperAttempt(b2.id, fsoPaper2022.id)) as { id?: string; attemptId?: string };
    const a2id = a2.attemptId ?? a2.id ?? (await prisma.testAttempt.findFirstOrThrow({ where: { studentId: b2.id }, orderBy: { startedAt: "desc" } })).id;
    let refused = false;
    try {
      await saveAnswer(a2id, b2.id, deletedIds2022[0], "A", false);
    } catch {
      refused = true;
    }
    check("K7 answering a deleted question is refused", refused);
    // All 6 deleted questions "answered with the stored key A" would have scored +6 before this fix; now 0.
    await submitAttempt(a2id, b2.id);
    const d2 = await prisma.testAttempt.findUniqueOrThrow({ where: { id: a2id } });
    check("K8 a blank attempt scores 0 (deleted questions never add marks)", d2.score === 0 && d2.correctCount === 0, `${d2.score}`);
    const paper2019 = await prisma.previousYearPaper.findFirstOrThrow({ where: { examId: fso.id, year: 2019 } });
    const a3 = (await startPreviousYearPaperAttempt(b2.id, paper2019.id)) as { id?: string; attemptId?: string };
    const a3id = a3.attemptId ?? a3.id ?? (await prisma.testAttempt.findFirstOrThrow({ where: { studentId: b2.id, previousYearPaperId: paper2019.id } })).id;
    const at3 = await prisma.testAttempt.findUniqueOrThrow({ where: { id: a3id } });
    check("K9 2019 attempt: 150 shown, 149 scored (Q71 deleted)", at3.totalQuestions === 149);
    const fpAfter = await fp();
    check(`K10 the 7 question records are byte-identical before/after (${fpBefore.hash.slice(0, 12)})`, fpAfter.hash === fpBefore.hash && fpAfter.n === 7);
    const ruhsPaper = await prisma.previousYearPaper.findFirst({ where: { examId: ruhs.id, isActive: true } });
    if (ruhsPaper) {
      const ruhsPublished = await prisma.question.count({ where: { previousYearPaperId: ruhsPaper.id, status: "PUBLISHED", retiredAt: null } });
      const r = (await startPreviousYearPaperAttempt(a.id, ruhsPaper.id)) as { id?: string; attemptId?: string };
      const rid = r.attemptId ?? r.id ?? (await prisma.testAttempt.findFirstOrThrow({ where: { studentId: a.id, previousYearPaperId: ruhsPaper.id } })).id;
      const ra = await prisma.testAttempt.findUniqueOrThrow({ where: { id: rid }, include: { questions: true } });
      check("K11 RUHS-like PYQ: nothing withdrawn, every published question scored", ra.totalQuestions === ruhsPublished && ra.questions.every((q) => !(q.questionSnapshot as { withdrawn?: boolean }).withdrawn), `${ra.totalQuestions}/${ruhsPublished}`);
    } else check("K11 RUHS-like PYQ exists", false);

    // ---------------------------------------------------------------- OMR isolation + layout
    const ruhsSheet = await prisma.testResource.findFirstOrThrow({ where: { type: "OMR_TEMPLATE", examId: ruhs.id, mockTestId: null } });
    const fsoSheet = await prisma.testResource.create({
      data: { type: "OMR_TEMPLATE", title: "VFL FSO OMR", fileUrl: "/storage/test-resources/vfl-none.pdf", mimeType: "application/pdf", fileSizeBytes: 1, questionCount: 150, isActive: true, order: -100, examId: fso.id },
    });
    try {
      check("O1 FSO OMR switch defaults OFF", (await getExamFeatures(fso.id)).omrDownloadEnabled === false);
      check("O2 RUHS context never gets the FSO sheet (even with lower order)", (await findPracticeOmrSheet(ruhs.id))?.id === ruhsSheet.id);
      check("O3 no context (homepage) → default exam's sheet", (await findPracticeOmrSheet(null))?.id === ruhsSheet.id);
      check("O4 FSO context with switch OFF → not served the FSO sheet", (await findPracticeOmrSheet(fso.id))?.id !== fsoSheet.id);
      check("O5 FSO context with switch OFF → never the RUHS sheet either", (await findPracticeOmrSheet(fso.id))?.id !== ruhsSheet.id);
      await setExamFeature(fso.id, "omrDownloadEnabled", true, "verify");
      check("O6 FSO context with switch ON → FSO sheet", (await findPracticeOmrSheet(fso.id))?.id === fsoSheet.id);
      check("O7 RUHS context still RUHS sheet with FSO ON", (await findPracticeOmrSheet(ruhs.id))?.id === ruhsSheet.id);
    } finally {
      await setExamFeature(fso.id, "omrDownloadEnabled", false, "verify");
      await prisma.testResource.delete({ where: { id: fsoSheet.id } });
    }
    const layout = numberedOmrLayout();
    const labels = new Set(layout.bubbles.map((b) => b.label));
    check("O8 150 questions × 4 bubbles labelled 1–4", layout.bubbles.length === 600 && [...labels].join("") === "1234");
    check(
      "O9 every bubble inside a 36 pt safe margin (A4 + Letter)",
      layout.bubbles.every((b) => b.cx - b.r >= 36 && b.cx + b.r <= A4.width - 36 && b.cy - b.r >= 36 && b.cy + b.r <= A4.height - 36)
    );
    const overlap = layout.bubbles.some((b, i) => layout.bubbles.some((c, j) => j > i && Math.hypot(b.cx - c.cx, b.cy - c.cy) < b.r + c.r + 2));
    check("O10 no two bubbles overlap (≥2 pt gap)", !overlap);
    check("O11 calibration bar is 100 mm", Math.abs(layout.calibration.lengthPt - 100 * MM) < 1e-9);
    const omrPdf = await PDFDocument.load(await buildNumberedOmrPdf());
    const [w, h] = [omrPdf.getPage(0).getWidth(), omrPdf.getPage(0).getHeight()];
    check("O12 FSO OMR PDF is one A4 page", omrPdf.getPageCount() === 1 && Math.abs(w - A4.width) < 0.01 && Math.abs(h - A4.height) < 0.01);

    // ---------------------------------------------------------------- paper builder
    for (const year of [2019, 2022] as const) {
      const f = FSO_PAPERS[year];
      const { questions, problems } = await loadPrintedQuestions(fso.id, f);
      check(`B${year}a 150 printed questions, no problems`, questions.length === 150 && problems.length === 0, problems.join("; "));
      check(`B${year}b Hindi, English and bilingual all supported`, supportedLangs(questions).length === 3);
      const mm = keyMismatches(questions, f);
      if (year === 2019) check("B2019c every stored answer matches the RPSC key (deleted Q71 skipped)", mm.length === 0, JSON.stringify(mm));
      else check("B2022c every stored answer matches the RPSC key (6 deleted skipped; Q92 from its own 2022 record)", mm.length === 0, JSON.stringify(mm));
    }
    const fake = [{ number: 1, questionId: "x", sourceNote: "", status: "PUBLISHED", en: "E", hi: null, options: [{ en: "a", hi: null, isCorrect: true }], flags: [] }];
    const q92 = (await loadPrintedQuestions(fso.id, FSO_PAPERS[2022])).questions.find((q) => q.number === 92)!;
    const q92Row = await prisma.question.findUniqueOrThrow({ where: { id: q92.questionId }, select: { previousYearPaperId: true, excludeFromPractice: true, subjectId: true } });
    const q43Row = await prisma.question.findFirstOrThrow({ where: { previousYearPaper: { examId: fso.id, year: 2019 }, paperQuestionNumber: 43 }, select: { id: true, excludeFromPractice: true, options: { where: { isCorrect: true }, select: { label: true } } } });
    const practiceIds = (await selectPublishedQuestions({ examId: fso.id, subjectId: q92Row.subjectId, count: 500, allowFewer: true })).questions.map((q) => q.id);
    check(
      "B3 2022 Q92 is its own 2022 record (option 1 correct, excluded from practice); 2019 Q43 separate, answer 2, in practice",
      q92Row.previousYearPaperId === fsoPaper2022.id && q92.sourceNote === "2022 paper Q92" && q92.options[0].en.includes("Option 1 for 2022 Q92") && q92.options[0].isCorrect && q92Row.excludeFromPractice &&
        !practiceIds.includes(q92.questionId) && q43Row.id !== q92.questionId && !q43Row.excludeFromPractice && q43Row.options.map((o) => o.label).join() === "B" && practiceIds.includes(q43Row.id),
      `${q92.sourceNote} practice=${practiceIds.length}`
    );
    const noOrder = keyMismatches([{ ...q92, options: [q92.options[1], q92.options[0], q92.options[2], q92.options[3]] }], FSO_PAPERS[2022]);
    check("B4 without the verified order the key check would block the build", noOrder.length === 1 && noOrder[0].number === 92);
    check("B1 a question without Hindi → English only", JSON.stringify(supportedLangs(fake)) === JSON.stringify(["ENGLISH"]));
    const blank = await PDFDocument.create();
    blank.addPage([595, 842]);
    const stamped = await stampPaperPdf(await blank.save(), "98******21");
    check("B2 per-download stamp keeps page count and changes bytes", (await PDFDocument.load(stamped)).getPageCount() === 1);
    const { paperHtml, richPara } = await import("./build-paper-pdfs");
    const pic = { src: "data:image/webp;base64,", width: 300, height: 200 };
    const imgQ = fake.map((q) => ({ ...q, hi: q.hi ?? "प्रश्न", options: q.options.map((o) => ({ ...o, en: "", hi: "", images: [pic] })) }));
    check("B6 image-only options count for every language (structure diagrams)", JSON.stringify([...supportedLangs(imgQ)].sort()) === JSON.stringify(["BILINGUAL", "ENGLISH", "HINDI"]));
    const rich = richPara("B. $\\text{L}_{6}$ & <x>\nnext");
    check("B5 rich text: formula typeset by KaTeX, no raw markup, text escaped, line break kept", rich.includes("katex") && !rich.includes("$") && rich.includes("&amp; &lt;x&gt;<br>next"));
    const matchQ = [{ ...fake[0], hi: "सूची-I | सूची-II", match: { v: 1 as const, listI: [{ key: "A", text: "VflListOneA" }], listII: [{ key: "I", text: "VflListTwoI" }] } }];
    const htmlBy = Object.fromEntries((["ENGLISH", "HINDI", "BILINGUAL"] as const).map((l) => [l, paperHtml(FSO_PAPERS[2022], matchQ, l)]));
    const count = (s: string, t: string) => s.split(t).length - 1;
    check(
      "B7 match lists printed once in English and bilingual, never in the Hindi column",
      count(htmlBy.ENGLISH, "VflListOneA") === 1 && count(htmlBy.BILINGUAL, "VflListTwoI") === 1 && count(htmlBy.HINDI, "VflListOneA") === 0
    );
    check("B8 fonts embedded as data: URLs (no file:// font that a setContent page cannot load)", !htmlBy.BILINGUAL.includes("file://") && htmlBy.BILINGUAL.includes("font/ttf;base64") && htmlBy.BILINGUAL.includes("font/woff2;base64"));

    // ---------------------------------------------------------------- public pages + teacher
    await prisma.exam.update({ where: { id: fso.id }, data: { isActive: false } });
    await prisma.exam.update({ where: { id: fso.id }, data: { publicPageEnabled: true } });
    check("W1 public page of an INACTIVE exam is never served (even with page switch on)", (await getPublicExamBySlug(fso.publicSlug ?? "rajasthan-food-safety-officer")) === null);
    await prisma.exam.update({ where: { id: fso.id }, data: { publicPageEnabled: false } });
    check("W2 RUHS-like exam has no FSO-only pages", editorialPagePaths(ruhs.code).length === 0 && getEditorialPage("RUHSMO", "eligibility") === null);
    check("W3 FSO has eligibility + recruitment drafts", !!getEditorialPage("RUHS-FSO", "eligibility") && !!getEditorialPage("RUHS-FSO", "recruitment"));
    // getTeacherExamPages uses Next's unstable_cache: covered over HTTP by scripts/verify-fso-launch-http.mjs.
    const teacherRole = await prisma.role.findFirst({ where: { name: "TEACHER" } });
    if (teacherRole) {
      const t = await prisma.adminUser.create({
        data: { name: "VFL Teacher", email: `${TAG}-t@example.test`, username: `${TAG}t`, passwordHash: "x", roleId: teacherRole.id, teacherProfile: { create: { status: "ACTIVE" } } },
      });
      try {
        const asg = await prisma.teacherExamAssignment.create({ data: { teacherId: t.id, examId: fso.id } });
        check("T3 assigned exam appears in scope", (await teacherScope(t.id))?.examIds.includes(fso.id) === true);
        await prisma.teacherExamAssignment.update({ where: { id: asg.id }, data: { revokedAt: new Date() } });
        check("T4 revoked assignment disappears from scope", (await teacherScope(t.id))?.examIds.includes(fso.id) === false);
      } finally {
        await prisma.teacherExamAssignment.deleteMany({ where: { teacherId: t.id } });
        await prisma.teacherProfile.deleteMany({ where: { adminUserId: t.id } });
        await prisma.adminUser.delete({ where: { id: t.id } });
      }
    } else check("T3 TEACHER role exists on scratch", false, "seed roles first");

    check("Z1 hash helper sanity", createHash("sha256").update("x").digest("hex").length === 64);
  } finally {
    await prisma.exam.update({ where: { id: fso.id }, data: { isActive: fsoActiveBefore, publicPageEnabled: false } });
    for (const id of createdStudents) {
      await prisma.testAttempt.deleteMany({ where: { studentId: id } });
      await prisma.studentEntitlement.deleteMany({ where: { studentId: id } });
      await prisma.studentActivity.deleteMany({ where: { studentId: id } });
      await prisma.studentExamEnrollment.deleteMany({ where: { studentId: id } });
      await prisma.student.delete({ where: { id } }).catch(() => undefined);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
