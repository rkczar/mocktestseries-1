/**
 * Fixture for scripts/verify-teacher-login-http.mjs (scratch mts_* DB only).
 *   setup   → prints JSON { master: {username,password}, examX, examY, sfx }
 *   cleanup → removes the TLH- rows it created
 * Teachers themselves are created by the suite through Admin → Teachers → Add teacher.
 */
import "dotenv/config";
import crypto from "node:crypto";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";

async function main() {
  const db = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "").split("/").pop() ?? "";
  if (!/^mts_/.test(db)) throw new Error("Refusing to run outside a scratch mts_* database.");
  if (process.argv[2] === "cleanup") {
    const users = await prisma.adminUser.findMany({ where: { username: { startsWith: "tlh-" } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.loginAttempt.deleteMany({ where: { OR: [{ adminUserId: { in: ids } }, { username: { startsWith: "tlh-" } }, { username: { startsWith: "otp:" } }] } });
    await prisma.otpRequest.deleteMany({ where: { purpose: "TEACHER_LOGIN" } });
    await prisma.adminUser.deleteMany({ where: { id: { in: ids } } });
    await prisma.exam.deleteMany({ where: { code: { startsWith: "TLH" } } });
    return;
  }
  const sfx = Date.now().toString(36);
  const role = await prisma.role.upsert({ where: { name: "MASTER_ADMIN" }, create: { name: "MASTER_ADMIN" }, update: {} });
  await prisma.role.upsert({ where: { name: "TEACHER" }, create: { name: "TEACHER" }, update: {} });
  const password = crypto.randomBytes(12).toString("base64url");
  const master = await prisma.adminUser.create({ data: { name: "TLH Master", username: `tlh-master-${sfx}`, passwordHash: await argon2.hash(password), roleId: role.id } });
  const examX = await prisma.exam.create({ data: { name: `TLH Exam X ${sfx}`, code: `TLHX${sfx}`.toUpperCase(), isActive: true } });
  const examY = await prisma.exam.create({ data: { name: `TLH Exam Y ${sfx}`, code: `TLHY${sfx}`.toUpperCase(), isActive: true } });
  console.log(JSON.stringify({ sfx, master: { username: master.username, password }, examX: { id: examX.id, name: examX.name }, examY: { id: examY.id, name: examY.name } }));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
