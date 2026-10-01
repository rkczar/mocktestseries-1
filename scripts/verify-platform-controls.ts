/**
 * PLATFORM CONTROLS — regression guard (Admin → System → Platform Controls).
 *
 * Drives the real code (lib/platform-controls*.ts and every enforcement
 * point it gates) against fixtures it creates and deletes itself:
 *   defaults + tolerant parsing, effective-state semantics (lockdown,
 *   maintenance, expiry, restore of individual settings), the admin write
 *   path (reasons, secrets, AuditLog, concurrent writers), the MASTER /
 *   FULL_ADMIN permission matrix, registration (password, OTP, Google),
 *   new payments vs. an in-flight order's fulfilment and existing paid
 *   access, new test starts vs. an in-progress attempt's save/submit, AI
 *   generation vs. cached explanations, cross-process propagation and the
 *   last-known-state fallback. Password/OTP sign-in and registration
 *   (NextAuth providers + login Server Actions) need a real request
 *   context, so they are checked over HTTP against a scratch server.
 *
 * It never contacts Razorpay or an AI provider. Run from the repo root
 * against a DISPOSABLE database (never production):
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx scripts/verify-platform-controls.ts
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import {
  AiGenerationStatus,
  AttemptAnswerMode,
  AttemptDurationMode,
  OrderStatus,
  QuestionDifficulty,
  QuestionStatus,
  StudentAuthProvider,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  PLATFORM_CONTROLS_KEY,
  DEFAULT_PUBLIC_MESSAGES,
  bumpPlatformControlsCache,
  defaultPlatformControls,
  effectivePlatformControls,
  getEffectivePlatformControls,
  getPlatformControls,
  parsePlatformControls,
  PlatformPausedError,
} from "@/lib/platform-controls";
import { applyPlatformControlChange, PlatformControlValidationError, type PlatformControlChange } from "@/lib/platform-controls-admin";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";
import { resolveGoogleStudent } from "@/lib/student-lifecycle";
import { CheckoutError, createCheckoutOrder, recordTrustedPayment } from "@/lib/payments/orders";
import { evaluateContentAccess, loadAccessContext } from "@/lib/payments/access";
import { getPaymentMode } from "@/lib/payments/settings";
import { saveAnswer, startCustomModuleAttempt, startMockTestAttempt, submitAttempt } from "@/lib/test-attempt";
import { getOrCreateExplanation } from "@/lib/ai-explanation";
import { AiNotConfiguredError, generateWithAi } from "@/lib/ai-provider";
import { createFixtureSubject, createFixtureTopic, deleteFixtureTaxonomy } from "./fixture-taxonomy";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") && process.env.ALLOW_PRODUCTION_DB !== "1") {
  console.error("Refusing to run against what looks like the production database. Point DATABASE_URL at a disposable copy.");
  process.exit(2);
}

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}
async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
const code = (e: unknown) => (e instanceof CheckoutError ? e.code : e instanceof PlatformPausedError ? `PAUSED:${e.control}` : e instanceof Error ? `${e.constructor.name}:${e.message}` : e);

async function main() {
  const suffix = Date.now().toString(36);
  const created = { students: [] as string[], admins: [] as string[] };

  // Clean starting state for this run.
  await prisma.setting.deleteMany({ where: { key: PLATFORM_CONTROLS_KEY } });
  await prisma.setting.upsert({ where: { key: "payments.mode" }, update: { value: { mode: "PAID" } }, create: { key: "payments.mode", value: { mode: "PAID" } } });
  bumpPlatformControlsCache();

  const role = await prisma.role.upsert({ where: { name: "MASTER_ADMIN" }, update: {}, create: { name: "MASTER_ADMIN" } });
  const admin = await prisma.adminUser.create({ data: { name: "PC Master", username: `pc-master-${suffix}`, passwordHash: "x", roleId: role.id } });
  created.admins.push(admin.id);
  const actor = { id: admin.id, name: admin.name };
  const change = (c: PlatformControlChange) => applyPlatformControlChange(c, actor);

  const exam = await prisma.exam.create({ data: { name: `PC Exam ${suffix}`, code: `PC-${suffix}`, isActive: true } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: "PC Subject" });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: "PC Topic" });
  const questions: { id: string }[] = [];
  for (let n = 1; n <= 3; n++) {
    questions.push(
      await prisma.question.create({
        data: {
          examId: exam.id,
          subjectId: subject.id,
          topicId: topic.id,
          code: `PC-${suffix}-${n}`,
          text: `Platform controls question ${n}?`,
          status: QuestionStatus.PUBLISHED,
          difficulty: QuestionDifficulty.MEDIUM,
          options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: label.toLowerCase(), isCorrect: label === "B", order })) },
        },
      })
    );
  }
  const mkStudent = async (tag: string, extra: { email?: string } = {}) => {
    const s = await prisma.student.create({
      data: { studentId: `PC${tag}-${suffix}`.toUpperCase(), name: `PC ${tag}`, email: extra.email ?? `pc-${tag}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    created.students.push(s.id);
    return s;
  };
  const mkModule = (studentId: string) =>
    prisma.customModule.create({
      data: {
        examId: exam.id,
        title: "PC Module",
        selectionMode: "RULE_BASED",
        status: "ACTIVE",
        accessType: "FREE",
        isStudentOwned: true,
        createdByStudentId: studentId,
        durationMode: AttemptDurationMode.UNLIMITED,
        answerMode: AttemptAnswerMode.EXAM,
        questions: { create: questions.map((q, order) => ({ questionId: q.id, order })) },
      },
    });
  const mock = await prisma.mockTest.create({
    data: { examId: exam.id, title: `PC Paid Mock ${suffix}`, durationMinutes: 30, status: "PUBLISHED", questions: { create: questions.map((q, order) => ({ questionId: q.id, order })) } },
  });
  const product = await prisma.product.create({
    data: { code: `PC-${suffix}`, name: "PC Paid Mock", productType: "MOCK_TEST", mockTestId: mock.id, examId: exam.id, accessType: "PAID", mrpPaise: 9900, sellingPricePaise: 9900, accessDurationType: "LIFETIME" },
  });
  // Same target but not purchasable: lets the "payments OPEN" case prove the
  // pause gate passed without ever reaching the gateway.
  const unbuyable = await prisma.product.create({
    data: { code: `PC-NB-${suffix}`, name: "PC Unbuyable", productType: "MOCK_TEST", mockTestId: mock.id, examId: exam.id, accessType: "PAID", mrpPaise: 9900, sellingPricePaise: 9900, purchaseEnabled: false },
  });

  try {
    // -----------------------------------------------------------------------
    console.log("\n--- Defaults (never locks the site) ---");
    const fresh = await getPlatformControls();
    const effFresh = effectivePlatformControls(fresh);
    check("no stored document = defaults", JSON.stringify(fresh) === JSON.stringify(defaultPlatformControls()));
    check(
      "defaults: every control effectively OPEN, maintenance + lockdown OFF, status LIVE",
      effFresh.registrationsOpen && effFresh.loginOpen && effFresh.paymentsOpen && effFresh.testsOpen && effFresh.aiOpen && !effFresh.maintenanceOn && !effFresh.lockdownActive && effFresh.status === "LIVE",
      effFresh
    );
    check("parse: malformed/garbage document falls back to defaults", JSON.stringify(parsePlatformControls("garbage")) === JSON.stringify(defaultPlatformControls()));
    check("parse: string 'false' is never coerced to a pause", parsePlatformControls({ payments: { open: "false" } }).payments.open === true);
    check("parse: lockdown 'on' must be boolean true", parsePlatformControls({ lockdown: { on: "true" } }).lockdown.on === false);

    // -----------------------------------------------------------------------
    console.log("\n--- Effective-state semantics (pure) ---");
    const s = defaultPlatformControls();
    s.payments.open = false;
    let e = effectivePlatformControls(s);
    check("payments paused → only payments closed, status DEGRADED", !e.paymentsOpen && e.registrationsOpen && e.loginOpen && e.testsOpen && e.aiOpen && e.status === "DEGRADED");
    s.login.open = false;
    e = effectivePlatformControls(s);
    check("login paused → registrations effectively closed too", !e.loginOpen && !e.registrationsOpen);
    s.login.open = true;
    s.lockdown = { ...s.lockdown, on: true, until: null };
    e = effectivePlatformControls(s);
    check("lockdown → all five effectively paused, status LOCKDOWN", !e.registrationsOpen && !e.loginOpen && !e.paymentsOpen && !e.testsOpen && !e.aiOpen && e.status === "LOCKDOWN");
    s.lockdown = { ...s.lockdown, on: false };
    e = effectivePlatformControls(s);
    check("lockdown off → individual settings return (payments still paused, rest open)", !e.paymentsOpen && e.loginOpen && e.registrationsOpen && e.testsOpen && e.aiOpen);
    const exp = defaultPlatformControls();
    exp.lockdown = { ...exp.lockdown, on: true, until: new Date(Date.now() + 60_000).toISOString() };
    check("timed lockdown active before `until`", effectivePlatformControls(exp).lockdownActive);
    const later = effectivePlatformControls(exp, new Date(Date.now() + 120_000));
    check("timed lockdown expires by itself after `until`", !later.lockdownActive && later.lockdownExpired && later.paymentsOpen && later.status === "LIVE");
    const mt = defaultPlatformControls();
    mt.maintenance.on = true;
    e = effectivePlatformControls(mt);
    check("maintenance → all five effectively paused, status MAINTENANCE", !e.registrationsOpen && !e.loginOpen && !e.paymentsOpen && !e.testsOpen && !e.aiOpen && e.status === "MAINTENANCE");

    // -----------------------------------------------------------------------
    console.log("\n--- Admin write path: validation, audit, permissions ---");
    check("pause payments without a reason → rejected", (await thrown(() => change({ control: "payments", open: false }))) instanceof PlatformControlValidationError);
    check("maintenance ON without a reason → rejected", (await thrown(() => change({ control: "maintenance", on: true }))) instanceof PlatformControlValidationError);
    check("lockdown ON without a reason → rejected", (await thrown(() => change({ control: "lockdown", on: true }))) instanceof PlatformControlValidationError);
    check(
      "reason containing a key → rejected",
      (await thrown(() => change({ control: "payments", open: false, reason: "rotate rzp_live_ABCDEFGH1234" }))) instanceof PlatformControlValidationError
    );
    check("nothing was written by the rejected changes", (await prisma.setting.findUnique({ where: { key: PLATFORM_CONTROLS_KEY } })) === null);
    const auditBefore = await prisma.auditLog.count({ where: { entityType: "PlatformControl" } });
    await change({ control: "tests", open: false, reason: "pc verify" });
    await change({ control: "tests", open: true });
    const audits = await prisma.auditLog.findMany({ where: { entityType: "PlatformControl" }, orderBy: { createdAt: "desc" }, take: 2 });
    check("every change writes one AuditLog row", (await prisma.auditLog.count({ where: { entityType: "PlatformControl" } })) === auditBefore + 2);
    const pauseAudit = audits.find((a) => (a.metadata as { reason?: string }).reason === "pc verify");
    const pm = pauseAudit?.metadata as { previous?: { open?: boolean }; next?: { open?: boolean }; control?: string } | undefined;
    check(
      "audit row: actor, action, control, previous → next, reason",
      !!pauseAudit && pauseAudit.actorId === admin.id && pauseAudit.action === "PLATFORM_CONTROL_CHANGED" && pauseAudit.entityId === "tests" && pm?.previous?.open === true && pm?.next?.open === false,
      pauseAudit
    );
    const cfgAfterResume = await getPlatformControls();
    check("last-changed metadata stored (time + admin)", cfgAfterResume.tests.updatedBy === admin.id && cfgAfterResume.tests.updatedByName === "PC Master" && !!cfgAfterResume.tests.updatedAt);
    check("MASTER_ADMIN holds PLATFORM_CONTROLS_MANAGE", DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.PLATFORM_CONTROLS_MANAGE));
    check(
      "FULL_ADMIN holds VIEW but NOT MANAGE (read-only)",
      DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.PLATFORM_CONTROLS_VIEW) && !DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.PLATFORM_CONTROLS_MANAGE)
    );
    check("TEACHER holds neither", !DEFAULT_ROLE_PERMISSIONS.TEACHER.some((p) => p.startsWith("platform-controls")));
    await Promise.all([change({ control: "ai", open: false }), change({ control: "registrations", open: false })]);
    const both = await getPlatformControls();
    check("two concurrent writers to different controls both persist (advisory lock)", !both.ai.open && !both.registrations.open, { ai: both.ai.open, reg: both.registrations.open });
    await Promise.all([change({ control: "ai", open: true }), change({ control: "registrations", open: true })]);

    // -----------------------------------------------------------------------
    console.log("\n--- Registrations ---");
    const existingGoogle = await mkStudent("google", { email: `pc-google-${suffix}@example.test` });
    await change({ control: "registrations", open: false });
    const newEmail = `pc-new-${suffix}@example.test`;
    const regErr = await thrown(() => resolveGoogleStudent({ providerAccountId: `g-new-${suffix}`, email: newEmail, name: "New", picture: null }));
    check("Google: brand-new student refused while paused", regErr instanceof PlatformPausedError && regErr.control === "registrations", code(regErr));
    check("Google: no student row created", (await prisma.student.count({ where: { email: newEmail } })) === 0);
    const resolved = await resolveGoogleStudent({ providerAccountId: `g-exist-${suffix}`, email: existingGoogle.email ?? undefined, name: "x", picture: null });
    check("Google: EXISTING student still resolves (login allowed)", resolved?.student.id === existingGoogle.id && resolved.created === false);
    // Password + OTP registration (Server Actions) are covered over HTTP by
    // the scratch-server check, since they need a Next request context.
    await change({ control: "registrations", open: true });
    const regOk = await thrown(() => resolveGoogleStudent({ providerAccountId: `g-new-${suffix}`, email: newEmail, name: "New", picture: null }));
    const newStudent = await prisma.student.findUnique({ where: { email: newEmail } });
    if (newStudent) created.students.push(newStudent.id);
    check("Google: brand-new student created again once OPEN", regOk === null && !!newStudent, code(regOk));

    // -----------------------------------------------------------------------
    console.log("\n--- Payments: new orders vs. in-flight lifecycle vs. paid access ---");
    const buyer = await mkStudent("buyer");
    const orderNumber = `PC-ORD-${suffix}`;
    const gatewayOrderId = `order_pc${suffix}`;
    const order = await prisma.paymentOrder.create({
      data: {
        orderNumber,
        receipt: orderNumber,
        studentId: buyer.id,
        productId: product.id,
        status: OrderStatus.GATEWAY_ORDER_CREATED,
        gateway: "RAZORPAY",
        environment: "TEST",
        mrpPaise: 9900,
        sellingPricePaise: 9900,
        amountPaise: 9900,
        productSnapshot: { name: product.name },
        gatewayOrderId,
        openKey: `${buyer.id}:${product.id}`,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });
    await change({ control: "payments", open: false, reason: "pc verify payments" });
    await change({ control: "lockdown", on: true, reason: "pc verify lockdown" });
    const paused = await thrown(() => createCheckoutOrder(buyer.id, product.id, null));
    check("new checkout order refused (PURCHASES_PAUSED)", code(paused) === "PURCHASES_PAUSED", code(paused));
    check("no new order row created", (await prisma.paymentOrder.count({ where: { studentId: buyer.id } })) === 1);
    const outcome = await recordTrustedPayment(
      order.id,
      { id: `pay_pc${suffix}`, order_id: gatewayOrderId, amount: 9900, currency: "INR", status: "captured", method: "upi", amount_refunded: 0 },
      "WEBHOOK"
    );
    const paidOrder = await prisma.paymentOrder.findUnique({ where: { id: order.id }, include: { entitlement: true, invoice: true } });
    check("in-flight order still fulfils during payments pause + lockdown (webhook/verify path)", outcome === "PAID" && paidOrder?.status === "PAID", { outcome, status: paidOrder?.status });
    check("entitlement granted + invoice issued for the in-flight order", paidOrder?.entitlement?.status === "ACTIVE" && !!paidOrder?.invoice);
    const ctx = await loadAccessContext(buyer.id);
    const acc = evaluateContentAccess(ctx, { kind: "MOCK_TEST", id: mock.id, examId: exam.id });
    check("existing paid access still allowed while purchases paused", acc.allowed && acc.status === "ACTIVE_SUBSCRIPTION", acc);
    const other = await mkStudent("nobuy");
    const lockedAcc = evaluateContentAccess(await loadAccessContext(other.id), { kind: "MOCK_TEST", id: mock.id, examId: exam.id });
    check("unpaid student: still locked (pause never makes paid content free) + purchasesPaused flag", !lockedAcc.allowed && lockedAcc.purchasesPaused === true, lockedAcc);
    check("Global Payment Mode still PAID", (await getPaymentMode()) === "PAID");

    console.log("\n--- Lockdown restore ---");
    await change({ control: "lockdown", on: false, reason: "pc verify restore" });
    const restored = await getEffectivePlatformControls();
    check("lockdown off → payments stays PAUSED (its own setting), others OPEN", !restored.paymentsOpen && restored.loginOpen && restored.registrationsOpen && restored.testsOpen && restored.aiOpen, restored);
    await change({ control: "payments", open: true });
    const openErr = await thrown(() => createCheckoutOrder(buyer.id, unbuyable.id, null));
    check("payments OPEN → pause gate passed (reaches product checks, no gateway call)", code(openErr) === "PRODUCT_UNAVAILABLE", code(openErr));

    // -----------------------------------------------------------------------
    console.log("\n--- Start New Tests vs. in-progress attempts ---");
    const taker = await mkStudent("taker");
    const modA = await mkModule(taker.id);
    const modB = await mkModule(taker.id);
    const inProgress = await startCustomModuleAttempt(taker.id, modA.id);
    await change({ control: "tests", open: false });
    const startErr = await thrown(() => startCustomModuleAttempt(taker.id, modB.id));
    check("new attempt refused while paused", startErr instanceof PlatformPausedError && startErr.control === "tests", code(startErr));
    check("no attempt row created for the refused start", (await prisma.testAttempt.count({ where: { studentId: taker.id } })) === 1);
    const resumed = await thrown(() => startCustomModuleAttempt(taker.id, modA.id));
    check("re-opening the IN_PROGRESS attempt (resume) still works", resumed === null, code(resumed));
    const aq = await prisma.testAttemptQuestion.findFirst({ where: { attemptId: inProgress.id }, orderBy: { order: "asc" } });
    const snapBefore = JSON.stringify(aq?.questionSnapshot);
    const save = await thrown(() => saveAnswer(inProgress.id, taker.id, aq!.questionId, "B", false, 1));
    check("save answer on the existing attempt works while paused", save === null, code(save));
    const sub = await thrown(() => submitAttempt(inProgress.id, taker.id));
    const after = await prisma.testAttempt.findUnique({ where: { id: inProgress.id } });
    check("submit on the existing attempt works while paused", sub === null && after?.status !== "IN_PROGRESS", { err: code(sub), status: after?.status });
    const aqAfter = await prisma.testAttemptQuestion.findFirst({ where: { id: aq!.id } });
    check("question snapshot unchanged", JSON.stringify(aqAfter?.questionSnapshot) === snapBefore);
    const paidStart = await thrown(() => startMockTestAttempt(buyer.id, mock.id));
    check("paid mock start also refused while paused (gate precedes everything)", paidStart instanceof PlatformPausedError, code(paidStart));
    await change({ control: "tests", open: true });
    const paidOk = await thrown(() => startMockTestAttempt(buyer.id, mock.id));
    check("tests OPEN → paid student starts the mock bought earlier", paidOk === null, code(paidOk));
    const freeOk = await thrown(() => startCustomModuleAttempt(taker.id, modB.id));
    check("tests OPEN → new free attempt starts", freeOk === null, code(freeOk));

    // -----------------------------------------------------------------------
    console.log("\n--- AI Services ---");
    await prisma.aIExplanation.create({
      data: { questionId: questions[0].id, content: { explanation: "cached" }, model: "fixture", status: AiGenerationStatus.COMPLETED, provider: "fixture", generatedAt: new Date() },
    });
    await change({ control: "ai", open: false });
    const cached = await getOrCreateExplanation(questions[0].id);
    check("cached explanation still served while AI paused", cached.status === "COMPLETED" && (cached.content as { explanation?: string }).explanation === "cached");
    const aiErr = await thrown(() => getOrCreateExplanation(questions[1].id));
    check("new explanation refused with the paused message", aiErr instanceof AiNotConfiguredError && aiErr.message === DEFAULT_PUBLIC_MESSAGES.ai, code(aiErr));
    check("no GENERATING/claim row written for the refused generation", (await prisma.aIExplanation.count({ where: { questionId: questions[1].id } })) === 0);
    const provErr = await thrown(() => generateWithAi("x", { temperature: 0, maxOutputTokens: 1 }));
    check("provider funnel generateWithAi refuses too (defence in depth)", provErr instanceof AiNotConfiguredError && provErr.message === DEFAULT_PUBLIC_MESSAGES.ai, code(provErr));
    await change({ control: "ai", open: true });
    const aiOpen = await thrown(() => getOrCreateExplanation(questions[1].id));
    check("AI OPEN → gate passed (scratch has no provider: 'not configured', not 'paused')", aiOpen instanceof AiNotConfiguredError && aiOpen.message !== DEFAULT_PUBLIC_MESSAGES.ai, code(aiOpen));
    await change({ control: "maintenance", on: true, reason: "pc verify maintenance" });
    const mErr = await thrown(() => getOrCreateExplanation(questions[2].id));
    check("maintenance pauses AI as well", mErr instanceof AiNotConfiguredError && mErr.message === DEFAULT_PUBLIC_MESSAGES.ai, code(mErr));
    const modC = await mkModule(taker.id);
    const mStart = await thrown(() => startCustomModuleAttempt(taker.id, modC.id));
    check("maintenance pauses new test starts", mStart instanceof PlatformPausedError, code(mStart));
    await change({ control: "maintenance", on: false, reason: "pc verify maintenance done" });

    // -----------------------------------------------------------------------
    console.log("\n--- Multi-worker propagation + failure fallback ---");
    await change({ control: "login", open: false });
    const child = execFileSync(
      "npx",
      ["tsx", "-e", `import("@/lib/platform-controls").then(async (m) => { console.log(JSON.stringify(await m.getEffectivePlatformControls())); process.exit(0); })`],
      { env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" }, encoding: "utf8" }
    );
    const childEff = JSON.parse(child.trim().split("\n").pop()!);
    check("a separate process (another PM2 worker) sees the change from the shared DB", childEff.loginOpen === false && childEff.registrationsOpen === false, childEff);
    await change({ control: "login", open: true });
    // Prime this process's cache with an active lockdown, then fail the read.
    await change({ control: "lockdown", on: true, reason: "pc verify fallback" });
    await getPlatformControls();
    bumpPlatformControlsCache();
    const delegate = prisma.setting as unknown as { findUnique: (...a: unknown[]) => Promise<unknown> };
    const original = delegate.findUnique;
    delegate.findUnique = async () => {
      throw new Error("simulated DB outage");
    };
    const duringOutage = await getEffectivePlatformControls();
    delegate.findUnique = original;
    check("DB read failure → last known state kept (lockdown still honoured)", duringOutage.lockdownActive === true);
    await change({ control: "lockdown", on: false, reason: "pc verify fallback done" });

    // -----------------------------------------------------------------------
    console.log("\n--- Final state ---");
    const final = await getEffectivePlatformControls();
    check(
      "all controls back to OPEN / OFF",
      final.registrationsOpen && final.loginOpen && final.paymentsOpen && final.testsOpen && final.aiOpen && !final.maintenanceOn && !final.lockdownActive && final.status === "LIVE",
      final
    );
  } finally {
    // Fixture cleanup (scratch DB only).
    const studentIds = created.students;
    await prisma.answer.deleteMany({ where: { attempt: { studentId: { in: studentIds } } } });
    await prisma.testAttemptQuestion.deleteMany({ where: { attempt: { studentId: { in: studentIds } } } });
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.invoice.deleteMany({ where: { order: { studentId: { in: studentIds } } } });
    await prisma.studentEntitlement.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.payment.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.paymentOrder.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.product.deleteMany({ where: { id: { in: [product.id, unbuyable.id] } } });
    await prisma.customModule.deleteMany({ where: { createdByStudentId: { in: studentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.aIExplanation.deleteMany({ where: { questionId: { in: questions.map((q) => q.id) } } });
    await prisma.mockTest.deleteMany({ where: { id: mock.id } });
    await prisma.question.deleteMany({ where: { id: { in: questions.map((q) => q.id) } } });
    await deleteFixtureTaxonomy(prisma, [exam.id]).catch(() => undefined);
    await prisma.exam.deleteMany({ where: { id: exam.id } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: created.admins } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: created.admins } } });
    await prisma.setting.deleteMany({ where: { key: PLATFORM_CONTROLS_KEY } });
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
