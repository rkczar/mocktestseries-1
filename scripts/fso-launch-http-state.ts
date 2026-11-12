/**
 * Scratch-only state switcher for scripts/verify-fso-launch-http.mjs (mts_fsol* DB only).
 *   npx tsx scripts/fso-launch-http-state.ts <taxonomy|publish|unpublish|pdf-on|omr-on|grant <studentId>|new-student <email>|reset>
 * Prints JSON for the caller. Synthetic data only.
 */
import { prisma } from "@/lib/prisma";
import { setExamFeature } from "@/lib/exam-features";
import { getPaperPdfIndex } from "@/lib/paper-pdfs";
import { buildNumberedOmrPdf, FSO_OMR_SPEC } from "@/lib/omr-numbered";
import { saveGeneratedResourcePdf } from "@/lib/test-resources";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.startsWith("mts_fsol")) {
  console.error("Refusing: not an mts_fsol* scratch database.");
  process.exit(2);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const fso = await prisma.exam.findUniqueOrThrow({ where: { code: "RUHS-FSO" } });
  const out: Record<string, unknown> = { examId: fso.id, slug: fso.publicSlug };
  switch (cmd) {
    case "taxonomy": {
      // 5 subjects × 4 topics so year pages / important topics clear their (production) data gates.
      if ((await prisma.examSubject.count({ where: { examId: fso.id } })) < 5) {
        const subjects = [];
        for (let i = 0; i < 5; i++) {
          const s = await prisma.subject.create({ data: { name: `Synthetic FSO Subject ${i + 1}`, nameKey: `fsol-s${i}`, originExamId: fso.id } });
          await prisma.examSubject.create({ data: { examId: fso.id, subjectId: s.id, displayOrder: i + 1 } });
          const topics = [];
          for (let j = 0; j < 4; j++) {
            const t = await prisma.topic.create({ data: { name: `Synthetic topic ${i + 1}.${j + 1}`, nameKey: `fsol-t${i}-${j}`, subjectId: s.id } });
            await prisma.examTopic.create({ data: { examId: fso.id, topicId: t.id, displayOrder: j } }).catch(() => undefined);
            topics.push(t);
          }
          subjects.push({ s, topics });
        }
        const qs = await prisma.question.findMany({ where: { examId: fso.id }, select: { id: true, paperQuestionNumber: true } });
        for (const q of qs) {
          const n = q.paperQuestionNumber ?? 1;
          const g = subjects[n % 5];
          await prisma.question.update({ where: { id: q.id }, data: { subjectId: g.s.id, topicId: g.topics[Math.floor(n / 5) % 4].id } });
        }
      }
      out.subjects = await prisma.examSubject.count({ where: { examId: fso.id } });
      break;
    }
    case "publish":
      await prisma.exam.update({ where: { id: fso.id }, data: { isActive: true, publicPageEnabled: true } });
      break;
    case "unpublish":
      await prisma.exam.update({ where: { id: fso.id }, data: { isActive: false, publicPageEnabled: false } });
      break;
    case "pdf-on": {
      await setExamFeature(fso.id, "paperDownloadEnabled", true, "http-suite");
      const index = await getPaperPdfIndex(fso.id);
      await prisma.testResource.updateMany({ where: { id: { in: index.map((e) => e.resourceId) } }, data: { isActive: true } });
      out.downloads = index.map((e) => ({ paperId: e.paperId, year: e.year, lang: e.lang, resourceId: e.resourceId }));
      out.legacyPaperPdf = index[0]?.resourceId ?? null;
      break;
    }
    case "omr-on": {
      let sheet = await prisma.testResource.findFirst({ where: { type: "OMR_TEMPLATE", examId: fso.id, mockTestId: null } });
      if (!sheet) {
        const bytes = await buildNumberedOmrPdf(FSO_OMR_SPEC);
        sheet = await prisma.testResource.create({
          data: { type: "OMR_TEMPLATE", title: "Practice OMR — 150 Questions (options 1–4)", fileUrl: await saveGeneratedResourcePdf(bytes), mimeType: "application/pdf", fileSizeBytes: bytes.length, questionCount: 150, isActive: true, order: -1, examId: fso.id },
        });
      }
      if (!sheet.isActive) sheet = await prisma.testResource.update({ where: { id: sheet.id }, data: { isActive: true } });
      out.fsoOmrId = sheet.id;
      out.ruhsOmrId = (await prisma.testResource.findFirst({ where: { type: "OMR_TEMPLATE", examId: { not: fso.id }, mockTestId: null, isActive: true } }))?.id ?? null;
      break;
    }
    case "omr-switch-on":
      await setExamFeature(fso.id, "omrDownloadEnabled", true, "http-suite");
      break;
    case "grant": {
      const product = await prisma.product.findUniqueOrThrow({ where: { code: "rpsc-fso-full-access" } });
      await prisma.studentEntitlement.create({
        data: { studentId: arg, productId: product.id, status: "ACTIVE", source: "ADMIN_GRANT", startsAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 30 * 86400_000) },
      });
      break;
    }
    case "new-student": {
      const tpl = await prisma.student.findFirstOrThrow({ where: { email: "qa-flows-free@example.test" } });
      const s = await prisma.student.upsert({
        where: { email: arg },
        update: {},
        create: { name: "QA New Multi", email: arg, studentId: arg.split("@")[0], authProvider: "CREDENTIALS", passwordHash: tpl.passwordHash, mobile: null },
      });
      await prisma.studentExamEnrollment.deleteMany({ where: { studentId: s.id } });
      out.studentId = s.id;
      break;
    }
    case "reset": {
      await prisma.exam.update({ where: { id: fso.id }, data: { isActive: false, publicPageEnabled: false } });
      await setExamFeature(fso.id, "paperDownloadEnabled", false, "http-suite");
      await setExamFeature(fso.id, "omrDownloadEnabled", false, "http-suite");
      const index = await getPaperPdfIndex(fso.id);
      await prisma.testResource.updateMany({ where: { OR: [{ id: { in: index.map((e) => e.resourceId) } }, { examId: fso.id, type: "OMR_TEMPLATE" }] }, data: { isActive: false } });
      const product = await prisma.product.findUniqueOrThrow({ where: { code: "rpsc-fso-full-access" } });
      await prisma.studentEntitlement.deleteMany({ where: { productId: product.id } });
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
  console.log(JSON.stringify(out));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
