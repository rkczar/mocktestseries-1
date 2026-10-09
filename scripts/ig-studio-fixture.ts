/**
 * Instagram Content Studio — disposable fixture. SYNTHETIC data only (no
 * copied student records): fixture exams, PYQ papers, questions covering
 * every quality-gate case, placeholder students with submitted attempts on
 * known dates (for Most Missed), and three admins (one per role).
 *
 * Refuses to run unless the database name contains "igstudio".
 *
 *   set -a; . ./.env; set +a
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/ig-studio-fixture.ts setup|cleanup|reset-posts
 */
import "dotenv/config";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import { istStartOfDay } from "@/lib/ist-time";
import { createFixtureSubject, createFixtureTopic, deleteFixtureTaxonomy } from "./fixture-taxonomy";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.includes("igstudio")) {
  console.error(`Refusing to run: database "${dbName}" is not an igstudio scratch database.`);
  process.exit(2);
}

export const IGFIX = {
  password: "IgStudio#Fixture2026",
  admins: [
    { username: "igmaster", name: "IG Master", role: "MASTER_ADMIN" as const },
    { username: "igfull", name: "IG Full Admin", role: "FULL_ADMIN" as const },
    { username: "igteacher", name: "IG Teacher", role: "TEACHER" as const },
  ],
  examCodes: ["IGFIX-RUHS", "IGFIX-RPSC"],
  studentPrefix: "IGFIX-S",
};

const DAY = 86_400_000;

async function cleanup() {
  const exams = await prisma.exam.findMany({ where: { code: { in: IGFIX.examCodes } }, select: { id: true } });
  const examIds = exams.map((e) => e.id);
  const questions = await prisma.question.findMany({ where: { examId: { in: examIds } }, select: { id: true } });
  const qids = questions.map((q) => q.id);
  await prisma.instagramPost.deleteMany({ where: { questionId: { in: qids } } });
  const students = await prisma.student.findMany({ where: { studentId: { startsWith: IGFIX.studentPrefix } }, select: { id: true } });
  const sids = students.map((s) => s.id);
  await prisma.answer.deleteMany({ where: { studentId: { in: sids } } });
  await prisma.testAttemptQuestion.deleteMany({ where: { attempt: { studentId: { in: sids } } } });
  await prisma.testAttempt.deleteMany({ where: { studentId: { in: sids } } });
  await prisma.student.deleteMany({ where: { id: { in: sids } } });
  await prisma.aIExplanation.deleteMany({ where: { questionId: { in: qids } } });
  await prisma.questionOption.deleteMany({ where: { questionId: { in: qids } } });
  await prisma.question.deleteMany({ where: { id: { in: qids } } });
  await prisma.previousYearPaper.deleteMany({ where: { examId: { in: examIds } } });
  await deleteFixtureTaxonomy(prisma, examIds);
  await prisma.exam.deleteMany({ where: { id: { in: examIds } } });
  await prisma.setting.deleteMany({ where: { key: "instagram.studio" } });
  console.log(`cleanup: ${examIds.length} exams, ${qids.length} questions, ${sids.length} students removed`);
}

type Opt = [label: string, text: string, correct?: boolean];

async function setup() {
  await cleanup();
  const hash = await argon2.hash(IGFIX.password);
  for (const a of IGFIX.admins) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: a.role } });
    await prisma.adminUser.upsert({
      where: { username: a.username },
      update: { passwordHash: hash, roleId: role.id, isActive: true, name: a.name },
      create: { username: a.username, name: a.name, passwordHash: hash, roleId: role.id, email: `${a.username}@example.test` },
    });
  }
  await prisma.loginAttempt.deleteMany({}).catch(() => undefined);

  const ruhs = await prisma.exam.create({ data: { name: "IGFIX RUHS MO", code: "IGFIX-RUHS", isActive: true } });
  const rpsc = await prisma.exam.create({ data: { name: "IGFIX RPSC MO", code: "IGFIX-RPSC", isActive: true } });
  const pharma = await createFixtureSubject(prisma, { examId: ruhs.id, name: "Pharmacology" });
  const medicine = await createFixtureSubject(prisma, { examId: ruhs.id, name: "Medicine" });
  const rpscSub = await createFixtureSubject(prisma, { examId: rpsc.id, name: "General Medicine" });
  const antiepi = await createFixtureTopic(prisma, { subjectId: pharma.id, name: "Antiepileptics" });

  const p2021 = await prisma.previousYearPaper.create({ data: { examId: ruhs.id, year: 2021, title: "IGFIX RUHS MO 2021", isActive: true } });
  const p2019 = await prisma.previousYearPaper.create({ data: { examId: ruhs.id, year: 2019, title: "IGFIX RUHS MO 2019", isActive: true } });
  const pI = await prisma.previousYearPaper.create({ data: { examId: rpsc.id, year: 2024, title: "IGFIX RPSC 2024 Paper I", isActive: true } });
  const pII = await prisma.previousYearPaper.create({ data: { examId: rpsc.id, year: 2024, title: "IGFIX RPSC 2024 Paper II", isActive: true } });

  let tick = Date.now() - 30 * DAY;
  const mk = async (code: string, data: { examId: string; subjectId: string; topicId?: string; paperId?: string | null; text: string; options: Opt[]; imageUrl?: string; reviewRequired?: boolean; reviewReason?: string; status?: "PUBLISHED" | "DRAFT" }) => {
    tick += 1000; // stable stored order = creation order
    return prisma.question.create({
      data: {
        code,
        examId: data.examId,
        subjectId: data.subjectId,
        topicId: data.topicId ?? null,
        previousYearPaperId: data.paperId ?? null,
        source: data.paperId ? "PYQ" : "QUESTION_BANK",
        text: data.text,
        imageUrl: data.imageUrl ?? null,
        status: data.status ?? "PUBLISHED",
        reviewRequired: data.reviewRequired ?? false,
        reviewReason: data.reviewReason ?? null,
        createdAt: new Date(tick),
        options: { create: data.options.map(([label, text, correct], i) => ({ label, text, order: i, isCorrect: Boolean(correct) })) },
      },
      include: { options: true },
    });
  };
  const four = (a: string, b: string, c: string, d: string, correct: "A" | "B" | "C" | "D"): Opt[] =>
    (
      [
        ["A", a],
        ["B", b],
        ["C", c],
        ["D", d],
      ] as Opt[]
    ).map(([l, t]) => [l, t, l === correct] as Opt);

  // RUHS 2021 — one question per quality-gate case.
  const good = await mk("IGFIX-RUHS21-W01", {
    examId: ruhs.id,
    subjectId: pharma.id,
    topicId: antiepi.id,
    paperId: p2021.id,
    text: "Drug of choice for the treatment of absence seizures in a 7-year-old child is:",
    options: four("Phenytoin", "Ethosuximide", "Carbamazepine", "Phenobarbitone", "B"),
  });
  await prisma.aIExplanation.create({
    data: {
      questionId: good.id,
      model: "fixture",
      status: "COMPLETED",
      adminReviewedAt: new Date(),
      content: {
        concept: "Ethosuximide blocks T-type calcium channels in thalamic neurons, which drive the 3 Hz spike-and-wave rhythm of absence seizures.",
        memoryTrick: "ETHO = Empty THOughts: the child stares blankly.",
        pointsToRemember: ["T-type Ca channel blocker", "EEG: 3 Hz spike-and-wave", "Valproate if mixed generalized seizures"],
      },
    },
  });
  await mk("IGFIX-RUHS21-W02", {
    examId: ruhs.id,
    subjectId: medicine.id,
    paperId: p2021.id,
    text: "ll are types of RCT except:",
    options: four("Parallel", "Crossover", "Factorial", "Case-control", "D"),
    reviewRequired: true,
    reviewReason: "Imported scan — first letters missing",
  });
  await mk("IGFIX-RUHS21-W03", { examId: ruhs.id, subjectId: medicine.id, paperId: p2021.id, text: "Identify the ECG finding shown in the image:", options: four("Hyperkalemia", "Hypokalemia", "Hypocalcemia", "Normal", "A"), imageUrl: "/storage/question-images/igfix-ecg.png" });
  await mk("IGFIX-RUHS21-W04", { examId: ruhs.id, subjectId: medicine.id, paperId: p2021.id, text: "Which vitamin deficiency causes pellagra?", options: four("Thiamine", "Riboflavin", "Niacin", "Pyridoxine", "A").map(([l, t]) => [l, t, false] as Opt) });
  await mk("IGFIX-RUHS21-W05", { examId: ruhs.id, subjectId: pharma.id, paperId: p2021.id, text: "β-lactamase inhibitor combined with amoxicillin is:", options: four("Sulbactam", "Clavulanic acid", "Tazobactam", "Avibactam", "B") });
  await mk("IGFIX-RUHS21-W06", {
    examId: ruhs.id,
    subjectId: medicine.id,
    paperId: p2021.id,
    text:
      "A 54-year-old man with long-standing type 2 diabetes mellitus, hypertension, dyslipidaemia, chronic kidney disease stage 3, previous myocardial infarction, peripheral arterial disease and a recent episode of transient ischaemic attack presents to the outpatient department with progressive breathlessness on exertion, orthopnoea, paroxysmal nocturnal dyspnoea, bilateral pedal oedema, raised jugular venous pressure, bibasal crepitations and an S3 gallop; echocardiography shows an ejection fraction of 30 percent with global hypokinesia and moderate functional mitral regurgitation, and his serum potassium is 5.4 mmol/L with an eGFR of 38 mL/min. Which of the following drugs should be AVOIDED in this patient at this stage of management?",
    options: four(
      "Sacubitril-valsartan started after a 36-hour washout of the ACE inhibitor with close monitoring of renal function and potassium",
      "Spironolactone added immediately at full dose despite the current serum potassium and reduced eGFR",
      "Dapagliflozin started at the standard dose with monitoring of volume status and renal function",
      "Bisoprolol started at a low dose once the patient is euvolaemic and titrated slowly every two weeks",
      "B"
    ),
  });
  await mk("IGFIX-RUHS21-W07", { examId: ruhs.id, subjectId: medicine.id, paperId: p2021.id, text: "Normal serum Ca⁺⁺ level is:", options: four("6-7 mg/dL", "8.5-10.5 mg/dL", "12-14 mg/dL", "15-16 mg/dL", "B") });
  // RUHS 2019
  const mm1 = await mk("IGFIX-RUHS19-W01", { examId: ruhs.id, subjectId: medicine.id, paperId: p2019.id, text: "Most common site of carcinoid tumour in the gastrointestinal tract is:", options: four("Stomach", "Appendix", "Small intestine", "Rectum", "C") });
  const mm2 = await mk("IGFIX-RUHS19-W02", { examId: ruhs.id, subjectId: pharma.id, paperId: p2019.id, text: "Antidote for heparin overdose is:", options: four("Vitamin K", "Protamine sulphate", "Fresh frozen plasma", "Desmopressin", "B") });
  // RPSC 2024 — two papers in the same year.
  await mk("IGFIX-RPSC24I-W01", { examId: rpsc.id, subjectId: rpscSub.id, paperId: pI.id, text: "Koplik spots are seen in:", options: four("Measles", "Mumps", "Rubella", "Chickenpox", "A") });
  await mk("IGFIX-RPSC24II-W01", { examId: rpsc.id, subjectId: rpscSub.id, paperId: pII.id, text: "Charcot's triad is seen in:", options: four("Acute cholangitis", "Acute pancreatitis", "Cholecystitis", "Hepatitis", "A") });
  // A practice (non-PYQ) question for Most Missed.
  const practice = await mk("IGFIX-QB-0001", { examId: ruhs.id, subjectId: medicine.id, text: "Drug of choice for anaphylaxis is:", options: four("Adrenaline", "Hydrocortisone", "Chlorpheniramine", "Salbutamol", "A") });

  // Placeholder students + submitted attempts. Yesterday (IST): mm1 10 answers / 7 wrong,
  // mm2 10 / 4 wrong, practice 10 / 6 wrong, good 6 / 5 wrong (+1 unanswered). Today: mm2 3 / 3 wrong.
  const students = [];
  for (let i = 1; i <= 10; i++) {
    students.push(await prisma.student.create({ data: { studentId: `${IGFIX.studentPrefix}${String(i).padStart(3, "0")}`, name: `IG Fixture Student ${i}`, authProvider: "CREDENTIALS" } }));
  }
  const todayStart = istStartOfDay(new Date());
  const yesterdayNoon = new Date(todayStart.getTime() - DAY / 2);
  const todayEarly = new Date(Math.min(Date.now() - 60_000, todayStart.getTime() + 60_000));
  const answer = async (studentId: string, at: Date, items: { q: typeof good; label: string | null }[]) => {
    const attempt = await prisma.testAttempt.create({
      data: { studentId, sourceType: "CUSTOM_MODULE", testType: "CUSTOM_MODULE", examId: ruhs.id, durationMinutes: 10, totalQuestions: items.length, status: "SUBMITTED", submittedAt: at },
    });
    for (const [j, it] of items.entries()) {
      const key = it.q.options.find((o) => o.isCorrect)?.label ?? "";
      const tq = await prisma.testAttemptQuestion.create({ data: { attemptId: attempt.id, questionId: it.q.id, order: j, questionSnapshot: { code: it.q.code, text: it.q.text, options: [], correctLabel: key } } });
      await prisma.answer.create({
        data: {
          attemptId: attempt.id,
          attemptQuestionId: tq.id,
          studentId,
          questionId: it.q.id,
          selectedOptionLabel: it.label,
          status: it.label ? "ANSWERED" : "UNANSWERED",
          isCorrect: it.label ? it.label === key : null,
          answeredAt: it.label ? at : null,
          saveSeq: 3,
        },
      });
    }
  };
  for (const [i, s] of students.entries()) {
    const items: { q: typeof good; label: string | null }[] = [
      { q: mm1, label: i < 3 ? "C" : "A" }, // 7 wrong of 10
      { q: mm2, label: i < 6 ? "B" : "A" }, // 4 wrong of 10
      { q: practice, label: i < 4 ? "A" : "B" }, // 6 wrong of 10
    ];
    if (i < 7) items.push({ q: good, label: i === 6 ? null : i === 0 ? "B" : "A" }); // 5 wrong of 6 answered, 1 unanswered
    await answer(s.id, yesterdayNoon, items);
  }
  for (const s of students.slice(0, 3)) await answer(s.id, todayEarly, [{ q: mm2, label: "D" }]);

  console.log(`setup: exams ${ruhs.id} ${rpsc.id}; papers ${p2021.id} ${p2019.id} ${pI.id} ${pII.id}; good=${good.id}; mm1=${mm1.id}; mm2=${mm2.id}; practice=${practice.id}`);
}

async function resetPosts() {
  const exams = await prisma.exam.findMany({ where: { code: { in: IGFIX.examCodes } }, select: { id: true } });
  const qids = (await prisma.question.findMany({ where: { examId: { in: exams.map((e) => e.id) } }, select: { id: true } })).map((q) => q.id);
  const r = await prisma.instagramPost.deleteMany({ where: { questionId: { in: qids } } });
  await prisma.setting.deleteMany({ where: { key: "instagram.studio" } });
  await prisma.loginAttempt.deleteMany({}).catch(() => undefined);
  console.log(`reset-posts: ${r.count} posts removed`);
}

const cmd = process.argv[2];
(cmd === "setup" ? setup() : cmd === "cleanup" ? cleanup() : cmd === "reset-posts" ? resetPosts() : Promise.reject(new Error("usage: setup|cleanup|reset-posts")))
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
