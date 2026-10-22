/**
 * Fixture for scripts/verify-seo-intel-http.mjs: synthetic admins (two Master
 * Admins, one Full Admin, one Teacher) and a fake student Google login config
 * in a DISPOSABLE database. Prints the credentials as JSON.
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/seo-intel-fixture.ts setup > fixture.json
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/seo-intel-fixture.ts reset-seo
 *
 * Needs the roles from prisma/seed.ts. Refuses to run against the production database.
 */
import argon2 from "argon2";
import type { RoleName } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/secret-cipher";

const url = process.env.DATABASE_URL ?? "";
if (!/seointel/.test(url) || /\/mocktestseries(\?|$)/.test(url)) {
  console.error("Refusing to run: DATABASE_URL must be a scratch database whose name contains 'seointel'.");
  process.exit(2);
}

const ADMINS: { username: string; name: string; role: RoleName; password: string }[] = [
  { username: "qa-seo-master", name: "QA SEO Master", role: "MASTER_ADMIN", password: "QaSeoMaster!2345" },
  { username: "qa-seo-master2", name: "QA SEO Master Two", role: "MASTER_ADMIN", password: "QaSeoMaster2!2345" },
  { username: "qa-seo-full", name: "QA SEO Full", role: "FULL_ADMIN", password: "QaSeoFull!2345" },
  { username: "qa-seo-teacher", name: "QA SEO Teacher", role: "TEACHER", password: "QaSeoTeacher!2345" },
];

/** A student "Sign in with Google" config that the SEO connection must never read or change. */
export const STUDENT_GOOGLE = { clientId: "999999999999-studentloginclientxyz.apps.googleusercontent.com", secret: "GOCSPX-studentLoginSecret-zzzz" };

async function resetSeo() {
  await prisma.setting.deleteMany({ where: { key: { in: ["seo.google.oauth", "seo.intel.snapshot", "seo.intel.sync-lock"] } } });
}

async function main() {
  const mode = process.argv[2];
  if (mode === "reset-seo") return resetSeo();
  if (mode !== "setup") throw new Error("usage: seo-intel-fixture.ts setup|reset-seo");
  await resetSeo();
  const out: Record<string, { username: string; password: string; id: string }> = {};
  for (const a of ADMINS) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: a.role } });
    const passwordHash = await argon2.hash(a.password);
    const user = await prisma.adminUser.upsert({
      where: { username: a.username },
      create: { username: a.username, name: a.name, passwordHash, roleId: role.id, isActive: true },
      update: { name: a.name, passwordHash, roleId: role.id, isActive: true, sessionsValidAfter: null },
    });
    out[a.role === "MASTER_ADMIN" ? (out.master ? "master2" : "master") : a.role === "FULL_ADMIN" ? "full" : "teacher"] = {
      username: a.username,
      password: a.password,
      id: user.id,
    };
  }
  await prisma.loginAttempt.deleteMany({});
  const providers = { google: { enabled: true, clientId: STUDENT_GOOGLE.clientId, clientSecretCipher: encryptSecret(STUDENT_GOOGLE.secret) } };
  await prisma.setting.upsert({ where: { key: "auth.providers" }, create: { key: "auth.providers", value: providers }, update: { value: providers } });
  console.log(JSON.stringify({ admins: out, studentGoogle: STUDENT_GOOGLE }));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
