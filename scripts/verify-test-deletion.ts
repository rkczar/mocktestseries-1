/**
 * Safe test deletion (lib/test-deletion.ts) — policy, preservation and race checks.
 *
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-test-deletion.ts
 *
 * Seeds its own exam/questions/students (prefix TDEL-), never runs against the
 * production database, and removes everything it created except the shared
 * fixture exam (kept so browser checks can reuse it).
 */
import "dotenv/config";
import { StudentAuthProvider, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  checkCustomModuleDeletion,
  checkMockTestDeletion,
  deleteCustomModuleSafely,
  deleteMockTestSafely,
} from "@/lib/test-deletion";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const min = (n: number) => new Date(Date.now() + n * 60_000);

async function main() {
  if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");
  const suffix = Date.now().toString(36);

  const exam = await prisma.exam.upsert({ where: { code: "TDEL" }, update: {}, create: { name: "TDEL Fixture Exam", code: "TDEL" } });
  const subject = await prisma.subject.upsert({ where: { nameKey: "tdel-fixture-subject" }, update: {}, create: { name: "TDEL Subject", nameKey: "tdel-fixture-subject" } });
  const bank = await Promise.all(
    [0, 1, 2].map((i) =>
      prisma.question.create({
        data: {
          code: `TDEL-${suffix}-${i}`,
          examId: exam.id,
          subjectId: subject.id,
          text: `TDEL question ${i}`,
          status: "PUBLISHED",
          options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: label, order, isCorrect: label === "A" })) },
        },
      })
    )
  );
  const bankIds = bank.map((q) => q.id);
  const student = await prisma.student.create({
    data: { studentId: `TDEL-${suffix}`, name: "TDEL Student", email: `tdel-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
  });
  const mkMock = (tag: string, extra: Partial<Prisma.MockTestUncheckedCreateInput> = {}) =>
    prisma.mockTest.create({
      data: {
        examId: exam.id,
        title: `TDEL ${tag} ${suffix}`,
        durationMinutes: 30,
        status: "DRAFT",
        ...extra,
        questions: { create: bankIds.map((questionId, order) => ({ questionId, order })) },
      },
    });
  const mkAttempt = (mockTestId: string, status: "IN_PROGRESS" | "SUBMITTED" = "SUBMITTED") =>
    prisma.testAttempt.create({
      data: {
        studentId: student.id,
        sourceType: "MOCK_TEST",
        examId: exam.id,
        mockTestId,
        durationMinutes: 30,
        totalQuestions: 3,
        status,
        score: status === "SUBMITTED" ? 4 : null,
        submittedAt: status === "SUBMITTED" ? new Date() : null,
        isLeaderboardAttempt: status === "SUBMITTED",
      },
    });
  const questionsIntact = async () => (await prisma.question.count({ where: { id: { in: bankIds } } })) === bankIds.length;
  const exists = async (id: string) => (await prisma.mockTest.count({ where: { id } })) === 1;

  const cleanupMocks: string[] = [];
  const cleanupProducts: string[] = [];
  try {
    console.log("\n--- 1-3. Unused tests are deleted; question bank untouched ---");
    const draft = await mkMock("draft");
    await prisma.testRankingConfig.create({ data: { kind: "MOCK_TEST", mockTestId: draft.id } });
    const run = await prisma.bulkImportRun.findFirst({ select: { id: true } });
    const c1 = await checkMockTestDeletion(prisma, draft.id);
    check("unused draft: check allows delete, shows 3 questions / 0 attempts / 0 enrollments", !!c1?.canDelete && c1.questions === 3 && c1.attempts === 0 && c1.enrollments === 0, c1);
    const r1 = await deleteMockTestSafely(prisma, draft.id);
    check("1. unused DRAFT test deleted", r1.ok && !(await exists(draft.id)), r1);
    check("   owned config removed (MockTestQuestion links + TestRankingConfig)", (await prisma.mockTestQuestion.count({ where: { mockTestId: draft.id } })) === 0 && (await prisma.testRankingConfig.count({ where: { mockTestId: draft.id } })) === 0);
    check("8. question-bank questions + options preserved", (await questionsIntact()) && (await prisma.questionOption.count({ where: { questionId: { in: bankIds } } })) === 12);
    void run;

    const published = await mkMock("published", { status: "PUBLISHED" });
    const r2 = await deleteMockTestSafely(prisma, published.id);
    check("2. unused PUBLISHED test deleted", r2.ok && !(await exists(published.id)), r2);

    const original = await mkMock("dup");
    const duplicate = await mkMock("dup");
    cleanupMocks.push(original.id);
    const r3 = await deleteMockTestSafely(prisma, duplicate.id);
    check("3. duplicate unused test deleted, original kept", r3.ok && !(await exists(duplicate.id)) && (await exists(original.id)), r3);

    const sched = await mkMock("upcoming-live-cbt", { status: "PUBLISHED", availableFrom: min(60), availableUntil: min(120), enrollmentEnabled: true });
    const cs = await checkMockTestDeletion(prisma, sched.id);
    check("   upcoming Live CBT with no enrollments is deletable, labelled Live CBT", !!cs?.canDelete && cs.typeLabel.startsWith("Live CBT"), cs);
    check("   ... and deletes", (await deleteMockTestSafely(prisma, sched.id)).ok);

    console.log("\n--- 4 / 9. Student attempts block deletion; results preserved ---");
    const attempted = await mkMock("attempted", { status: "PUBLISHED" });
    cleanupMocks.push(attempted.id);
    const att = await mkAttempt(attempted.id);
    const r4 = await deleteMockTestSafely(prisma, attempted.id);
    const c4 = await checkMockTestDeletion(prisma, attempted.id);
    check("4. delete refused with attempts", !r4.ok && /1 student attempt/.test(r4.ok ? "" : r4.reason), r4);
    check("   Archive offered instead", !!c4 && !c4.canDelete && c4.canArchive, c4);
    const attAfter = await prisma.testAttempt.findUnique({ where: { id: att.id } });
    check("9. student result preserved and still linked to the test", attAfter?.mockTestId === attempted.id && attAfter.score === 4 && attAfter.status === "SUBMITTED", attAfter);
    const inprog = await mkMock("in-progress", { status: "PUBLISHED" });
    cleanupMocks.push(inprog.id);
    await mkAttempt(inprog.id, "IN_PROGRESS");
    check("   an IN_PROGRESS attempt also blocks", !(await deleteMockTestSafely(prisma, inprog.id)).ok);

    console.log("\n--- 5. Live CBT enrollments block deletion ---");
    const enrolled = await mkMock("enrolled", { status: "PUBLISHED", availableFrom: min(60), availableUntil: min(120), enrollmentEnabled: true });
    cleanupMocks.push(enrolled.id);
    await prisma.mockTestEnrollment.create({ data: { mockTestId: enrolled.id, studentId: student.id } });
    const r5 = await deleteMockTestSafely(prisma, enrolled.id);
    check("5. delete refused with an enrollment", !r5.ok && /enrollment/.test(r5.ok ? "" : r5.reason) && (await exists(enrolled.id)), r5);
    check("   enrollment kept", (await prisma.mockTestEnrollment.count({ where: { mockTestId: enrolled.id } })) === 1);

    console.log("\n--- 6. Running Live CBT blocks deletion (even with no attempts) ---");
    const live = await mkMock("live-now", { status: "PUBLISHED", availableFrom: min(-10), availableUntil: min(50), enrollmentEnabled: true });
    cleanupMocks.push(live.id);
    const c6 = await checkMockTestDeletion(prisma, live.id);
    const r6 = await deleteMockTestSafely(prisma, live.id);
    check("6. delete refused while LIVE NOW", !r6.ok && /running right now/.test(r6.ok ? "" : r6.reason) && (await exists(live.id)), r6);
    check("   Archive NOT offered mid-window", !!c6 && !c6.canArchive, c6);
    const liveDraft = await mkMock("draft-in-window", { status: "DRAFT", availableFrom: min(-10), availableUntil: min(50) });
    check("   a DRAFT test inside its window is not 'running' (deletable)", (await deleteMockTestSafely(prisma, liveDraft.id)).ok);

    console.log("\n--- 7 / 10. Payment dependencies block deletion; payment records preserved ---");
    const paid = await mkMock("paid", { status: "PUBLISHED", accessType: "PAID" });
    cleanupMocks.push(paid.id);
    const product = await prisma.product.create({ data: { code: `TDEL-${suffix}`, name: "TDEL product", productType: "MOCK_TEST", mockTestId: paid.id, examId: exam.id } });
    cleanupProducts.push(product.id);
    const order = await prisma.paymentOrder.create({
      data: {
        orderNumber: `TDEL-${suffix}`,
        receipt: `TDEL-${suffix}`,
        studentId: student.id,
        productId: product.id,
        gateway: "INTERNAL",
        environment: "TEST",
        mrpPaise: 100,
        sellingPricePaise: 100,
        amountPaise: 100,
        productSnapshot: {},
        status: "PAID",
      },
    });
    const ent = await prisma.studentEntitlement.create({ data: { studentId: student.id, productId: product.id, source: "PURCHASE", startsAt: new Date(), orderId: order.id } });
    const r7 = await deleteMockTestSafely(prisma, paid.id);
    check("7. delete refused with a payment product", !r7.ok && /payment product/.test(r7.ok ? "" : r7.reason) && /1 order, 1 entitlement/.test(r7.ok ? "" : r7.reason), r7);
    const pAfter = await prisma.product.findUnique({ where: { id: product.id } });
    check("10. product still points at the test; order + entitlement intact", pAfter?.mockTestId === paid.id && (await prisma.paymentOrder.count({ where: { id: order.id } })) === 1 && (await prisma.studentEntitlement.count({ where: { id: ent.id } })) === 1);
    const unusedProductMock = await mkMock("product-no-orders");
    cleanupMocks.push(unusedProductMock.id);
    const p2 = await prisma.product.create({ data: { code: `TDEL2-${suffix}`, name: "TDEL product 2", productType: "MOCK_TEST", mockTestId: unusedProductMock.id } });
    cleanupProducts.push(p2.id);
    check("   a product with no orders still blocks (unlink it in Payments first)", !(await deleteMockTestSafely(prisma, unusedProductMock.id)).ok);

    console.log("\n--- Other references (SET NULL in the DB) block instead of being detached ---");
    const announced = await mkMock("announced");
    cleanupMocks.push(announced.id);
    const ann = await prisma.announcement.create({ data: { title: "TDEL", message: "TDEL", mockTestId: announced.id } });
    check("announcement reference blocks", !(await deleteMockTestSafely(prisma, announced.id)).ok && (await prisma.announcement.findUnique({ where: { id: ann.id } }))?.mockTestId === announced.id);
    await prisma.announcement.delete({ where: { id: ann.id } });
    const withPdf = await mkMock("pdf");
    cleanupMocks.push(withPdf.id);
    const res = await prisma.testResource.create({ data: { type: "PAPER_PDF", title: "TDEL", fileUrl: "/x.pdf", mimeType: "application/pdf", fileSizeBytes: 1, mockTestId: withPdf.id } });
    check("Paper PDF reference blocks (never becomes a global resource)", !(await deleteMockTestSafely(prisma, withPdf.id)).ok && (await prisma.testResource.findUnique({ where: { id: res.id } }))?.mockTestId === withPdf.id);
    await prisma.testResource.delete({ where: { id: res.id } });

    console.log("\n--- 12. Double-click / repeated deletion ---");
    const twice = await mkMock("twice");
    const [a, b] = await Promise.all([deleteMockTestSafely(prisma, twice.id), deleteMockTestSafely(prisma, twice.id)]);
    check("12. two concurrent deletes: exactly one succeeds, the other says already deleted", [a, b].filter((r) => r.ok).length === 1 && [a, b].some((r) => !r.ok && /no longer exists/.test(r.reason)), [a, b]);
    const again = await deleteMockTestSafely(prisma, twice.id);
    check("   a later repeat is a clean refusal, not a crash", !again.ok && /no longer exists/.test(again.reason));
    check("   question bank still intact", await questionsIntact());

    console.log("\n--- Race: attempt inserted while the delete is in flight ---");
    const racy = await mkMock("race", { status: "PUBLISHED" });
    cleanupMocks.push(racy.id);
    let insertedId = "";
    const holder = prisma.$transaction(async (tx) => {
      const t = await tx.testAttempt.create({
        data: { studentId: student.id, sourceType: "MOCK_TEST", examId: exam.id, mockTestId: racy.id, durationMinutes: 30, totalQuestions: 3 },
      });
      insertedId = t.id;
      await sleep(1500); // hold the KEY SHARE lock while the delete starts
    });
    await sleep(300);
    const t0 = Date.now();
    const rr = await deleteMockTestSafely(prisma, racy.id);
    await holder;
    check("delete waited for the in-flight attempt and then refused", !rr.ok && Date.now() - t0 > 800 && (await exists(racy.id)), { rr, waited: Date.now() - t0 });
    check("the racing attempt kept its mockTestId", (await prisma.testAttempt.findUnique({ where: { id: insertedId } }))?.mockTestId === racy.id);

    const racy2 = await mkMock("race2", { status: "PUBLISHED" });
    const del = deleteMockTestSafely(prisma, racy2.id);
    await sleep(50);
    let lateInsert = "inserted";
    try {
      await prisma.testAttempt.create({ data: { studentId: student.id, sourceType: "MOCK_TEST", examId: exam.id, mockTestId: racy2.id, durationMinutes: 30, totalQuestions: 3 } });
    } catch (e) {
      lateInsert = e instanceof Error && /Foreign key|P2003/.test(e.message) ? "fk-refused" : String(e);
    }
    const r2r = await del;
    check(
      "an attempt arriving during/after the delete is either refused (FK) or blocks the delete — never orphaned",
      (r2r.ok && lateInsert === "fk-refused") || (!r2r.ok && lateInsert === "inserted"),
      { r2r, lateInsert }
    );
    if (!r2r.ok) cleanupMocks.push(racy2.id);
    check("no orphaned TDEL attempts (mockTestId NULL)", (await prisma.testAttempt.count({ where: { studentId: student.id, mockTestId: null } })) === 0);

    console.log("\n--- Custom Modules ---");
    const cm = await prisma.customModule.create({ data: { examId: exam.id, title: `TDEL CM ${suffix}`, questions: { create: bankIds.map((questionId, order) => ({ questionId, order })) } } });
    const cc = await checkCustomModuleDeletion(prisma, cm.id);
    check("unused admin module deletable (no enrollments tile)", !!cc?.canDelete && cc.enrollments === null && cc.questions === 3, cc);
    check("unused admin module deleted, questions kept", (await deleteCustomModuleSafely(prisma, cm.id)).ok && (await questionsIntact()));
    const cmA = await prisma.customModule.create({ data: { examId: exam.id, title: `TDEL CM attempted ${suffix}` } });
    const cmAtt = await prisma.testAttempt.create({ data: { studentId: student.id, sourceType: "CUSTOM_MODULE", examId: exam.id, customModuleId: cmA.id, durationMinutes: 30, totalQuestions: 3, status: "SUBMITTED", score: 2 } });
    const rcA = await deleteCustomModuleSafely(prisma, cmA.id);
    check("module with attempts refused; attempt still linked", !rcA.ok && (await prisma.testAttempt.findUnique({ where: { id: cmAtt.id } }))?.customModuleId === cmA.id, rcA);
    const cmS = await prisma.customModule.create({ data: { examId: exam.id, title: `TDEL CM student ${suffix}`, isStudentOwned: true, createdByStudentId: student.id } });
    const rcS = await deleteCustomModuleSafely(prisma, cmS.id);
    check("student-built module refused, no Archive offered", !rcS.ok && !(await checkCustomModuleDeletion(prisma, cmS.id))!.canArchive, rcS);
    await prisma.testAttempt.delete({ where: { id: cmAtt.id } });
    await prisma.customModule.deleteMany({ where: { id: { in: [cmA.id, cmS.id] } } });
  } finally {
    await prisma.studentEntitlement.deleteMany({ where: { studentId: student.id } });
    await prisma.paymentOrder.deleteMany({ where: { studentId: student.id } });
    await prisma.product.deleteMany({ where: { id: { in: cleanupProducts } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: student.id } });
    await prisma.mockTestEnrollment.deleteMany({ where: { studentId: student.id } });
    await prisma.mockTest.deleteMany({ where: { id: { in: cleanupMocks } } });
    await prisma.mockTest.deleteMany({ where: { title: { endsWith: suffix } } });
    await prisma.student.delete({ where: { id: student.id } });
    // Keep TDEL questions: they let the browser suite build mocks quickly.
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
