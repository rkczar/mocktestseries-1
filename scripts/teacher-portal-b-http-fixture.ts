/**
 * Synthetic fixture for scripts/verify-teacher-portal-b-http.mjs (Teacher Portal enhancements).
 *   DATABASE_URL=<scratch mts_*> NODE_OPTIONS=--conditions=react-server npx tsx scripts/teacher-portal-b-http-fixture.ts > /tmp/tpb.json
 * Exams X, Y, Z; teachers A (X), B (Y), C (X + Y); a MASTER_ADMIN. Students with
 * distinctive contact values and orders with distinctive gateway ids, so the
 * browser suite can prove none of them ever reach a Teacher Portal page.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createFixtureSubject } from "./fixture-taxonomy";

async function main() {
  const db = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "").split("/").pop() ?? "";
  if (!/^mts_/.test(db)) throw new Error("Refusing to run outside a scratch mts_* database.");
  const sfx = Date.now().toString(36);
  const role = (name: "TEACHER" | "MASTER_ADMIN") => prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  const ex: Record<string, string> = {};
  for (const k of ["X", "Y", "Z"]) ex[k] = (await prisma.exam.create({ data: { name: `TPH ${k} ${sfx}`, code: `TPH${k}${sfx}`.toUpperCase(), isActive: true } })).id;
  const subjX = await createFixtureSubject(prisma, { examId: ex.X, name: `TPH SubjX ${sfx}` });
  const subjY = await createFixtureSubject(prisma, { examId: ex.Y, name: `TPH SubjY ${sfx}` });
  const accounts: Record<string, { username: string; password: string; id: string }> = {};
  const mkUser = async (key: string, r: "TEACHER" | "MASTER_ADMIN", exams: string[] = []) => {
    const password = randomBytes(12).toString("base64url");
    const u = await prisma.adminUser.create({ data: { name: `TPH ${key}`, username: `tph-${key}-${sfx}`, passwordHash: await argon2.hash(password), roleId: (await role(r)).id } });
    if (r === "TEACHER") {
      await prisma.teacherProfile.create({ data: { adminUserId: u.id } });
      for (const e of exams) await prisma.teacherExamAssignment.create({ data: { teacherId: u.id, examId: e } });
    }
    accounts[key] = { username: u.username, password, id: u.id };
  };
  await mkUser("a", "TEACHER", [ex.X]);
  await mkUser("b", "TEACHER", [ex.Y]);
  await mkUser("c", "TEACHER", [ex.X, ex.Y]);
  await mkUser("master", "MASTER_ADMIN");

  const leaks: string[] = [];
  let sn = 0;
  const mkStudent = async (tag: string, examIds: string[]) => {
    sn++;
    const email = `tph-${tag}-${sfx}@leak.test`;
    const mobile = `98${String(Date.now() + sn).slice(-8)}`;
    leaks.push(email, mobile);
    const s = await prisma.student.create({ data: { studentId: `TPH${tag}-${sfx}`.toUpperCase(), name: `TPH Student ${tag}`, email, mobile, authProvider: StudentAuthProvider.CREDENTIALS } });
    for (const e of examIds) await prisma.studentExamEnrollment.create({ data: { studentId: s.id, examId: e } });
    return s;
  };
  const sX = await mkStudent("x", [ex.X]);
  const sX2 = await mkStudent("x2", [ex.X]);
  const sY = await mkStudent("y", [ex.Y]);
  const sZ = await mkStudent("z", [ex.Z]);

  const mkQ = (examId: string, subjectId: string, n: number) =>
    prisma.question.create({
      data: { code: `TPH-${sfx}-${examId === ex.X ? "X" : "Y"}${n}`, examId, subjectId, text: `TPH full question text number ${n} ${"long ".repeat(40)}end-of-text-${n}`, explanation: `TPH explanation ${n}`, status: n === 4 ? "DRAFT" : "PUBLISHED", options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: `TPH option ${label}${n}`, isCorrect: label === "B", order })) } },
    });
  const qX = [];
  for (let i = 1; i <= 4; i++) qX.push(await mkQ(ex.X, subjX.id, i));
  const qY = [await mkQ(ex.Y, subjY.id, 1)];
  const seriesX = await prisma.testSeries.create({ data: { examId: ex.X, name: `TPH Series X ${sfx}`, status: "PUBLISHED" } });
  const mockX = await prisma.mockTest.create({ data: { examId: ex.X, testSeriesId: seriesX.id, title: `TPH Mock X ${sfx}`, durationMinutes: 10, status: "PUBLISHED", questions: { create: qX.slice(0, 3).map((q, order) => ({ questionId: q.id, order })) } } });
  const heldX = await prisma.mockTest.create({
    data: { examId: ex.X, title: `TPH Held X ${sfx}`, durationMinutes: 10, status: "PUBLISHED", resultReleaseMode: "CUSTOM_DATE", resultReleaseAt: new Date(Date.now() + 7 * 86400_000), questions: { create: qX.slice(0, 3).map((q, order) => ({ questionId: q.id, order })) } },
  });
  const mockY = await prisma.mockTest.create({ data: { examId: ex.Y, title: `TPH Mock Y ${sfx}`, durationMinutes: 10, status: "PUBLISHED", questions: { create: [{ questionId: qY[0].id, order: 0 }] } } });
  const attempt = (studentId: string, examId: string, mockTestId: string, score: number) =>
    prisma.testAttempt.create({
      data: { studentId, examId, mockTestId, sourceType: "MOCK_TEST", testType: "FULL_MOCK", status: "SUBMITTED", startedAt: new Date(), submittedAt: new Date(), durationMinutes: 10, totalQuestions: 3, maxScore: 3, score, correctCount: score, incorrectCount: 3 - score, unansweredCount: 0 },
    });
  await attempt(sX.id, ex.X, mockX.id, 3);
  await attempt(sX2.id, ex.X, mockX.id, 1);
  await attempt(sX.id, ex.X, heldX.id, 2);
  await attempt(sY.id, ex.Y, mockY.id, 1);

  const product = (examId: string, name: string) => prisma.product.create({ data: { code: `TPH-${name}-${sfx}`, name: `TPH ${name}`, productType: "TEST_SERIES", examId, accessType: "PAID", mrpPaise: 20000, sellingPricePaise: 10000 } });
  const pX = await product(ex.X, "SeriesX");
  const pY = await product(ex.Y, "SeriesY");
  const pZ = await product(ex.Z, "SeriesZ");
  const coupon = await prisma.coupon.create({ data: { code: `TPHC${sfx}`.toUpperCase(), discountType: "PERCENTAGE", discountValue: 50 } });
  let n = 0;
  const orders: Record<string, { id: string; orderNumber: string }> = {};
  const order = async (key: string, studentId: string, productId: string, status: string, env: "LIVE" | "TEST" = "LIVE", paid = true, withCoupon = false) => {
    n++;
    const gatewayOrderId = `order_LEAK${sfx}${n}`;
    const gatewayPaymentId = `pay_LEAK${sfx}${n}`;
    leaks.push(gatewayOrderId, gatewayPaymentId);
    const o = await prisma.paymentOrder.create({
      data: {
        orderNumber: `TPH-ORD-${sfx}-${n}`, studentId, productId, status: status as never, gateway: "RAZORPAY", environment: env, mrpPaise: 20000, sellingPricePaise: 10000, saleDiscountPaise: 10000,
        couponCode: withCoupon ? coupon.code : null, couponId: withCoupon ? coupon.id : null, couponDiscountPaise: withCoupon ? 5000 : 0, amountPaise: withCoupon ? 5000 : 10000,
        productSnapshot: {}, receipt: `rcpt-${sfx}-${n}`, gatewayOrderId, paidAt: paid ? new Date() : null,
      },
    });
    if (paid) {
      const p = await prisma.payment.create({ data: { orderId: o.id, studentId, gateway: "RAZORPAY", environment: env, gatewayPaymentId, amountPaise: o.amountPaise, status: status === "PARTIALLY_REFUNDED" ? "PARTIALLY_REFUNDED" : "CAPTURED", method: "upi", refundedPaise: status === "PARTIALLY_REFUNDED" ? 2000 : 0 } });
      if (status === "PARTIALLY_REFUNDED") {
        const rf = `rfnd_LEAK${sfx}${n}`;
        leaks.push(rf);
        await prisma.refund.create({ data: { paymentId: p.id, orderId: o.id, amountPaise: 2000, status: "PROCESSED", gatewayRefundId: rf, reason: "TPH partial refund", processedAt: new Date() } });
      }
      await prisma.paymentWebhookEvent.create({ data: { provider: "RAZORPAY", eventId: `evt_LEAK${sfx}${n}`, eventType: "payment.captured", status: "PROCESSED", orderId: o.id, summary: { secret: `whsum_LEAK${sfx}${n}` } } });
      leaks.push(`evt_LEAK${sfx}${n}`, `whsum_LEAK${sfx}${n}`);
    }
    orders[key] = { id: o.id, orderNumber: o.orderNumber };
  };
  await order("x1", sX.id, pX.id, "PAID", "LIVE", true, true);
  await order("x2", sX2.id, pX.id, "PARTIALLY_REFUNDED");
  await order("x3", sX.id, pX.id, "FAILED", "LIVE", false);
  await order("y1", sY.id, pY.id, "PAID");
  await order("z1", sZ.id, pZ.id, "PAID");
  await order("xtest", sX.id, pX.id, "PAID", "TEST");

  console.log(
    JSON.stringify(
      {
        sfx,
        exams: ex,
        accounts,
        students: { x: sX.id, x2: sX2.id, y: sY.id, z: sZ.id },
        studentNames: { y: sY.name, z: sZ.name },
        questions: { x: qX.map((q) => q.id), y: qY.map((q) => q.id) },
        mocks: { x: mockX.id, held: heldX.id, y: mockY.id },
        orders,
        coupon: coupon.code,
        leaks,
      },
      null,
      1
    )
  );
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
