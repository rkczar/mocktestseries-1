/**
 * Teacher Portal enhancements (students, results, payments, questions) — server regression.
 *
 *   DATABASE_URL=<scratch mts_*> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-teacher-portal-b.ts
 *
 * Synthetic data only (prefix TPB-). Teachers: A → exam X, B → exam Y, C → X + Y;
 * exam Z is nobody's. Checks scope (students, attempts, analytics, results,
 * orders, refunds, filters), privacy (no contact data selected), revenue
 * equal to the Admin → Payments calculations, TEST / other-exam exclusion,
 * unreleased results for staff, and "Save & next" ordering.
 */
import "dotenv/config";
import { OrderStatus, StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { teacherScope, TeacherAccessError, type TeacherScope } from "@/lib/teacher/scope";
import { studentInScope, studentScopeWhere, teacherStudentAttempts } from "@/lib/teacher/students";
import { teacherOrder, teacherPaymentFilters } from "@/lib/teacher/payments";
import { nextQuestionId, parseQuestionListFilters } from "@/lib/teacher/queries";
import { loadStudentList, parseStudentListParams } from "@/lib/admin-students-list";
import { getStudentAnalytics } from "@/lib/student-data";
import { getLiveCbtMonitor } from "@/lib/live-cbt";
import { getPaymentOverview, orderWhere, parsePaymentFilters } from "@/lib/payments/analytics";
import { createFixtureSubject, deleteFixtureTaxonomy } from "./fixture-taxonomy";

let passes = 0;
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (ok) passes++;
  else failures++;
}
const section = (t: string) => console.log(`\n== ${t}`);
async function refused(fn: () => Promise<unknown>) {
  try {
    await fn();
    return false;
  } catch (e) {
    return e instanceof TeacherAccessError;
  }
}

async function main() {
  const db = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "").split("/").pop() ?? "";
  if (!/^mts_/.test(db)) throw new Error("Refusing to run outside a scratch mts_* database.");
  const sfx = Date.now().toString(36);
  const role = (name: "TEACHER" | "MASTER_ADMIN") => prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  const exams = { X: "", Y: "", Z: "" } as Record<"X" | "Y" | "Z", string>;
  for (const k of ["X", "Y", "Z"] as const) exams[k] = (await prisma.exam.create({ data: { name: `TPB ${k} ${sfx}`, code: `TPB${k}${sfx}`.toUpperCase(), isActive: true } })).id;
  const examIds = Object.values(exams);
  const subj = await createFixtureSubject(prisma, { examId: exams.X, name: `TPB Subj ${sfx}` });
  const subjY = await createFixtureSubject(prisma, { examId: exams.Y, name: `TPB SubjY ${sfx}` });
  const students: string[] = [];
  const users: string[] = [];
  try {
    // ---- teachers
    const tRole = await role("TEACHER");
    const mkTeacher = async (tag: string, ex: string[]) => {
      const u = await prisma.adminUser.create({ data: { name: `TPB ${tag}`, username: `tpb-${tag}-${sfx}`, passwordHash: "x", roleId: tRole.id } });
      users.push(u.id);
      await prisma.teacherProfile.create({ data: { adminUserId: u.id } });
      for (const e of ex) await prisma.teacherExamAssignment.create({ data: { teacherId: u.id, examId: e } });
      return (await teacherScope(u.id)) as TeacherScope;
    };
    const A = await mkTeacher("a", [exams.X]);
    const B = await mkTeacher("b", [exams.Y]);
    const C = await mkTeacher("c", [exams.X, exams.Y]);

    // ---- students (distinctive contact values for leak checks)
    const mkStudent = async (tag: string) => {
      const s = await prisma.student.create({
        data: { studentId: `TPB${tag}-${sfx}`, name: `TPB Student ${tag}`, email: `tpb-${tag}-${sfx}@leak.test`, mobile: `9${String(Date.now()).slice(-6)}${tag.length}${students.length}`.slice(0, 10), authProvider: StudentAuthProvider.CREDENTIALS },
      });
      students.push(s.id);
      return s;
    };
    const sX = await mkStudent("x");
    const sY = await mkStudent("y");
    const sXY = await mkStudent("xy");
    const sAttX = await mkStudent("attx"); // attempted X, never enrolled
    const sBuyY = await mkStudent("buyy"); // bought Y product, never enrolled
    const sZ = await mkStudent("z");
    await prisma.studentExamEnrollment.createMany({
      data: [
        { studentId: sX.id, examId: exams.X },
        { studentId: sY.id, examId: exams.Y },
        { studentId: sXY.id, examId: exams.X },
        { studentId: sXY.id, examId: exams.Y },
        { studentId: sZ.id, examId: exams.Z },
      ],
    });

    // ---- tests + questions
    const mkQ = async (examId: string, subjectId: string, n: number) =>
      prisma.question.create({ data: { code: `TPB-${sfx}-${examId.slice(-4)}-${n}`, examId, subjectId, text: `TPB q${n}`, status: "PUBLISHED", options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: label, isCorrect: label === "A", order })) } } });
    const qX = [await mkQ(exams.X, subj.id, 1), await mkQ(exams.X, subj.id, 2), await mkQ(exams.X, subj.id, 3)];
    const qY = [await mkQ(exams.Y, subjY.id, 1)];
    const seriesX = await prisma.testSeries.create({ data: { examId: exams.X, name: `TPB Series X ${sfx}`, status: "PUBLISHED" } });
    const mockX = await prisma.mockTest.create({ data: { examId: exams.X, testSeriesId: seriesX.id, title: `TPB Mock X ${sfx}`, durationMinutes: 10, status: "PUBLISHED", questions: { create: qX.map((q, order) => ({ questionId: q.id, order })) } } });
    // Results held until a future date (unreleased to students).
    const heldX = await prisma.mockTest.create({
      data: { examId: exams.X, title: `TPB Held X ${sfx}`, durationMinutes: 10, status: "PUBLISHED", resultReleaseMode: "CUSTOM_DATE", resultReleaseAt: new Date(Date.now() + 7 * 86400_000), questions: { create: qX.map((q, order) => ({ questionId: q.id, order })) } },
    });
    const mockY = await prisma.mockTest.create({ data: { examId: exams.Y, title: `TPB Mock Y ${sfx}`, durationMinutes: 10, status: "PUBLISHED", questions: { create: [{ questionId: qY[0].id, order: 0 }] } } });
    const attempt = (studentId: string, examId: string, mockTestId: string, score: number, max: number, correct: number) =>
      prisma.testAttempt.create({
        data: { studentId, examId, mockTestId, sourceType: "MOCK_TEST", testType: "FULL_MOCK", status: "SUBMITTED", startedAt: new Date(), submittedAt: new Date(), durationMinutes: 10, totalQuestions: max, maxScore: max, score, correctCount: correct, incorrectCount: max - correct, unansweredCount: 0 },
      });
    await attempt(sX.id, exams.X, mockX.id, 3, 3, 3);
    await attempt(sXY.id, exams.X, mockX.id, 1, 3, 1);
    await attempt(sXY.id, exams.Y, mockY.id, 1, 1, 1);
    await attempt(sAttX.id, exams.X, mockX.id, 2, 3, 2);
    await attempt(sAttX.id, exams.X, mockX.id, 3, 3, 3); // second (practice) attempt
    const held = await attempt(sX.id, exams.X, heldX.id, 2, 3, 2);

    // ---- payments
    const product = async (examId: string, type: "TEST_SERIES" | "MOCK_TEST", extra: Record<string, string> = {}) =>
      prisma.product.create({ data: { code: `TPB-${type}-${examId.slice(-5)}-${sfx}`, name: `TPB ${type} ${examId.slice(-4)}`, productType: type, examId, accessType: "PAID", sellingPricePaise: 10000, mrpPaise: 20000, ...extra } });
    const pX = await product(exams.X, "TEST_SERIES", { testSeriesId: seriesX.id });
    const pY = await product(exams.Y, "TEST_SERIES");
    const pZ = await product(exams.Z, "TEST_SERIES");
    const coupon = await prisma.coupon.create({ data: { code: `TPB${sfx}`.toUpperCase(), discountType: "PERCENTAGE", discountValue: 50 } });
    let n = 0;
    const order = async (studentId: string, productId: string, status: string, amount: number, env: "LIVE" | "TEST" = "LIVE", paid = true, couponCode?: string) => {
      n++;
      const o = await prisma.paymentOrder.create({
        data: {
          orderNumber: `TPB-${sfx}-${n}`, studentId, productId, status: status as never, gateway: "RAZORPAY", environment: env, mrpPaise: 20000, sellingPricePaise: 10000, amountPaise: amount,
          couponCode: couponCode ?? null, couponId: couponCode && coupon ? coupon.id : null, couponDiscountPaise: couponCode ? 5000 : 0, saleDiscountPaise: 10000,
          productSnapshot: {}, receipt: `rcpt-${sfx}-${n}`, gatewayOrderId: `order_LEAK${sfx}${n}`, paidAt: paid ? new Date() : null,
        },
      });
      let payId: string | null = null;
      if (paid) payId = (await prisma.payment.create({ data: { orderId: o.id, studentId, gateway: "RAZORPAY", environment: env, gatewayPaymentId: `pay_LEAK${sfx}${n}`, amountPaise: amount, status: "CAPTURED", method: "upi" } })).id;
      return { o, payId };
    };
    const o1 = await order(sX.id, pX.id, "PAID", 10000, "LIVE", true, coupon?.code);
    const o2 = await order(sXY.id, pX.id, "PARTIALLY_REFUNDED", 10000);
    await prisma.refund.create({ data: { paymentId: o2.payId!, orderId: o2.o.id, amountPaise: 4000, status: "PROCESSED", gatewayRefundId: `rfnd_LEAK${sfx}`, processedAt: new Date() } });
    await order(sX.id, pX.id, "FAILED", 10000, "LIVE", false);
    await order(sX.id, pX.id, "PAYMENT_PENDING", 10000, "LIVE", false);
    const oY = await order(sBuyY.id, pY.id, "PAID", 10000);
    const oZ = await order(sZ.id, pZ.id, "PAID", 10000);
    const oTest = await order(sX.id, pX.id, "PAID", 99900, "TEST");
    // entitlements: purchase X (sX), admin grant X (sXY), trial X running (sAttX)
    const now = new Date();
    await prisma.studentEntitlement.create({ data: { studentId: sX.id, productId: pX.id, source: "PURCHASE", startsAt: new Date(now.getTime() - 1000), orderId: o1.o.id } });
    await prisma.studentEntitlement.create({ data: { studentId: sXY.id, productId: pX.id, source: "ADMIN_GRANT", startsAt: new Date(now.getTime() - 1000) } });
    await prisma.studentPremiumTrial.create({ data: { studentId: sAttX.id, examId: exams.X, startedAt: new Date(now.getTime() - 1000), endsAt: new Date(now.getTime() + 86400_000) } });

    // ================================================================
    section("Student scope");
    const scoped = async (sc: TeacherScope) => (await prisma.student.findMany({ where: { id: { in: students }, ...studentScopeWhere(sc.examIds) }, select: { id: true } })).map((s) => s.id).sort();
    check("A (X) sees enrolled, attempted-only and multi-exam students of X", JSON.stringify(await scoped(A)) === JSON.stringify([sX.id, sXY.id, sAttX.id].sort()));
    check("B (Y) sees Y students incl. a buyer without enrollment", JSON.stringify(await scoped(B)) === JSON.stringify([sY.id, sXY.id, sBuyY.id].sort()));
    check("C (X+Y) sees both, never Z", (await scoped(C)).length === 5 && !(await scoped(C)).includes(sZ.id));
    check("A cannot open a Y-only student", await refused(() => studentInScope(A, sY.id)));
    check("nobody opens the Z student", (await refused(() => studentInScope(A, sZ.id))) && (await refused(() => studentInScope(C, sZ.id))));
    const listA = await loadStudentList({ ...parseStudentListParams({ q: "TPB Student" }), perPage: 200 }, new Date(), { where: studentScopeWhere(A.examIds), privacy: true });
    check("list (scoped) has exactly A's students", listA.rows.length === 3 && listA.total === (await prisma.student.count({ where: { status: { not: "DELETED" }, ...studentScopeWhere(A.examIds) } })));
    check("privacy: email / mobile never selected, no access label", listA.rows.every((r) => r.email === undefined && r.mobile === undefined && r.access === null));
    const byEmail = await loadStudentList({ ...parseStudentListParams({ q: `tpb-x-${sfx}@leak.test` }) }, new Date(), { where: studentScopeWhere(A.examIds), privacy: true });
    check("privacy: searching by email finds nothing (no probing)", byEmail.rows.length === 0);
    const byCode = await loadStudentList({ ...parseStudentListParams({ q: `TPBx-${sfx}` }) }, new Date(), { where: studentScopeWhere(A.examIds), privacy: true });
    check("search by student code works", byCode.rows.some((r) => r.id === sX.id));
    const adminList = await loadStudentList({ ...parseStudentListParams({ q: `tpb-x-${sfx}@leak.test` }) });
    check("admin list unchanged: email search + contact + access label", adminList.rows.some((r) => r.id === sX.id && r.email && r.access));

    section("Attempts, analytics, unreleased results");
    const attA = await teacherStudentAttempts(A, sXY.id);
    const attC = await teacherStudentAttempts(C, sXY.id);
    check("test history for A shows only exam X attempts", attA.length === 1 && attA.every((a) => a.examId === exams.X));
    check("C sees both exams' attempts", attC.length === 2);
    const anA = await getStudentAnalytics(sXY.id, { examIds: A.examIds, includeUnreleased: true });
    check("analytics scoped: exam performance only X", anA.examPerformance.length === 1 && anA.examPerformance[0].examId === exams.X);
    const stu = await getStudentAnalytics(sX.id);
    const staff = await getStudentAnalytics(sX.id, { examIds: A.examIds, includeUnreleased: true });
    const subX = (x: typeof stu) => x.examPerformance.find((e) => e.examId === exams.X)?.attempts ?? 0;
    check("student-facing analytics still hide the unreleased result", subX(stu) === 1);
    check("staff analytics include the unreleased result (owner decision)", subX(staff) === 2);
    const mon = await getLiveCbtMonitor(heldX.id, new Date(), { includeContact: false });
    check("results monitor: unreleased attempt has its score; contact never read", mon.rows.some((r) => r.attemptId === held.id && r.score === 2) && mon.rows.every((r) => r.contact === null));
    const monAdmin = await getLiveCbtMonitor(mockX.id, new Date());
    check("admin monitor unchanged (contact present)", monAdmin.rows.some((r) => r.contact?.includes("@leak.test")));
    const monX = await getLiveCbtMonitor(mockX.id, new Date(), { includeContact: false });
    check("per-test: one official row per student, later attempts counted", monX.rows.length === 3 && monX.rows.find((r) => r.studentDbId === sAttX.id)?.laterAttempts === 1);

    section("Payments: scope, filters, totals = Admin");
    const fA = (await teacherPaymentFilters(A, {})).filters;
    const sumA = await getPaymentOverview(fA); // the Admin OverviewPanel calculation, with the teacher's forced scope
    const adminX = await getPaymentOverview({ ...parsePaymentFilters({}), examId: exams.X });
    check("A's totals equal Admin → Payments filtered to exam X", sumA.grossPaise === adminX.grossPaise && sumA.refundedPaise === adminX.refundedPaise && sumA.netPaise === adminX.netPaise && sumA.paidOrders === adminX.paidOrders, [sumA.grossPaise, adminX.grossPaise]);
    check("A: gross 200.00, refund 40.00, net 160.00 (TEST and other exams excluded)", sumA.grossPaise === 20000 && sumA.refundedPaise === 4000 && sumA.netPaise === 16000);
    const byStatus = async (status: OrderStatus) => prisma.paymentOrder.count({ where: orderWhere({ ...fA, status }) });
    check("A: transactions filter = 2 paid-like + 1 failed + 1 pending (Admin status filter)", (await byStatus(OrderStatus.PAID)) + (await byStatus(OrderStatus.PARTIALLY_REFUNDED)) === 2 && (await byStatus(OrderStatus.FAILED)) === 1 && sumA.pendingOrders === 1, sumA);
    const sumC = await getPaymentOverview((await teacherPaymentFilters(C, {})).filters);
    check("C = X + Y", sumC.grossPaise === 30000);
    const sumB = await getPaymentOverview((await teacherPaymentFilters(B, {})).filters);
    check("B sees only Y", sumB.grossPaise === 10000 && (await prisma.paymentOrder.count({ where: orderWhere((await teacherPaymentFilters(B, {})).filters) })) === 1);
    const ordersA = await prisma.paymentOrder.findMany({ where: orderWhere(fA), select: { id: true } });
    check("A's order list never contains Y, Z or TEST orders", !ordersA.some((o) => [oY.o.id, oZ.o.id, oTest.o.id].includes(o.id)) && ordersA.length === 4);
    const fA2 = (await teacherPaymentFilters(A, { exam: exams.Y, product: pZ.id, env: "TEST" })).filters;
    check("URL filters intersected: other exam / product / TEST dropped", fA2.examId === null && fA2.productId === null && fA2.environment === "LIVE");
    const studentSearch = await prisma.paymentOrder.count({ where: orderWhere({ ...fA, student: `tpb-x-${sfx}@leak.test` }) });
    check("transaction student search ignores email (no probing)", studentSearch === 0);
    check("A opens an X transaction", (await teacherOrder(A, o2.o.id)).order.refunds.length === 1);
    check("A cannot open Y / Z / TEST transactions (404)", (await refused(() => teacherOrder(A, oY.o.id))) && (await refused(() => teacherOrder(A, oZ.o.id))) && (await refused(() => teacherOrder(A, oTest.o.id))));
    const opts = (await teacherPaymentFilters(A, {})).options;
    check("filter options: own exams / products / used coupons only", opts.exams.length === 1 && opts.products.every((p) => p.id === pX.id) && opts.coupons.every((c) => c.id === coupon?.id));

    section("Revoked assignment = immediate loss");
    await prisma.teacherExamAssignment.updateMany({ where: { teacherId: users[2], examId: exams.Y }, data: { revokedAt: new Date() } });
    const C2 = (await teacherScope(users[2])) as TeacherScope;
    check("after revoking Y, C loses Y students and transactions", (await refused(() => studentInScope(C2, sY.id))) && (await refused(() => teacherOrder(C2, oY.o.id))));

    section("Questions: Save & next ordering");
    const f = parseQuestionListFilters(new URLSearchParams(`exam=${exams.X}`));
    const order1 = await nextQuestionId(A, f, qX[2].id);
    const order2 = order1 ? await nextQuestionId(A, f, order1) : null;
    check("next follows the list order (newest first)", order1 === qX[1].id && order2 === qX[0].id, [order1, order2]);
    check("last question has no next", (await nextQuestionId(A, f, qX[0].id)) === null);
    await prisma.question.update({ where: { id: qX[1].id }, data: { text: "edited" } });
    check("saving a question does not change its position", (await nextQuestionId(A, f, qX[2].id)) === qX[1].id);
    check("other exam's question id gives no next (scope)", (await nextQuestionId(A, f, qY[0].id)) === null);
  } finally {
    await prisma.studentPremiumTrial.deleteMany({ where: { studentId: { in: students } } });
    await prisma.studentEntitlement.deleteMany({ where: { studentId: { in: students } } });
    await prisma.refund.deleteMany({ where: { order: { studentId: { in: students } } } });
    await prisma.payment.deleteMany({ where: { studentId: { in: students } } });
    await prisma.paymentOrder.deleteMany({ where: { studentId: { in: students } } });
    await prisma.product.deleteMany({ where: { examId: { in: examIds } } });
    await prisma.coupon.deleteMany({ where: { code: `TPB${sfx}`.toUpperCase() } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: students } } });
    await prisma.mockTest.deleteMany({ where: { examId: { in: examIds } } });
    await prisma.testSeries.deleteMany({ where: { examId: { in: examIds } } });
    await prisma.question.deleteMany({ where: { examId: { in: examIds } } });
    await prisma.student.deleteMany({ where: { id: { in: students } } });
    await prisma.teacherExamAssignment.deleteMany({ where: { teacherId: { in: users } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: users } } });
    await deleteFixtureTaxonomy(prisma, examIds);
    await prisma.exam.deleteMany({ where: { id: { in: examIds } } });
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
