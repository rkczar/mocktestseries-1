/**
 * Live CBT start fix (7 Oct 2026 incident) + exact start/end boundaries + IST
 * handling + dashboard promotion + public invitation + sharing. Real engine
 * flows on a DISPOSABLE database (refuses the production DB name):
 *
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-live-cbt-promotion.ts
 */
import "dotenv/config";
import { AttemptSourceType, QuestionStatus, StudentAuthProvider, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enrollInMockTest, getDashboardLiveCbtPromotion, getLiveCbtInvitation, getLiveCbtShare } from "@/lib/live-cbt";
import {
  buildLiveCbtShareMessage,
  enrollmentWindowState,
  formatIstWindow,
  liveCbtInvitePath,
  liveCbtLoginHref,
  telegramShareHref,
  whatsappShareHref,
} from "@/lib/live-cbt-core";
import { previewFormalTestStart, saveAnswer, startMockTestAttempt, studentConfigAllowed, submitAttempt } from "@/lib/test-attempt";
import { deriveMockTestAvailability, isMockTestAvailable } from "@/lib/mock-test-schedule";
import { formatIst, parseIstDateTimeLocal, toIstDateTimeLocalValue } from "@/lib/ist-time";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SITE = "https://mocktestseries.in";

async function main() {
  if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");
  const suffix = Date.now().toString(36);
  const exam = await prisma.exam.findFirstOrThrow({
    where: { isActive: true, questions: { some: { status: QuestionStatus.PUBLISHED } } },
    orderBy: { questions: { _count: "desc" } },
  });
  const otherExam = await prisma.exam.findFirst({ where: { isActive: true, id: { not: exam.id } } });
  const bank = await prisma.question.findMany({
    where: { examId: exam.id, status: QuestionStatus.PUBLISHED, questionType: "SINGLE_CORRECT", options: { some: { isCorrect: true } } },
    take: 4,
    orderBy: { code: "asc" },
    include: { options: true },
  });
  const correctOf = (qid: string) => bank.find((q) => q.id === qid)!.options.find((o) => o.isCorrect)!.label;
  const students: string[] = [];
  const mkStudent = async (name: string) => {
    const s = await prisma.student.create({
      data: { studentId: `LCP-${suffix}-${students.length}`, name, email: `lcp-${suffix}-${students.length}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    students.push(s.id);
    return s.id;
  };
  const mocks: string[] = [];
  const mkMock = async (tag: string, extra: Partial<Prisma.MockTestUncheckedCreateInput> = {}) => {
    const m = await prisma.mockTest.create({
      data: {
        examId: exam.id,
        title: `LCP ${tag} ${suffix}`,
        durationMinutes: 60,
        status: "PUBLISHED",
        accessType: "FREE",
        ...extra,
        questions: { create: bank.map((q, order) => ({ questionId: q.id, order })) },
      },
    });
    mocks.push(m.id);
    return m;
  };
  const sec = (n: number) => new Date(Date.now() + n * 1000);
  const min = (n: number) => sec(n * 60);
  const attemptsOf = (studentId: string, mockTestId: string) => prisma.testAttempt.count({ where: { studentId, mockTestId } });
  const integrityBefore = await prisma.$queryRaw<{ h: string }[]>`SELECT md5(string_agg(concat_ws('|',id,status,score,"submittedAt","timeTakenSeconds"), ',' ORDER BY id)) h FROM "TestAttempt"`;

  try {
    // ------------------------------------------------------------------
    console.log("\n--- Incident regression: enrollment ON + no window + Immediate result ---");
    // The exact production row of 7 Oct 04:30 UTC: Scheduled Release (no end), Immediate, Single Attempt, enrollment ON.
    const incident = await mkMock("INCIDENT", { availableFrom: min(-1), availableUntil: null, resultReleaseMode: "IMMEDIATE", attemptPolicy: "SINGLE_ATTEMPT", enrollmentEnabled: true });
    check("Live CBT (enrollment ON) is never student-configurable", !studentConfigAllowed(AttemptSourceType.MOCK_TEST, incident));
    check("ordinary Immediate / no-window mock still configurable (Pre-Test Setup unchanged)", studentConfigAllowed(AttemptSourceType.MOCK_TEST, { ...incident, enrollmentEnabled: false }));
    check("windowed mock still not configurable", !studentConfigAllowed(AttemptSourceType.MOCK_TEST, { resultReleaseMode: "IMMEDIATE", availableUntil: min(60), enrollmentEnabled: false }));
    const sI = await mkStudent("Incident Student");
    await enrollInMockTest(sI, incident.id);
    const prev = await previewFormalTestStart(sI, { kind: "MOCK_TEST", id: incident.id });
    check("start preview: no Pre-Test Setup (configurable = false) → the action goes straight to the player", prev.resume === null && !prev.summary.configurable, prev);
    const aI = await startMockTestAttempt(sI, incident.id, undefined, { answerMode: "INSTANT", durationMode: "UNLIMITED" } as never);
    check("attempt created in fixed EXAM mode with admin time (a submitted choice is ignored)", aI.answerMode === "EXAM" && aI.durationMode === "FIXED" && aI.durationMinutes === 60, aI);
    check("question snapshots generated", (await prisma.testAttemptQuestion.count({ where: { attemptId: aI.id } })) === bank.length);
    const again = await startMockTestAttempt(sI, incident.id);
    check("second Start resumes the SAME attempt", again.id === aI.id && (await attemptsOf(sI, incident.id)) === 1);
    const incidentAvail = await mkMock("INCIDENT-NOW", { availableFrom: null, availableUntil: null, resultReleaseMode: "IMMEDIATE", enrollmentEnabled: true });
    check("enrollment ON + Available Now (the 05:33 UTC config) not configurable either", !studentConfigAllowed(AttemptSourceType.MOCK_TEST, incidentAvail));

    // ------------------------------------------------------------------
    console.log("\n--- Start window boundaries (controlled clock) ---");
    const S0 = new Date("2026-10-07T04:30:00.000Z");
    const E0 = new Date("2026-10-07T06:30:00.000Z");
    const row = { status: "PUBLISHED" as const, availableFrom: S0, availableUntil: E0 };
    const at = (ms: number) => new Date(S0.getTime() + ms);
    const cases: [string, Date, string, boolean][] = [
      ["60 s before start", at(-60_000), "UPCOMING", false],
      ["1 s before start", at(-1_000), "UPCOMING", false],
      ["exact startAt", S0, "LIVE_NOW", true],
      ["1 s after start", at(1_000), "LIVE_NOW", true],
      ["halfway", at(3_600_000), "LIVE_NOW", true],
      ["1 s before end", new Date(E0.getTime() - 1_000), "LIVE_NOW", true],
      ["exact endAt", E0, "CLOSED", false],
      ["after endAt", new Date(E0.getTime() + 60_000), "CLOSED", false],
    ];
    for (const [label, now, state, open] of cases) {
      check(`${label}: ${state}, start ${open ? "allowed" : "refused"}`, deriveMockTestAvailability(row, now) === state && isMockTestAvailable(row, now) === open);
    }
    const enr = { enrollmentEnabled: true, enrollmentOpensAt: null, enrollmentClosesAt: null, availableUntil: E0 };
    check("late enrollment open 1 s before end, closed at exact endAt", enrollmentWindowState(enr, new Date(E0.getTime() - 1000)) === "OPEN" && enrollmentWindowState(enr, E0) === "CLOSED");

    // Server gate on real time: start = now + 3 s.
    const edge = await mkMock("EDGE", { availableFrom: sec(3), availableUntil: sec(9), enrollmentEnabled: true, attemptPolicy: "SINGLE_ATTEMPT", resultReleaseMode: "AFTER_WINDOW" });
    const sE = await mkStudent("Edge Student");
    await enrollInMockTest(sE, edge.id);
    const before = await refusal(() => startMockTestAttempt(sE, edge.id));
    check("server: enrolled, before startAt → refused, no attempt", before.includes("not available yet") && (await attemptsOf(sE, edge.id)) === 0, before);
    await sleep(Math.max(0, edge.availableFrom!.getTime() - Date.now()) + 150);
    const aE = await startMockTestAttempt(sE, edge.id);
    check("server: just after startAt → attempt starts", aE.status === "IN_PROGRESS");
    const q = (await prisma.testAttemptQuestion.findFirstOrThrow({ where: { attemptId: aE.id }, orderBy: { order: "asc" } })).questionId;
    check("answer saved inside the window", (await saveAnswer(aE.id, sE, q, correctOf(q), false)).applied === true);
    await sleep(Math.max(0, edge.availableUntil!.getTime() - Date.now()) + 300);
    const late = await refusal(() => saveAnswer(aE.id, sE, q, "Z", false));
    check("answer after endAt refused", late !== "OK", late);
    const sLate = await mkStudent("After End Student");
    const afterEnd = await refusal(() => enrollInMockTest(sLate, edge.id));
    check("after endAt: enrollment refused", afterEnd.includes("closed"), afterEnd);
    const startAfter = await refusal(() => startMockTestAttempt(sE, edge.id));
    check("after endAt: no new start (window closed / single attempt)", startAfter !== "OK" && (await attemptsOf(sE, edge.id)) === 1, startAfter);
    const sub1 = await submitAttempt(aE.id, sE);
    const sub2 = await submitAttempt(aE.id, sE);
    const graded = await prisma.testAttempt.findUniqueOrThrow({ where: { id: aE.id } });
    check("duplicate submit is idempotent (one SUBMITTED, saved answer graded)", graded.status === "SUBMITTED" && graded.correctCount === 1 && sub1.id === sub2.id, graded);

    // ------------------------------------------------------------------
    console.log("\n--- Double-click / two tabs ---");
    const dbl = await mkMock("DBL", { availableFrom: min(-1), availableUntil: min(60), enrollmentEnabled: true, attemptPolicy: "SINGLE_ATTEMPT", resultReleaseMode: "AFTER_WINDOW" });
    const sD = await mkStudent("Double Click");
    await enrollInMockTest(sD, dbl.id);
    const many = await Promise.all(Array.from({ length: 6 }, () => startMockTestAttempt(sD, dbl.id)));
    check("6 simultaneous starts → one attempt, every request gets it", new Set(many.map((a) => a.id)).size === 1 && (await attemptsOf(sD, dbl.id)) === 1);

    // ------------------------------------------------------------------
    console.log("\n--- IST (admin input → storage → display) ---");
    const parsed = parseIstDateTimeLocal("2026-10-07T10:00");
    check("admin '07 Oct 2026 10:00' (IST) stored as 04:30 UTC", parsed?.toISOString() === "2026-10-07T04:30:00.000Z", parsed);
    check("edit form shows it back as 10:00 IST (no double conversion)", toIstDateTimeLocalValue(new Date("2026-10-07T04:30:00.000Z")) === "2026-10-07T10:00");
    check("display: 10:00 am IST", /10:00\s?am IST$/i.test(formatIst(new Date("2026-10-07T04:30:00.000Z"))), formatIst(new Date("2026-10-07T04:30:00.000Z")));
    check("window text 10:00 am – 12:00 pm IST", /^10:00\s?am – 12:00\s?pm IST$/i.test(formatIstWindow(new Date("2026-10-07T04:30:00Z"), new Date("2026-10-07T06:30:00Z"))));
    const prevTZ = process.env.TZ;
    process.env.TZ = "America/New_York";
    check("IST text independent of the server/browser time zone", /^10:00\s?am – 12:00\s?pm IST$/i.test(formatIstWindow(new Date("2026-10-07T04:30:00Z"), new Date("2026-10-07T06:30:00Z"))));
    process.env.TZ = prevTZ;

    // ------------------------------------------------------------------
    console.log("\n--- Share message ---");
    const url = `${SITE}${liveCbtInvitePath("abc123")}`;
    const msg = buildLiveCbtShareMessage({ examName: "RUHS Medical Officer 2026", title: "Live Mock 1 & Co", startsAt: new Date("2026-10-07T04:30:00Z"), endsAt: new Date("2026-10-07T06:30:00Z"), url });
    check("message: exam, title, IST date + time, URL, brand", msg.startsWith("🩺 RUHS Medical Officer 2026 — LIVE CBT") && msg.includes("Test: Live Mock 1 & Co") && msg.includes("Date: Wed, 07 Oct 2026") && /Time: 10:00\s?am – 12:00\s?pm IST/i.test(msg) && msg.includes(url) && msg.trim().endsWith("MockTestSeries.in"), msg);
    const wa = new URL(whatsappShareHref(msg));
    check("WhatsApp link encodes the message exactly once", wa.origin === "https://wa.me" && wa.searchParams.get("text") === msg);
    const tg = new URL(telegramShareHref(url, msg));
    check("Telegram link: url param + text without a duplicate URL", tg.searchParams.get("url") === url && !tg.searchParams.get("text")!.includes(url) && tg.searchParams.get("text")!.includes("Test: Live Mock 1 & Co"));
    check("login link keeps the test as the destination", liveCbtLoginHref("abc123") === "/login?callbackUrl=%2Fstudent%2Ftest-series%2Fabc123");

    // ------------------------------------------------------------------
    console.log("\n--- Dashboard promotion selection ---");
    const sP = await mkStudent("Promo Student");
    check("nothing promoted → no card", (await getDashboardLiveCbtPromotion(sP, exam.id, SITE)) === null);
    await mkMock("NOTPROMO", { availableFrom: min(30), availableUntil: min(150) });
    await mkMock("DRAFT", { status: "DRAFT", promoteOnDashboard: true, availableFrom: min(30), availableUntil: min(150) });
    await mkMock("NOWINDOW", { promoteOnDashboard: true, enrollmentEnabled: true, availableFrom: min(30), availableUntil: null });
    const closedNoAttempt = await mkMock("CLOSED", { promoteOnDashboard: true, availableFrom: min(-120), availableUntil: min(-10) });
    check("unpublished / not promoted / no window / closed-unattempted → no card", (await getDashboardLiveCbtPromotion(sP, exam.id, SITE)) === null);
    const up2 = await mkMock("UP2", { promoteOnDashboard: true, enrollmentEnabled: true, availableFrom: min(300), availableUntil: min(420) });
    const up1 = await mkMock("UP1", {
      promoteOnDashboard: true, allowSharing: true, promoText: "Full-length pattern test", enrollmentEnabled: true,
      availableFrom: min(120), availableUntil: min(240), attemptPolicy: "SINGLE_ATTEMPT", resultReleaseMode: "AFTER_WINDOW",
    });
    let p = await getDashboardLiveCbtPromotion(sP, exam.id, SITE);
    check("UPCOMING: the soonest promoted test, not enrolled, count 2", p?.mockTestId === up1.id && p.state === "UPCOMING" && !p.enrolled && p.promotedCount === 2, p);
    check("card fields: question count, duration, promo text, share URL + message", p?.questionCount === bank.length && p.durationMinutes === 60 && p.promoText === "Full-length pattern test" && p.share?.url === `${SITE}/live-cbt/${up1.id}` && p.share.message.includes(up1.title), p?.share);
    check("no share when sharing OFF", (await prisma.mockTest.findUniqueOrThrow({ where: { id: up2.id } })).allowSharing === false);
    await enrollInMockTest(sP, up1.id);
    p = await getDashboardLiveCbtPromotion(sP, exam.id, SITE);
    check("UPCOMING + enrolled", p?.state === "UPCOMING" && p.enrolled === true);
    const live = await mkMock("LIVE", { promoteOnDashboard: true, enrollmentEnabled: true, availableFrom: min(-5), availableUntil: min(115), attemptPolicy: "SINGLE_ATTEMPT", resultReleaseMode: "AFTER_WINDOW" });
    p = await getDashboardLiveCbtPromotion(sP, exam.id, SITE);
    check("LIVE beats UPCOMING; not enrolled (late enrollment open)", p?.mockTestId === live.id && p.state === "LIVE" && !p.enrolled && p.enrollmentClosesAt === live.availableUntil!.toISOString(), p);
    await enrollInMockTest(sP, live.id);
    const aL = await startMockTestAttempt(sP, live.id);
    p = await getDashboardLiveCbtPromotion(sP, exam.id, SITE);
    check("LIVE + in progress → resume this attempt", p?.state === "LIVE" && p.inProgressAttemptId === aL.id);
    await submitAttempt(aL.id, sP);
    p = await getDashboardLiveCbtPromotion(sP, exam.id, SITE);
    check("after submitting: the next relevant test (upcoming) is promoted", p?.mockTestId === up1.id, p?.mockTestId);
    await prisma.mockTest.update({ where: { id: up1.id }, data: { promoteOnDashboard: false } });
    await prisma.mockTest.update({ where: { id: up2.id }, data: { promoteOnDashboard: false } });
    p = await getDashboardLiveCbtPromotion(sP, exam.id, SITE);
    check("COMPLETED: Submitted + Result Pending until the window ends (no share)", p?.mockTestId === live.id && p.state === "COMPLETED" && p.resultReleased === false && p.submittedAttemptId === aL.id && p.share === null, p);
    check("promotion is scoped to the active exam", otherExam ? (await getDashboardLiveCbtPromotion(sP, otherExam.id, SITE)) === null : true);
    const sQ = await mkStudent("Paid Student");
    const paid = await mkMock("PAID", { accessType: "PAID", promoteOnDashboard: true, enrollmentEnabled: true, availableFrom: min(-2), availableUntil: min(100) });
    p = await getDashboardLiveCbtPromotion(sQ, exam.id, SITE);
    check("PAID without access → card says locked (links to the test page, never enrolls)", p?.mockTestId === paid.id && p.accessAllowed === false, p);
    check("…and enrolling it directly is still refused", (await refusal(() => enrollInMockTest(sQ, paid.id))).includes("Unlock"));
    await prisma.mockTest.update({ where: { id: paid.id }, data: { promoteOnDashboard: false } });
    await prisma.mockTest.update({ where: { id: live.id }, data: { status: "DRAFT" } });
    check("unpublishing (cancel) removes the card", (await getDashboardLiveCbtPromotion(sP, exam.id, SITE)) === null);
    void closedNoAttempt;

    // ------------------------------------------------------------------
    console.log("\n--- Public invitation + test-page share ---");
    const inv = await getLiveCbtInvitation(up1.id, SITE);
    check("invitation: published + windowed + sharing ON", inv?.title === up1.title && inv.phase === "UPCOMING" && inv.share.url === `${SITE}/live-cbt/${up1.id}` && inv.enrollmentState === "OPEN");
    const keys = Object.keys(inv ?? {}).sort().join(",");
    check("invitation carries only test details (no student / attempt / answer data)", keys === "durationMinutes,endsAt,enrollmentEnabled,enrollmentState,examName,mockTestId,paid,phase,promoText,questionCount,share,startsAt,title", keys);
    check("sharing OFF → no invitation, no share", (await getLiveCbtInvitation(up2.id, SITE)) === null && (await getLiveCbtShare(up2.id, SITE)) === null);
    await prisma.mockTest.update({ where: { id: up2.id }, data: { allowSharing: true, status: "DRAFT" } });
    check("unpublished (cancelled) test → no invitation", (await getLiveCbtInvitation(up2.id, SITE)) === null);
    const noWin = await mkMock("NOWIN-SHARE", { allowSharing: true, enrollmentEnabled: true, availableFrom: min(10), availableUntil: null });
    check("no Fixed Window → not shareable", (await getLiveCbtInvitation(noWin.id, SITE)) === null);
    await prisma.mockTest.update({ where: { id: closedNoAttempt.id }, data: { allowSharing: true } });
    const ended = await getLiveCbtInvitation(closedNoAttempt.id, SITE);
    check("ended test: invitation shows CLOSED; test-page share hidden", ended?.phase === "CLOSED" && (await getLiveCbtShare(closedNoAttempt.id, SITE)) === null);
    check("test-page share (before enrollment too)", (await getLiveCbtShare(up1.id, SITE))?.url === `${SITE}/live-cbt/${up1.id}`);
  } finally {
    // ------------------------------------------------------------------
    console.log("\n--- Cleanup / integrity ---");
    await prisma.testAttempt.deleteMany({ where: { studentId: { in: students } } });
    await prisma.mockTest.deleteMany({ where: { id: { in: mocks } } });
    await prisma.studentActivity.deleteMany({ where: { studentId: { in: students } } });
    await prisma.student.deleteMany({ where: { id: { in: students } } });
    const integrityAfter = await prisma.$queryRaw<{ h: string }[]>`SELECT md5(string_agg(concat_ws('|',id,status,score,"submittedAt","timeTakenSeconds"), ',' ORDER BY id)) h FROM "TestAttempt"`;
    check("every pre-existing attempt unchanged", integrityBefore[0].h === integrityAfter[0].h);
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
