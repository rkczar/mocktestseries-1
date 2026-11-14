/**
 * Fixture for scripts/verify-admin-students-ui.mjs (DISPOSABLE mts_* database only).
 *   setup   → a MASTER_ADMIN and a FULL_ADMIN login, and 3 students enrolled in two existing exams (one in both).
 *   cleanup <json file> → removes the admins and any of those students that were not deleted by the test.
 *
 *   DATABASE_URL=<scratch> PG_POOL_MAX=3 NODE_OPTIONS="--conditions=react-server" npx tsx scripts/admin-students-ui-fixture.ts setup > fx.json
 */
import fs from "node:fs";
import argon2 from "argon2";

if (!/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Scratch (mts_*) database only.");
  process.exit(2);
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { nextStudentId } = await import("@/lib/student-id");
  const [cmd, file] = process.argv.slice(2);
  if (cmd === "cleanup") {
    const fx = JSON.parse(fs.readFileSync(file, "utf8"));
    // An admin who approved a deletion is referenced by that closed (immutable) audit record: it stays, by design.
    for (const username of [fx.master.username, fx.full.username]) {
      await prisma.adminUser.delete({ where: { username } }).catch(() => console.error(`kept ${username} (referenced by a closed deletion audit record)`));
    }
    await prisma.student.deleteMany({ where: { id: { in: fx.studentIds }, status: { not: "DELETED" } } });
    await prisma.$disconnect();
    return;
  }
  const RUN = Date.now().toString(36);
  const password = `Pw-${RUN}-x9!`;
  const passwordHash = await argon2.hash(password);
  const role = (name: "MASTER_ADMIN" | "FULL_ADMIN") => prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  const master = await prisma.adminUser.create({ data: { name: "UI Master", username: `ui-master-${RUN}`, passwordHash, roleId: (await role("MASTER_ADMIN")).id } });
  const full = await prisma.adminUser.create({ data: { name: "UI Full", username: `ui-full-${RUN}`, passwordHash, roleId: (await role("FULL_ADMIN")).id } });
  const exams = await prisma.exam.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, take: 2, select: { id: true, name: true } });
  if (exams.length < 2) throw new Error("need two active exams in the scratch DB");
  const mob = `+9197${String(Date.now()).slice(-7)}`;
  const mk = async (name: string, i: number, examIds: string[]) => {
    const s = await prisma.student.create({
      data: { studentId: await nextStudentId(), name: `${name} ${RUN}`, mobile: `${mob}${i}`, email: `${name.toLowerCase()}.${RUN}@example.com`, authProvider: "CREDENTIALS", passwordHash: "x" },
    });
    for (const examId of examIds) await prisma.studentExamEnrollment.create({ data: { studentId: s.id, examId } });
    return { id: s.id, code: s.studentId, name: s.name, mobile: s.mobile };
  };
  const a = await mk("Uiasha", 1, [exams[0].id]);
  const b = await mk("Uibina", 2, [exams[1].id]);
  const c = await mk("Uichetan", 3, [exams[0].id, exams[1].id]);
  console.log(
    JSON.stringify({
      run: RUN,
      password,
      master: { username: master.username },
      full: { username: full.username },
      exams,
      students: { a, b, c },
      studentIds: [a.id, b.id, c.id],
    })
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
