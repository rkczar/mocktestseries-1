/**
 * Verifies the student account-deletion lifecycle (lib/student-lifecycle.ts):
 * one pending request, reject -> active, concurrent approval executes once,
 * the retained deletion audit record (real name/code/email/phone, never a
 * credential) survives anonymization and is immutable once closed, email/
 * phone/Google released for a NEW account, legacy stale Google links no
 * longer resolve to a DELETED student, SUSPENDED stays blocked, nothing is
 * re-attached to the new account, a second delete/re-register cycle gets
 * its own independent record, and approve is MASTER_ADMIN-only.
 *
 * DESTRUCTIVE (approves deletions) — refuses to run unless DATABASE_URL
 * points at a local database whose name contains "test". Session revocation
 * over HTTP was verified separately against a dev server on the same DB.
 * Run with:
 *   DATABASE_URL=postgresql://...@127.0.0.1:<port>/<name>_test  *     npx tsx --conditions react-server scripts/verify-account-deletion.ts
 */
import assert from "node:assert/strict";

async function main() {
const url = process.env.DATABASE_URL ?? "";
if (!/@(127\.0\.0\.1|localhost)(:\d+)?\/[^?]*test/.test(url)) {
  throw new Error("Refusing to run: DATABASE_URL must be a local *test* database (this script approves deletions).");
}
const { prisma } = await import("@/lib/prisma");
const L = await import("@/lib/student-lifecycle");
const H = await import("@/lib/deletion-history");
const { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } = await import("@/lib/permissions");
const { nextStudentId } = await import("@/lib/student-id");

const results: [string, boolean, string?][] = [];
async function t(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push([name, true]); } catch (e) { results.push([name, false, String((e as Error).message)]); }
}
const role = await prisma.role.upsert({ where: { name: "MASTER_ADMIN" }, update: {}, create: { name: "MASTER_ADMIN" } });
const adminRow = await prisma.adminUser.create({ data: { name: "Master Tester", username: "verify-deletion-" + Date.now(), passwordHash: "x", roleId: role.id } });
const admin = { id: adminRow.id, name: "Master Tester" };
const RUN = Date.now();
const EMAIL = `ramesh.${RUN}@example.com`, MOBILE = `+9198765${String(RUN).slice(-3)}21`, GOOGLE_ID = `g-ramesh-${RUN}`;

// Disposable student with Google link, activity, login attempts, entitlement.
const code = await nextStudentId();
const old = await prisma.student.create({
  data: { studentId: code, name: "Ramesh Kumar", email: EMAIL, mobile: MOBILE, passwordHash: "argon-hash", authProvider: "CREDENTIALS" },
});
await prisma.studentProfile.create({ data: { studentId: old.id, bio: "private bio", photoUrl: "https://x/p.jpg" } });
await prisma.studentOAuthAccount.create({ data: { studentId: old.id, provider: "GOOGLE", providerAccountId: GOOGLE_ID, email: EMAIL } });
await prisma.studentLoginAttempt.create({ data: { studentId: old.id, identifier: EMAIL, ipAddress: "1.1.1.1", success: true, method: "PASSWORD" } });
await prisma.studentActivity.create({ data: { studentId: old.id, activity: "LOGIN" } });
const product = await prisma.product.create({ data: { code: "VERIFY-DEL-" + Date.now(), name: "Test Product", productType: "TEST_SERIES" } as never }).catch(async (e) => {
  console.log("product create skipped:", String(e.message).split("\n").slice(-2).join(" ")); return null;
});
if (product) await prisma.studentEntitlement.create({ data: { studentId: old.id, productId: product.id, source: "ADMIN_GRANT", startsAt: new Date() } as never });

let firstReq: { id: string };
await t("A request -> PENDING + full audit snapshot", async () => {
  firstReq = await L.createDeletionRequest(old.id, "No longer using account");
  const r = await prisma.deletionRequest.findUniqueOrThrow({ where: { id: firstReq.id } });
  assert.equal(r.status, "PENDING");
  assert.equal(r.emailMaskedSnapshot, "ra***@example.com");
  assert.equal(r.phoneMaskedSnapshot, "98******21");
  assert.equal(r.studentNameSnapshot, "Ramesh Kumar");
  assert.equal(r.emailSnapshot, EMAIL); assert.equal(r.phoneSnapshot, MOBILE);
  assert.deepEqual(r.authMethodsSnapshot, ["CREDENTIALS", "GOOGLE"]);
  assert.equal(r.studentDbIdSnapshot, old.id);
  assert.equal(r.studentCreatedAtSnapshot?.getTime(), old.createdAt.getTime());
  assert.equal((await prisma.student.findUniqueOrThrow({ where: { id: old.id } })).status, "DELETION_REQUESTED");
});
await t("B second pending rejected (sequential + concurrent)", async () => {
  await assert.rejects(L.createDeletionRequest(old.id, "again"), L.DeletionLifecycleError);
  const outs = await Promise.allSettled([L.createDeletionRequest(old.id, "x"), L.createDeletionRequest(old.id, "y")]);
  assert.equal(outs.filter((o) => o.status === "fulfilled").length, 0);
  assert.equal(await prisma.deletionRequest.count({ where: { studentId: old.id, status: "PENDING" } }), 1);
});
await t("pending account still auth-eligible", async () => {
  assert.equal(L.isStudentAuthEligible(await L.getStudentAuthStatus(old.id)), true);
});
await t("C reject -> ACTIVE", async () => {
  await L.rejectStudentDeletion(firstReq.id, admin);
  assert.equal((await prisma.student.findUniqueOrThrow({ where: { id: old.id } })).status, "ACTIVE");
  await assert.rejects(L.rejectStudentDeletion(firstReq.id, admin), L.DeletionLifecycleError);
});
let secondReq: { id: string };
await t("D request again after rejection allowed", async () => {
  secondReq = await L.createDeletionRequest(old.id, "Still want deletion");
});
await t("E+S approve: concurrent double approval executes once", async () => {
  const outs = await Promise.allSettled([L.approveStudentDeletion(secondReq.id, admin), L.approveStudentDeletion(secondReq.id, admin)]);
  assert.equal(outs.filter((o) => o.status === "fulfilled").length, 1, JSON.stringify(outs.map((o) => o.status)));
  const s = await prisma.student.findUniqueOrThrow({ where: { id: old.id }, include: { profile: true, oauthAccounts: true } });
  assert.equal(s.status, "DELETED");
  assert.equal(s.email, null); assert.equal(s.mobile, null); assert.equal(s.passwordHash, null);
  assert.equal(s.name, "Deleted Student");
  assert.equal(s.profile?.bio, null); assert.equal(s.profile?.photoUrl, null);
  assert.equal(s.oauthAccounts.length, 0);
  const la = await prisma.studentLoginAttempt.findMany({ where: { studentId: old.id } });
  assert.ok(la.every((a) => a.identifier === `deleted:${code}`));
  const audits = await prisma.auditLog.findMany({ where: { OR: [{ entityId: secondReq.id }, { entityId: old.id }] } });
  const acts = audits.map((a) => a.action).sort();
  assert.deepEqual(acts.filter((a) => a !== "STUDENT_DELETION_REQUESTED"), ["STUDENT_AUTH_REVOKED", "STUDENT_DELETION_APPROVED", "STUDENT_IDENTITY_ANONYMIZED"]);
  assert.ok(!JSON.stringify(audits).includes(EMAIL) && !JSON.stringify(audits).includes("argon"));
});
await t("F/G old session identity no longer auth-eligible", async () => {
  assert.equal(L.isStudentAuthEligible(await L.getStudentAuthStatus(old.id)), false);
  assert.equal(L.isStudentAuthEligible(await L.getStudentAuthStatus("does-not-exist")), false);
});
await t("H deleted identity cannot file another request", async () => {
  await assert.rejects(L.createDeletionRequest(old.id, "again"), L.DeletionLifecycleError);
});
let approvedRecordBefore = "";
await t("4-11 audit record survives anonymization with real identity", async () => {
  const r = await prisma.deletionRequest.findUniqueOrThrow({ where: { id: secondReq.id } });
  assert.equal(r.status, "APPROVED");
  assert.equal(r.studentNameSnapshot, "Ramesh Kumar"); assert.equal(r.studentCodeSnapshot, code);
  assert.equal(r.emailSnapshot, EMAIL); assert.equal(r.phoneSnapshot, MOBILE);
  assert.equal(r.reason, "Still want deletion");
  assert.ok(r.requestedAt && r.reviewedAt);
  assert.equal(r.reviewedByAdminNameSnapshot, "Master Tester"); assert.equal(r.reviewedByAdminId, admin.id);
  approvedRecordBefore = JSON.stringify(r);
  // What the Admin page renders (lib/deletion-history.ts) — never "Deleted Student".
  const listed = (await H.listDeletionRecords()).find((x) => x.id === secondReq.id)!;
  assert.equal(listed.name, "Ramesh Kumar"); assert.equal(listed.email, EMAIL); assert.equal(listed.phone, MOBILE);
  assert.equal(listed.reviewer, "Master Tester");
});
await t("18 no password/hash/OTP/token in the audit record or audit log", async () => {
  const r = await prisma.deletionRequest.findUniqueOrThrow({ where: { id: secondReq.id } });
  const raw = JSON.stringify(r);
  assert.ok(!raw.includes("argon") && !/password|token|otp|secret/i.test(Object.keys(r).join(",")), raw);
  const audits = await prisma.auditLog.findMany({ where: { OR: [{ entityId: secondReq.id }, { entityId: old.id }] } });
  assert.ok(!JSON.stringify(audits).includes("argon"));
});
await t("closed record is immutable (update + delete refused by DB trigger)", async () => {
  await assert.rejects(prisma.deletionRequest.update({ where: { id: secondReq.id }, data: { emailSnapshot: "x@y.z" } }), /closed audit record/);
  await assert.rejects(prisma.deletionRequest.update({ where: { id: secondReq.id }, data: { status: "PENDING" } }), /closed audit record/);
  await assert.rejects(prisma.deletionRequest.delete({ where: { id: secondReq.id } }), /cannot be deleted/);
  await assert.rejects(prisma.deletionRequest.update({ where: { id: firstReq.id }, data: { reason: "edited" } }), /closed audit record/);
  assert.equal(JSON.stringify(await prisma.deletionRequest.findUniqueOrThrow({ where: { id: secondReq.id } })), approvedRecordBefore);
});
await t("detail outcome: inactive, auth revoked, history retained", async () => {
  const d = (await H.getDeletionRecordDetail(secondReq.id))!;
  assert.equal(d.outcome.activeAccount, false); assert.equal(d.outcome.authRevoked, true);
  if (product) assert.equal(d.outcome.entitlementsRetained, 1);
});
let googleNew: { id: string; studentId: string } | undefined;
await t("I Google re-registration -> NEW account", async () => {
  const res = await L.resolveGoogleStudent({ providerAccountId: GOOGLE_ID, email: EMAIL, name: "Ramesh Kumar", picture: null });
  assert.ok(res && res.created);
  googleNew = res!.student;
  assert.notEqual(googleNew.id, old.id); assert.notEqual(googleNew.studentId, code);
  assert.ok(L.isStudentAuthEligible(res!.student.status));
});
await t("I' legacy stale Google link (pre-fix approval) -> NEW account, not AccessDenied", async () => {
  const dead = await prisma.student.create({ data: { studentId: await nextStudentId(), name: "Deleted Student", authProvider: "GOOGLE", status: "DELETED" } });
  await prisma.studentOAuthAccount.create({ data: { studentId: dead.id, provider: "GOOGLE", providerAccountId: `g-legacy-${RUN}`, email: `ann.${RUN}@example.com` } });
  const res = await L.resolveGoogleStudent({ providerAccountId: `g-legacy-${RUN}`, email: `ann.${RUN}@example.com`, name: "Ann", picture: null });
  assert.ok(res && res.created && res.student.id !== dead.id);
  assert.equal(await prisma.studentOAuthAccount.count({ where: { studentId: dead.id } }), 0);
});
await t("SUSPENDED Google account stays blocked (deletion != ban, ban != released)", async () => {
  const sus = await prisma.student.create({ data: { studentId: await nextStudentId(), name: "Sus", email: `sus.${RUN}@example.com`, authProvider: "GOOGLE", status: "SUSPENDED" } });
  await prisma.studentOAuthAccount.create({ data: { studentId: sus.id, provider: "GOOGLE", providerAccountId: `g-sus-${RUN}`, email: `sus.${RUN}@example.com` } });
  const res = await L.resolveGoogleStudent({ providerAccountId: `g-sus-${RUN}`, email: `sus.${RUN}@example.com`, name: null, picture: null });
  assert.equal(res?.student.id, sus.id); assert.equal(L.isStudentAuthEligible(res?.student.status), false);
});
await t("J/K email+phone released for password/OTP registration (registration guards find nothing)", async () => {
  // Password registration's duplicate guard (app/login/actions.ts) is OR(email,mobile);
  // the Google account above took the email, so check the phone-only + a fresh email path,
  // and that no DELETED row still owns either identifier.
  assert.equal(await prisma.student.count({ where: { status: "DELETED", OR: [{ email: EMAIL }, { mobile: MOBILE }] } }), 0);
  assert.equal(await prisma.student.findUnique({ where: { mobile: MOBILE } }), null); // OTP register guard
  const phoneNew = await prisma.student.create({ data: { studentId: await nextStudentId(), name: "Ramesh OTP", mobile: MOBILE, authProvider: "OTP" } });
  assert.notEqual(phoneNew.id, old.id);
});
await t("L/M/N new accounts own nothing from the old one; old history retained", async () => {
  const ids = [googleNew!.id];
  for (const id of ids) {
    const c = await prisma.student.findUniqueOrThrow({ where: { id }, select: { _count: { select: { testAttempts: true, entitlements: true, paymentOrders: true, payments: true, invoices: true, savedQuestions: true } } } });
    assert.ok(Object.values(c._count).every((n) => n === 0), JSON.stringify(c._count));
  }
  assert.equal(await prisma.studentActivity.count({ where: { studentId: old.id, activity: "LOGIN" } }), 1);
  if (product) assert.equal(await prisma.studentEntitlement.count({ where: { studentId: old.id } }), 1);
});
await t("12 audit record never makes the email 'occupied' (auth reads Student only)", async () => {
  // The retained record holds EMAIL, yet the password-registration duplicate
  // guard only consults Student — which no longer has it on a DELETED row.
  assert.equal(await prisma.deletionRequest.count({ where: { emailSnapshot: EMAIL } }) >= 1, true);
  assert.equal(await prisma.student.count({ where: { status: "DELETED", email: EMAIL } }), 0);
});
await t("15-17 + multi-cycle: re-registered account deleted again -> 2nd independent record", async () => {
  const again = await L.createDeletionRequest(googleNew!.id, "Deleting again");
  await L.approveStudentDeletion(again.id, admin);
  const both = await prisma.deletionRequest.findMany({ where: { emailSnapshot: EMAIL, status: "APPROVED" }, orderBy: { requestedAt: "asc" } });
  assert.equal(both.length, 2);
  assert.deepEqual(both.map((b) => b.studentCodeSnapshot), [code, googleNew!.studentId]);
  assert.notEqual(both[0].studentDbIdSnapshot, both[1].studentDbIdSnapshot);
  assert.deepEqual(both[1].authMethodsSnapshot, ["GOOGLE"]);
  assert.equal(JSON.stringify(await prisma.deletionRequest.findUniqueOrThrow({ where: { id: secondReq.id } })), approvedRecordBefore);
  // And the same Google identity can come back a third time as yet another account.
  const third = await L.resolveGoogleStudent({ providerAccountId: GOOGLE_ID, email: EMAIL, name: "Ramesh Kumar", picture: null });
  assert.ok(third?.created && third.student.id !== old.id && third.student.id !== googleNew!.id);
});
await t("record outlives a hard-deleted Student row (FK SET NULL)", async () => {
  const tmp = await prisma.student.create({ data: { studentId: await nextStudentId(), name: "Temp Tina", email: `tina.${RUN}@example.com`, authProvider: "CREDENTIALS" } });
  const req = await L.createDeletionRequest(tmp.id, "tmp");
  await L.approveStudentDeletion(req.id, admin);
  await prisma.student.delete({ where: { id: tmp.id } });
  const r = await prisma.deletionRequest.findUniqueOrThrow({ where: { id: req.id } });
  assert.equal(r.studentId, null); assert.equal(r.studentNameSnapshot, "Temp Tina"); assert.equal(r.studentDbIdSnapshot, tmp.id);
  assert.equal((await H.listDeletionRecords()).find((x) => x.id === req.id)?.email, `tina.${RUN}@example.com`);
});
await t("Deleted Students: one full, unmasked entry per deleted account", async () => {
  const deleted = (await H.listDeletedStudentRecords()).filter((x) => x.email === EMAIL || x.phone === MOBILE);
  assert.ok(deleted.length >= 2, "each delete/re-register cycle is its own entry");
  assert.ok(deleted.every((x) => x.status === "APPROVED" && !x.identityUnavailable && !x.contactMaskedOnly));
  assert.ok(!deleted.some((x) => x.id === firstReq.id), "rejected request is not a deleted account");
  const first = deleted.find((x) => x.id === secondReq.id)!;
  assert.equal(first.name, "Ramesh Kumar"); assert.equal(first.code, code);
  assert.equal(first.email, EMAIL); assert.equal(first.phone, MOBILE);
  assert.equal(first.reviewer, "Master Tester"); assert.ok(first.reviewedAt);
  if (product) assert.deepEqual(first.purchasedProducts, ["Test Product"]);
  assert.deepEqual(first.authMethods, ["CREDENTIALS", "GOOGLE"]);
});
await t("P/Q/R RBAC: FULL_ADMIN lacks approve key, MASTER_ADMIN has it", async () => {
  assert.equal(DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.STUDENT_DELETION_MANAGE), false);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.STUDENTS_MANAGE), true);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.STUDENT_DELETION_MANAGE), true);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.STUDENT_DELETION_VIEW), true);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.STUDENT_DELETION_VIEW), true);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.TEACHER.includes(PERMISSIONS.STUDENT_DELETION_VIEW), false);
});

for (const [n, ok, err] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${n}${err ? "  -> " + err : ""}`);
await prisma.$disconnect();
process.exit(results.every((r) => r[1]) ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
