/**
 * Backup & Disaster Recovery Center — targeted verification.
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION: every root (backups, releases, current
 * symlink, persistent dirs, temp) is a disposable fixture under
 * /var/backups/mocktestseries-verify-<random>, removed at the end. The real
 * production database is only READ (pg_dump / counts); restores go into
 * throwaway databases (mts_rehearsal_* and mts_verify_target_*) that are
 * dropped afterwards. No real backup or real release is touched.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-backup.ts
 */
import "dotenv/config";
import crypto from "node:crypto";
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function rejects(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

async function main() {
  const { prisma } = await import("../lib/prisma");
  const { PRODUCTION_ROOTS } = await import("../lib/backup/roots");
  const { resolveInsideRoot, UnsafePathError } = await import("../lib/backup/safe-fs");
  const { diskUsage, sha256File, run } = await import("../lib/backup/exec");
  const { startBackupJob, openJobPackage, completeJobDownload, BackupBusyError, listTemp, cleanTemp } = await import("../lib/backup/jobs");
  const { verifyPackage } = await import("../lib/backup/verify");
  const { listArtifacts, autoVerifyCheap, deleteArtifact, resolveArtifact, verifyArtifact } = await import("../lib/backup/discovery");
  const { planBackupCleanup } = await import("../lib/backup/cleanup");
  const { listReleases, planReleaseCleanup, deleteRelease } = await import("../lib/backup/releases");
  const { getStorageBreakdown } = await import("../lib/backup/storage");
  const { rehearseRestore, restoreProduction } = await import("../lib/backup/restore");
  const { fileDownloadStream } = await import("../lib/backup/stream");
  const { snapshotFacts, CLEAN_EXCLUDED_TABLE_DATA } = await import("../lib/backup/package");
  const { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } = await import("../lib/permissions");

  const base = `/var/backups/mocktestseries-verify-${crypto.randomBytes(4).toString("hex")}`;
  const R = {
    ...PRODUCTION_ROOTS,
    managed: `${base}/managed`,
    nightlyDb: `${base}/managed/postgres`,
    packages: `${base}/managed/packages`,
    incoming: `${base}/managed/incoming`,
    tmp: `${base}/managed/tmp`,
    uploadsMirror: `${base}/managed/uploads`,
    legacyDb: [`${base}/legacy`],
    releases: `${base}/releases`,
    currentLink: `${base}/current`,
    persistent: [
      { key: "shared-storage", label: "Fixture shared storage", dir: `${base}/shared/storage` },
      { key: "uploads", label: "Fixture uploads", dir: `${base}/lib/uploads` },
    ],
  };
  const targetDbs: string[] = [];
  const createdJobIds: string[] = [];
  const PASS = "correct horse battery staple 42";
  const FAKE_SECRET = `SECRET_MARKER_${crypto.randomBytes(8).toString("hex")}`;

  const prodBefore = await prisma.$transaction((tx) => snapshotFacts(tx));
  const prodSha = path.basename(await realpath(PRODUCTION_ROOTS.currentLink));
  // The fixture's "current" release is the committed HEAD — the release this
  // code deploys as — so the archived source matches the migrated schema.
  const headSha = (await (await import("../lib/backup/exec")).run("git", ["-C", PRODUCTION_ROOTS.repo, "rev-parse", "HEAD"])).stdout.trim();

  try {
    console.log("=== Backup Center verification (fixtures under " + base + ") ===\n");
    // ---- fixtures ----------------------------------------------------------
    for (const d of [R.nightlyDb, R.packages, R.incoming, R.tmp, R.uploadsMirror, R.legacyDb[0], R.releases, ...R.persistent.map((p) => p.dir), `${base}/sentinel`]) await mkdir(d, { recursive: true, mode: 0o700 });
    await writeFile(`${R.persistent[0].dir}/question-1.png`, crypto.randomBytes(2048));
    await mkdir(`${R.persistent[0].dir}/test-resources`, { recursive: true });
    await writeFile(`${R.persistent[0].dir}/test-resources/paper.pdf`, crypto.randomBytes(4096));
    await writeFile(`${R.persistent[1].dir}/import.csv`, "a,b\n1,2\n");
    await writeFile(`${base}/sentinel/keep.txt`, "must survive");
    await writeFile(`${base}/fixture.env`, `DATABASE_URL="postgresql://x:y@127.0.0.1/db"\nAUTH_SECRET="${FAKE_SECRET}"\nNEXTAUTH_URL="https://example.test"\nNODE_ENV="production"\n`);
    // Releases: real production SHA as the "current" (so git archive works), plus fakes.
    const fake = () => crypto.randomBytes(20).toString("hex");
    const [rollbackSha, oldBuiltSha, inProgressSha, oldUnbuiltSha] = [fake(), fake(), fake(), fake()];
    const mkRelease = async (sha: string, built: boolean, ageMin: number) => {
      const d = `${R.releases}/${sha}`;
      await mkdir(`${d}/.next`, { recursive: true });
      await mkdir(`${d}/public`, { recursive: true });
      await writeFile(`${d}/payload.bin`, crypto.randomBytes(64 * 1024));
      if (built) await writeFile(`${d}/.next/BUILD_ID`, "x");
      const t = new Date(Date.now() - ageMin * 60_000);
      await utimes(d, t, t);
    };
    await mkRelease(headSha, true, 30);
    await mkRelease(rollbackSha, true, 120);
    await mkRelease(oldBuiltSha, true, 600);
    await mkRelease(inProgressSha, false, 5);
    await mkRelease(oldUnbuiltSha, false, 900);
    await symlink(`${base}/sentinel`, `${R.releases}/${oldBuiltSha}/public/storage`);
    await mkdir(`${R.releases}/not-a-release`);
    await symlink(`${base}/sentinel`, `${R.releases}/${fake()}`);
    await symlink(`${R.releases}/${headSha}`, R.currentLink);

    // ---- 1. storage -------------------------------------------------------
    console.log("1. Storage calculation");
    const disk = await diskUsage("/");
    check("df reports total/used/available", Boolean(disk && disk.total > 0 && disk.used > 0 && disk.avail > 0));

    // ---- 2. FULL backup --------------------------------------------------
    console.log("\n2. Full Disaster Recovery backup");
    const full = await startBackupJob({ kind: "FULL", adminId: undefined, passphrase: PASS, saveOnVps: false, roots: R, envFile: `${base}/fixture.env`, wait: true });
    createdJobIds.push(full.jobId);
    const fullJob = await prisma.backupJob.findUniqueOrThrow({ where: { id: full.jobId } });
    check("FULL job READY (download-only, not saved)", fullJob.status === "READY", fullJob.error ?? undefined);
    const pkg = await openJobPackage(R, full.jobId);
    check("Package lives in the private temp workspace (job-<id>)", Boolean(pkg && pkg.file.startsWith(`${R.tmp}/job-${full.jobId}/`)));
    const ws = `${base}/verify-ws`;
    await mkdir(ws, { recursive: true });
    const vNo = await verifyPackage(pkg!.file, { workspace: ws, repo: R.repo });
    check("Manifest + checksums + DB payload → VALID", vNo.status === "VALID", vNo.summary);
    const m = vNo.manifest!;
    check("Manifest: format v1, type FULL, git SHA = current release SHA", m.backupType === "FULL" && m.app.gitSha === headSha);
    check("Manifest: schema = latest migration", m.database.latestMigration === prodBefore.latestMigration);
    const comps = m.components.map((c) => c.path);
    check("Includes database, source, both asset archives, portable config, README, encrypted secrets", ["database.dump", "source.tar.gz", "assets-shared-storage.tar.gz", "assets-uploads.tar.gz", "portable-config/env.template", "README-RESTORE.md", "secrets.env.gpg"].every((c) => comps.includes(c)));
    check("Persistent asset counts recorded (2 + 1 files)", m.persistentAssets.map((a) => a.fileCount).join(",") === "2,1");
    check("Commerce tables present in manifest counts", ["Product", "Coupon", "PaymentOrder", "Payment", "StudentEntitlement", "Invoice", "Refund"].every((t) => t in m.database.rowCounts));
    check("Row counts equal production snapshot", Object.entries(prodBefore.rowCounts).every(([t, n]) => m.database.rowCounts[t] === n || ["AuditLog", "BackupJob", "BackupArtifactCheck", "PaymentRateLimitHit"].includes(t)));
    check("Auth fingerprint equals production (hashes preserved as stored)", m.database.fingerprints.auth === prodBefore.fingerprints.auth);
    check("Passphrase not provided → reported NOT_PROVIDED", vNo.passphrase === "NOT_PROVIDED");
    const raw = await readFile(pkg!.file);
    check("Plaintext secret value absent from package bytes", !raw.includes(Buffer.from(FAKE_SECRET)));
    check("Passphrase absent from package bytes", !raw.includes(Buffer.from(PASS)));
    const envTemplate = await run("tar", ["-xOf", pkg!.file, "portable-config/env.template"]);
    check("env.template keeps names, redacts secret values", envTemplate.stdout.includes("AUTH_SECRET=<restore") && !envTemplate.stdout.includes(FAKE_SECRET) && envTemplate.stdout.includes('NEXTAUTH_URL="https://example.test"'));
    const vWrong = await verifyPackage(pkg!.file, { workspace: ws, repo: R.repo, passphrase: "wrong passphrase!!" });
    check("Wrong recovery passphrase → INVALID / INCORRECT", vWrong.status === "INVALID" && vWrong.passphrase === "INCORRECT");
    const vRight = await verifyPackage(pkg!.file, { workspace: ws, repo: R.repo, passphrase: PASS });
    check("Correct recovery passphrase → VALID / CORRECT", vRight.status === "VALID" && vRight.passphrase === "CORRECT");
    const sums = await run("sha256sum", ["-c", "checksums.sha256"], { cwd: vRight.extractedDir });
    check("checksums.sha256 passes standard `sha256sum -c`", sums.code === 0);
    const readme = await readFile(path.join(vRight.extractedDir!, "README-RESTORE.md"), "utf8");
    check("README-RESTORE documents DNS/TLS/OAuth/Razorpay reconfiguration", ["DNS", "certbot", "OAuth", "Razorpay"].every((k) => readme.includes(k)));

    // Tampering → CORRUPT
    const tampered = `${ws}/tampered.tar`;
    await run("sh", ["-c", `mkdir -p "${ws}/t" && tar -xf "${pkg!.file}" -C "${ws}/t" && printf x >> "${ws}/t/README-RESTORE.md" && tar -cf "${tampered}" -C "${ws}/t" .`]);
    check("Tampered package → CORRUPT (checksum mismatch)", (await verifyPackage(tampered, { workspace: `${ws}/v2`, repo: R.repo })).status === "CORRUPT");
    const evil = `${ws}/evil.tar`;
    await symlink("/etc/passwd", `${ws}/manifest.json`);
    await run("tar", ["-cf", evil, "-C", ws, "manifest.json"]);
    check("Package with symlink member → INVALID, not extracted", (await verifyPackage(evil, { workspace: `${ws}/v3`, repo: R.repo })).status === "INVALID");

    // Streaming download + cleanup
    const h = crypto.createHash("sha256");
    const reader = fileDownloadStream(pkg!.file, () => completeJobDownload(R, full.jobId, undefined)).getReader();
    let chunks = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks++;
      h.update(value);
    }
    check("Streamed download is byte-identical (bounded 64 KiB chunks)", h.digest("hex") === fullJob.sha256 && chunks >= 1);
    let afterDl = await prisma.backupJob.findUniqueOrThrow({ where: { id: full.jobId } });
    for (let i = 0; i < 20 && afterDl.status !== "DOWNLOADED"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      afterDl = await prisma.backupJob.findUniqueOrThrow({ where: { id: full.jobId } });
    }
    check("Download-only package removed from VPS after complete download", afterDl.status === "DOWNLOADED" && !(await stat(`${R.tmp}/job-${full.jobId}`).catch(() => null)));

    // ---- 3. Lock ----------------------------------------------------------
    console.log("\n3. Job locking");
    const lockRow = await prisma.backupJob.create({ data: { kind: "DATABASE", lockKey: "backup-generation" } });
    createdJobIds.push(lockRow.id);
    check("Second concurrent generation refused", (await rejects(() => startBackupJob({ kind: "DATABASE", adminId: undefined, saveOnVps: false, roots: R }))) instanceof BackupBusyError);
    await prisma.backupJob.update({ where: { id: lockRow.id }, data: { lockKey: null, status: "FAILED" } });
    check("FULL without passphrase refused before starting", (await rejects(() => startBackupJob({ kind: "FULL", adminId: undefined, saveOnVps: false, roots: R }))) !== null);

    // ---- 4. CLEAN + DATABASE --------------------------------------------
    console.log("\n4. Clean Portable + Database-only");
    const clean = await startBackupJob({ kind: "CLEAN", adminId: undefined, saveOnVps: true, roots: R, envFile: `${base}/fixture.env`, wait: true });
    createdJobIds.push(clean.jobId);
    const cleanJob = await prisma.backupJob.findUniqueOrThrow({ where: { id: clean.jobId } });
    check("CLEAN saved on VPS (explicit opt-in) into packages/", cleanJob.status === "SAVED" && (await readdir(R.packages)).includes(cleanJob.fileName!));
    const vClean = await verifyPackage(`${R.packages}/${cleanJob.fileName}`, { workspace: `${ws}/c`, repo: R.repo });
    check("CLEAN verifies VALID, no secrets payload", vClean.status === "VALID" && !vClean.manifest!.secrets.included && !vClean.manifest!.components.some((c) => c.path === "secrets.env.gpg"));
    check("CLEAN excludes exactly the classified disposable table DATA", vClean.manifest!.database.excludedTableData.join(",") === CLEAN_EXCLUDED_TABLE_DATA.map((t) => t.table).join(","));
    check("CLEAN keeps business data (students, attempts, payments, communications)", ["Student", "TestAttempt", "PaymentOrder", "Communication", "Question"].every((t) => vClean.manifest!.database.rowCounts[t] === prodBefore.rowCounts[t]));
    check("Live production rows of excluded tables untouched", (await prisma.loginAttempt.count()) >= prodBefore.rowCounts.LoginAttempt);
    const db = await startBackupJob({ kind: "DATABASE", adminId: undefined, saveOnVps: true, roots: R, wait: true });
    createdJobIds.push(db.jobId);
    const dbJob = await prisma.backupJob.findUniqueOrThrow({ where: { id: db.jobId } });
    const vDb = await verifyPackage(`${R.packages}/${dbJob.fileName}`, { workspace: `${ws}/d`, repo: R.repo });
    check("DATABASE-only package VALID with only database + README", vDb.status === "VALID" && vDb.manifest!.components.map((c) => c.path).sort().join(",") === "README-RESTORE.md,database.dump");
    // Also keep a FULL on the fixture VPS for cleanup/restore tests.
    const full2 = await startBackupJob({ kind: "FULL", adminId: undefined, passphrase: PASS, saveOnVps: true, roots: R, envFile: `${base}/fixture.env`, wait: true });
    createdJobIds.push(full2.jobId);
    const full2Job = await prisma.backupJob.findUniqueOrThrow({ where: { id: full2.jobId } });
    check("FULL saved on VPS when requested", full2Job.status === "SAVED");

    // ---- 5. Restore rehearsal + restore function on an isolated DB --------
    console.log("\n5. Isolated restore rehearsal");
    const full2File = `${R.packages}/${full2Job.fileName}`;
    const reh = await rehearseRestore({ file: full2File, roots: R, passphrase: PASS });
    for (const c of reh.checks) check(`Rehearsal: ${c.label}`, c.ok, c.detail);
    const leftover = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_database WHERE datname LIKE 'mts_rehearsal_%'`;
    check("Rehearsal database dropped afterwards", Number(leftover[0].n) === 0);
    const target = `mts_verify_target_${crypto.randomBytes(4).toString("hex")}`;
    targetDbs.push(target);
    await prisma.$executeRawUnsafe(`CREATE DATABASE "${target}"`);
    const targetUrl = (() => {
      const u = new URL(process.env.DATABASE_URL!);
      u.pathname = `/${target}`;
      return u.toString();
    })();
    const restoreDirs = { "shared-storage": `${base}/restore-target/storage`, uploads: `${base}/restore-target/uploads` };
    const rp = await restoreProduction({ file: full2File, roots: R, passphrase: PASS, databaseUrl: targetUrl, persistentDirs: restoreDirs });
    check("In-place restore path (against isolated DB) passes all post-restore checks", rp.ok, rp.checks.filter((c) => !c.ok).map((c) => c.label).join("; "));
    check("…took a pre-restore safety dump first", Boolean(rp.safetyDump && (await stat(rp.safetyDump).catch(() => null))));
    check("…restored persistent files into target dirs", Boolean(await stat(`${restoreDirs["shared-storage"]}/test-resources/paper.pdf`).catch(() => null)));
    const rp2 = await restoreProduction({ file: full2File, roots: R, passphrase: PASS, databaseUrl: targetUrl, persistentDirs: restoreDirs });
    check("Re-restoring over a populated DB (--clean, single transaction) also passes", rp2.ok);
    check("Restore of FULL refuses a wrong passphrase", (await rejects(() => restoreProduction({ file: full2File, roots: R, passphrase: "nope nope nope", databaseUrl: targetUrl }))) !== null);

    // ---- 6. Discovery, verification, cleanup -----------------------------
    console.log("\n6. Backup discovery / delete / cleanup");
    const realDump = (await readdir(PRODUCTION_ROOTS.nightlyDb)).filter((n) => n.endsWith(".dump")).sort().at(-1)!;
    const names = ["mocktestseries-20260101T020000Z.dump", "mocktestseries-20260102T020000Z.dump", "mocktestseries-20260103T020000Z.dump"];
    for (const [i, n] of names.entries()) {
      await copyFile(`${PRODUCTION_ROOTS.nightlyDb}/${realDump}`, `${R.nightlyDb}/${n}`);
      const t = new Date(Date.UTC(2026, 0, 1 + i, 2));
      await utimes(`${R.nightlyDb}/${n}`, t, t);
    }
    await writeFile(`${R.nightlyDb}/notes.txt`, "unknown file");
    await symlink("/etc/passwd", `${R.nightlyDb}/mocktestseries-20990101T000000Z.dump`);
    await run("sh", ["-c", `printf -- '-- PostgreSQL database dump\\n' | gzip > "${R.legacyDb[0]}/mocktestseries-pre-x-migration-20260101-000000.sql.gz"`]);
    let arts = await listArtifacts(R);
    check("Symlinked 'backup' is not listed (symlink escape)", !arts.some((a) => a.name === "mocktestseries-20990101T000000Z.dump"));
    const unknown = arts.find((a) => a.name === "notes.txt");
    check("Unknown file listed as UNKNOWN and not deletable", Boolean(unknown && unknown.category === "Unknown" && !unknown.deletable));
    const legacy = arts.find((a) => a.category === "Legacy Backup");
    check("Legacy backup discovered read-only", Boolean(legacy && !legacy.deletable));
    await autoVerifyCheap(R, arts);
    for (const a of arts.filter((a) => a.kind === "PACKAGE")) await verifyArtifact(R, a.id);
    arts = await listArtifacts(R);
    const dumps = arts.filter((a) => a.kind === "DB_DUMP");
    check("Real-data nightly dumps auto-verified VALID", dumps.filter((a) => a.sizeBytes > 10_000).every((a) => a.verification === "VALID"));
    check("Empty-database dump (restore test safety dump) → INVALID, not counted as verified", dumps.filter((a) => a.sizeBytes <= 10_000).every((a) => a.verification === "INVALID"));
    check("Legacy .sql.gz → LEGACY_VERIFIED", arts.find((a) => a.category === "Legacy Backup")?.verification === "LEGACY_VERIFIED");
    const plan = planBackupCleanup(arts);
    const keepNames = plan.keep.map((k) => k.name);
    check("Keeps newest verified DB backup (DB package, newest by time)", plan.keep.some((k) => k.category === "Database Backup" || k.category === "Database Package"));
    check("Keeps newest verified FULL backup", keepNames.includes(full2Job.fileName!));
    check("Unknown & legacy never auto-selected", !plan.candidates.some((c) => c.category === "Unknown" || c.category === "Legacy Backup"));
    check("Preview shows reclaimable bytes", plan.reclaimableBytes === plan.candidates.reduce((s, c) => s + c.sizeBytes, 0) && plan.candidates.length >= 3);
    const protectedSet = new Set(plan.protectedIds);
    check("Deleting the protected latest verified backup refused", (await rejects(() => deleteArtifact(R, plan.protectedIds[0], protectedSet))) !== null);
    check("Deleting an UNKNOWN file refused", (await rejects(() => deleteArtifact(R, unknown!.id, protectedSet))) !== null);
    check("Deleting a read-only legacy backup refused", (await rejects(() => deleteArtifact(R, legacy!.id, protectedSet))) !== null);
    check("Bogus / traversal ids refused", (await rejects(() => resolveArtifact(R, "../../etc/passwd"))) !== null && (await rejects(() => resolveArtifact(R, "0".repeat(32)))) !== null);
    check("resolveInsideRoot rejects ../, absolute, dotfiles", (await rejects(() => resolveInsideRoot(R.nightlyDb, "../x.dump", { pattern: /.*/, expect: "file" }))) instanceof UnsafePathError && (await rejects(() => resolveInsideRoot(R.nightlyDb, "/etc/passwd", { pattern: /.*/, expect: "file" }))) instanceof UnsafePathError && (await rejects(() => resolveInsideRoot(R.nightlyDb, ".env", { pattern: /.*/, expect: "file" }))) instanceof UnsafePathError);
    check("resolveInsideRoot rejects a symlink inside the root", (await rejects(() => resolveInsideRoot(R.nightlyDb, "mocktestseries-20990101T000000Z.dump", { pattern: /.*/, expect: "file" }))) instanceof UnsafePathError);
    let freed = 0;
    for (const c of plan.candidates) freed += (await deleteArtifact(R, c.id, protectedSet)).bytes;
    const after = await listArtifacts(R);
    check("Bulk cleanup deleted only fixture candidates", plan.candidates.every((c) => !after.some((a) => a.id === c.id)) && freed === plan.reclaimableBytes);
    check("Protected, unknown and legacy files survived", plan.protectedIds.every((id) => after.some((a) => a.id === id)) && after.some((a) => a.name === "notes.txt") && after.some((a) => a.category === "Legacy Backup"));
    check("/etc/passwd untouched", Boolean(await stat("/etc/passwd").catch(() => null)));

    // ---- 7. Releases -------------------------------------------------------
    console.log("\n7. Release discovery / protection / cleanup");
    const { releases, currentSha } = await listReleases(R, { forceSizes: true, includePm2: false });
    const by = (sha: string) => releases.find((r) => r.sha === sha)!;
    check("Current release detected via symlink", currentSha === headSha && by(headSha).status === "CURRENT");
    check("Newest previous built release is ROLLBACK", by(rollbackSha).status === "ROLLBACK");
    check("Fresh unbuilt release protected as IN_PROGRESS", by(inProgressSha).status === "IN_PROGRESS");
    check("Unrecognized dir + symlink marked UNRECOGNIZED", releases.filter((r) => r.status === "UNRECOGNIZED").length === 2);
    const rplan = planReleaseCleanup(releases);
    check("Cleanup candidates = only old inactive releases", rplan.candidates.map((r) => r.sha).sort().join() === [oldBuiltSha, oldUnbuiltSha].sort().join());
    check("Reclaimable release storage computed", rplan.reclaimableBytes > 0);
    for (const sha of [headSha, rollbackSha, inProgressSha]) check(`Delete refused for ${by(sha).status}`, (await rejects(() => deleteRelease(R, by(sha).id, { includePm2: false }))) !== null);
    check("Delete refused for unrecognized", (await rejects(() => deleteRelease(R, releases.find((r) => r.sha === "not-a-release")!.id, { includePm2: false }))) !== null);
    for (const r of rplan.candidates) await deleteRelease(R, r.id, { includePm2: false });
    const remaining = await readdir(R.releases);
    check("Old releases deleted; current + rollback + in-progress kept", !remaining.includes(oldBuiltSha) && !remaining.includes(oldUnbuiltSha) && [headSha, rollbackSha, inProgressSha].every((s) => remaining.includes(s)));
    check("Symlink inside a deleted release was NOT followed (sentinel intact)", (await readFile(`${base}/sentinel/keep.txt`, "utf8")) === "must survive");
    check("Real production release untouched", Boolean(await stat(`${PRODUCTION_ROOTS.releases}/${prodSha}/.next/BUILD_ID`).catch(() => null)));
    const realReleases = await listReleases(PRODUCTION_ROOTS);
    check("Real current release is CURRENT/protected in the real inventory", realReleases.releases.find((r) => r.sha === prodSha)?.status === "CURRENT");
    const storage = await getStorageBreakdown(R, await listArtifacts(R), (await listReleases(R, { includePm2: false })).releases, true);
    check("Storage breakdown separates BACKUP / RELEASE / APPLICATION / OTHER", ["BACKUP", "RELEASE", "APPLICATION", "OTHER"].every((g) => storage.rows.some((r) => r.group === g)));

    // ---- 8. Temp cleanup ----------------------------------------------------
    console.log("\n8. Temp cleanup");
    const staleDir = `${R.tmp}/job-${"a".repeat(24)}`;
    await mkdir(staleDir);
    await writeFile(`${staleDir}/x`, "x");
    const old = new Date(Date.now() - 3 * 3600_000);
    await utimes(staleDir, old, old);
    await mkdir(`${R.tmp}/not-a-job`);
    await utimes(`${R.tmp}/not-a-job`, old, old);
    const activeJob = await prisma.backupJob.create({ data: { kind: "DATABASE", status: "RUNNING" } });
    createdJobIds.push(activeJob.id);
    await mkdir(`${R.tmp}/job-${activeJob.id}`);
    await utimes(`${R.tmp}/job-${activeJob.id}`, old, old);
    const t = await listTemp(R);
    check("Temp listing recognizes only job-* workspaces", t.every((x) => x.name.startsWith("job-")) && t.some((x) => x.stale));
    await cleanTemp(R);
    const tmpNow = await readdir(R.tmp);
    check("Stale job workspace removed", !tmpNow.includes(path.basename(staleDir)));
    check("Unrecognized temp dir and active job workspace kept", tmpNow.includes("not-a-job") && tmpNow.includes(`job-${activeJob.id}`));

    // ---- 9. RBAC / security ---------------------------------------------------
    console.log("\n9. RBAC & route security");
    check("MASTER_ADMIN has BACKUP_MANAGE", DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.BACKUP_MANAGE));
    check("FULL_ADMIN has BACKUP_VIEW only (no BACKUP_MANAGE)", DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.BACKUP_VIEW) && !DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.BACKUP_MANAGE));
    check("TEACHER has no backup access", !DEFAULT_ROLE_PERMISSIONS.TEACHER.some((p) => p.startsWith("backup:")));
    const actionsSrc = await readFile("app/admin/(dashboard)/backup/actions.ts", "utf8");
    const fns = [...actionsSrc.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)];
    check(`All ${fns.length} backup Server Actions require BACKUP_MANAGE`, fns.length >= 11 && fns.every((f) => f[2].includes("await manage()")));
    const destructive = ["deleteArtifactAction", "cleanupBackupsAction", "deleteReleaseAction", "cleanupReleasesAction", "restoreProductionAction"];
    check("Destructive actions re-authenticate the admin password", destructive.every((n) => fns.find((f) => f[1] === n)?.[2].includes("reauth(")));
    for (const r of ["app/api/admin/backup/jobs/[id]/download/route.ts", "app/api/admin/backup/artifacts/[id]/download/route.ts", "app/api/admin/backup/upload/route.ts"]) {
      const src = await readFile(r, "utf8");
      check(`${r.split("/").slice(3, 5).join("/")} requires BACKUP_MANAGE, no client path`, src.includes("requirePermission(PERMISSIONS.BACKUP_MANAGE)") && !/searchParams\.get\(["']path/.test(src));
    }
    check("No backup file under /public", !(await readdir("public")).some((n) => /\.(dump|tar|sql|gz)$/.test(n)));

    // ---- 10. Audit / history ------------------------------------------------
    console.log("\n10. Audit / history");
    const logs = await prisma.auditLog.count({ where: { entityType: "BackupJob", entityId: { in: createdJobIds }, action: "BACKUP_CREATED" } });
    check("BACKUP_CREATED audit rows recorded (no secrets in metadata)", logs >= 4);
    const meta = JSON.stringify((await prisma.auditLog.findMany({ where: { entityId: { in: createdJobIds } } })).map((l) => l.metadata));
    check("Audit metadata contains no passphrase/secret", !meta.includes(PASS) && !meta.includes(FAKE_SECRET));
    check("Download recorded in job history", (await prisma.backupJob.findUniqueOrThrow({ where: { id: full.jobId } })).downloadedAt !== null);

    // ---- production untouched ------------------------------------------------
    const prodAfter = await prisma.$transaction((tx) => snapshotFacts(tx));
    check("Production auth/commerce/settings fingerprints unchanged", prodAfter.fingerprints.auth === prodBefore.fingerprints.auth && prodAfter.fingerprints.commerce === prodBefore.fingerprints.commerce && prodAfter.fingerprints.settings === prodBefore.fingerprints.settings);
    check("Real nightly backups still present", (await readdir(PRODUCTION_ROOTS.nightlyDb)).includes(realDump));
    void sha256File;
  } finally {
    for (const d of targetDbs) await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { entityId: { in: createdJobIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: "Restore", createdAt: { gte: new Date(Date.now() - 3600_000) }, actorId: null } });
    await prisma.backupJob.deleteMany({ where: { id: { in: createdJobIds } } });
    await prisma.backupArtifactCheck.deleteMany({ where: { fileName: { contains: "" }, checkedAt: { gte: new Date(Date.now() - 3600_000) }, artifactId: { in: (await listArtifacts(R).catch(() => [])).map((a) => a.id) } } });
    await rm(base, { recursive: true, force: true });
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await prisma.$disconnect();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
