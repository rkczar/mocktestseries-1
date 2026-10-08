/**
 * Fixture for scripts/verify-plans-pricing.mjs (public /plans-and-pricing).
 *
 *   DATABASE_URL=<scratch> npx tsx scripts/plans-pricing-fixture.ts setup > /tmp/plans.json
 *   DATABASE_URL=<scratch> npx tsx scripts/plans-pricing-fixture.ts mutate <price|deactivate|restore> <productId>
 *   DATABASE_URL=<scratch> npx tsx scripts/plans-pricing-fixture.ts cleanup
 *
 * setup → PAID payment mode; an active exam (public page) with a published
 * series, FREE/PAID/DRAFT mocks and one product per listing rule (shown:
 * series on sale, 2 single mocks, PYQ package; hidden: FREE mock, DRAFT
 * mock, inactive, invisible, FREE product), a second active exam with an
 * Exam Access pass, an inactive exam with a product (hidden), and one
 * student per ownership state. Prints JSON (codes, tokens).
 */
import "dotenv/config";
import { PrismaClient, StudentAuthProvider, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { encode } from "next-auth/jwt";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to create fixtures in what looks like the production database.");
  process.exit(2);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const TAG = "PLANSQA";
const DAY = 86_400_000;

async function cleanup() {
  const exams = await prisma.exam.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } });
  const examIds = exams.map((e) => e.id);
  const students = await prisma.student.findMany({ where: { email: { endsWith: "@plans-qa.example.test" } }, select: { id: true } });
  const studentIds = students.map((s) => s.id);
  await prisma.studentEntitlement.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentDevice.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.product.deleteMany({ where: { code: { startsWith: "plansqa-" } } });
  await prisma.mockTest.deleteMany({ where: { examId: { in: examIds } } });
  await prisma.testSeries.deleteMany({ where: { examId: { in: examIds } } });
  await prisma.exam.deleteMany({ where: { id: { in: examIds } } });
}

async function setup() {
  await cleanup();
  await prisma.setting.upsert({
    where: { key: "payments.mode" },
    update: { value: { mode: "PAID" } },
    create: { key: "payments.mode", value: { mode: "PAID" } },
  });
  const now = Date.now();
  const examA = await prisma.exam.create({
    data: { name: "PLANS QA MEDICAL OFFICER EXAM 2026", code: `${TAG}-A`, isActive: true, order: -2, publicSlug: "plans-qa-mo", publicPageEnabled: true },
  });
  const examB = await prisma.exam.create({ data: { name: "PLANS QA INACTIVE EXAM", code: `${TAG}-B`, isActive: false, order: -1 } });
  const examC = await prisma.exam.create({ data: { name: "PLANS QA SECOND EXAM", code: `${TAG}-C`, isActive: true, order: -1 } });

  const series = await prisma.testSeries.create({ data: { examId: examA.id, name: "Plans QA Mock Test Series", status: "PUBLISHED", isActive: true } });
  const mock = (title: string, accessType: "FREE" | "PAID", status: "PUBLISHED" | "DRAFT") =>
    prisma.mockTest.create({ data: { examId: examA.id, testSeriesId: series.id, title, durationMinutes: 120, accessType, status } });
  const mFree = await mock("Plans QA Mock 1 (Free)", "FREE", "PUBLISHED");
  const mPaid2 = await mock("Plans QA Mock 2", "PAID", "PUBLISHED");
  const mPaid3 = await mock("Plans QA Mock 3", "PAID", "PUBLISHED");
  const mDraft = await mock("Plans QA Mock 4 (Draft)", "PAID", "DRAFT");

  const paid = { accessType: "PAID", isActive: true, isVisible: true, purchaseEnabled: true } as const;
  const make = (data: Omit<Prisma.ProductUncheckedCreateInput, "code"> & { code: string }) => prisma.product.create({ data: { ...data, code: `plansqa-${data.code}` } });
  const p = {
    series: await make({
      ...paid, code: "series", name: "Plans QA Complete Mock Test Series", description: "Every mock in the Plans QA series.", productType: "TEST_SERIES",
      examId: examA.id, testSeriesId: series.id, mrpPaise: 200000, sellingPricePaise: 99900, accessDurationType: "DAYS", accessDays: 100,
      saleEnabled: true, saleDiscountType: "PERCENTAGE", saleDiscountValue: 10, saleStartAt: new Date(now - DAY), saleEndAt: new Date(now + 7 * DAY), order: 0,
    }),
    mock2: await make({ ...paid, code: "mock2", name: "Plans QA product name for mock 2", productType: "MOCK_TEST", examId: examA.id, mockTestId: mPaid2.id, mrpPaise: 10000, sellingPricePaise: 2500, accessDurationType: "DAYS", accessDays: 100, order: 1 }),
    mock3: await make({ ...paid, code: "mock3", name: "Plans QA product name for mock 3", productType: "MOCK_TEST", examId: examA.id, mockTestId: mPaid3.id, mrpPaise: 10000, sellingPricePaise: 2500, accessDurationType: "DAYS", accessDays: 100, order: 2 }),
    pyq: await make({ ...paid, code: "pyq", name: "Plans QA PYQ Package", productType: "PYQ_PACKAGE", examId: examA.id, mrpPaise: 49900, sellingPricePaise: 49900, accessDurationType: "LIFETIME", order: 3 }),
    passC: await make({ ...paid, code: "pass-c", name: "Plans QA Second Exam Full Access", productType: "EXAM_ACCESS", examId: examC.id, mrpPaise: 150000, sellingPricePaise: 120000, accessDurationType: "FIXED_DATE", accessExpiresAt: new Date(now + 200 * DAY) }),
    // Hidden by the listing rules:
    freeMock: await make({ ...paid, code: "free-mock", name: "Plans QA HIDDEN free mock product", productType: "MOCK_TEST", examId: examA.id, mockTestId: mFree.id, mrpPaise: 5000, sellingPricePaise: 1000, accessDurationType: "DAYS", accessDays: 30 }),
    draftMock: await make({ ...paid, code: "draft-mock", name: "Plans QA HIDDEN draft mock product", productType: "MOCK_TEST", examId: examA.id, mockTestId: mDraft.id, mrpPaise: 5000, sellingPricePaise: 1000, accessDurationType: "DAYS", accessDays: 30 }),
    inactive: await make({ ...paid, isActive: false, code: "inactive", name: "Plans QA HIDDEN inactive product", productType: "PYQ_PACKAGE", examId: examA.id, mrpPaise: 5000, sellingPricePaise: 1000, accessDurationType: "LIFETIME" }),
    invisible: await make({ ...paid, isVisible: false, code: "invisible", name: "Plans QA HIDDEN invisible product", productType: "PYQ_PACKAGE", examId: examA.id, mrpPaise: 5000, sellingPricePaise: 1000, accessDurationType: "LIFETIME" }),
    free: await make({ ...paid, accessType: "FREE", code: "free", name: "Plans QA HIDDEN free product", productType: "PYQ_PACKAGE", examId: examA.id, accessDurationType: "LIFETIME" }),
    inactiveExam: await make({ ...paid, code: "exam-b", name: "Plans QA HIDDEN inactive exam pass", productType: "EXAM_ACCESS", examId: examB.id, mrpPaise: 5000, sellingPricePaise: 1000, accessDurationType: "LIFETIME" }),
  };

  // persona → entitlements [productKey, startsAt offset days, expiresAt offset days | null]
  const personas: Record<string, [keyof typeof p, number, number | null][]> = {
    fresh: [],
    series: [["series", -10, 60]],
    single: [["mock2", -95, 5]],
    expired: [["series", -110, -10]],
    pass: [["passC", -1, 199]],
  };
  const tokens: Record<string, string> = {};
  const students: Record<string, string> = {};
  for (const [persona, ents] of Object.entries(personas)) {
    const s = await prisma.student.create({
      data: { studentId: `PLANSQA-${persona}`, name: `Plans QA ${persona}`, email: `${persona}@plans-qa.example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    students[persona] = s.id;
    for (const [key, start, end] of ents) {
      await prisma.studentEntitlement.create({
        data: { studentId: s.id, productId: p[key].id, source: "ADMIN_GRANT", status: "ACTIVE", startsAt: new Date(now + start * DAY), expiresAt: end === null ? null : new Date(now + end * DAY), reason: "Plans QA fixture" },
      });
    }
    tokens[persona] = await encode({
      token: { studentDbId: s.id, studentId: s.studentId, authProvider: "CREDENTIALS", sub: s.id, name: s.name, email: s.email },
      secret: process.env.AUTH_SECRET!,
      salt: "student-session-token",
    });
  }
  console.log(
    JSON.stringify({
      examSlug: examA.publicSlug,
      products: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { id: v.id, code: v.code, name: v.name }])),
      mocks: { free: mFree.id, paid2: mPaid2.id, paid3: mPaid3.id },
      students,
      tokens,
    })
  );
}

/** Same columns Admin → Payments → Products writes. */
async function mutate(what: string, productId: string) {
  if (what === "price") await prisma.product.update({ where: { id: productId }, data: { mrpPaise: 300000, sellingPricePaise: 149900, saleEnabled: false } });
  else if (what === "deactivate") await prisma.product.update({ where: { id: productId }, data: { isActive: false } });
  else if (what === "restore") await prisma.product.update({ where: { id: productId }, data: { isActive: true, mrpPaise: 200000, sellingPricePaise: 99900, saleEnabled: true } });
  else throw new Error(`unknown mutation ${what}`);
  console.log("ok");
}

const [cmd, ...args] = process.argv.slice(2);
(cmd === "setup" ? setup() : cmd === "cleanup" ? cleanup().then(() => console.log("cleaned")) : cmd === "mutate" ? mutate(args[0], args[1]) : Promise.reject(new Error("usage: setup | mutate <what> <productId> | cleanup")))
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
