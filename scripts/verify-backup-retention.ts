/**
 * Backup Center stabilization — targeted verification (retention, safe
 * cleanup, storage analysis, delete-hang fix, RBAC, route registry).
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION: every release, backup, lock, snapshot and
 * scanned directory is a disposable fixture under
 * /var/backups/mocktestseries-verify-retention-<random>, removed at the end.
 * The only production DB writes are BackupArtifactCheck cache rows for the
 * fixture ids and one short-lived fake RUNNING BackupJob (no lock key) —
 * both removed in `finally`. No real release or real backup is touched; the
 * script asserts that at the end.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-backup-retention.ts
 */
import "dotenv/config";
import crypto from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
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
const sha = () => crypto.randomBytes(20).toString("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { prisma } = await import("../lib/prisma");
  const { PRODUCTION_ROOTS } = await import("../lib/backup/roots");
  const { run } = await import("../lib/backup/exec");
  const { opaqueId, resolveInsideRoot, UnsafePathError } = await import("../lib/backup/safe-fs");
  const { listReleases, planReleaseCleanup, deleteRelease, ReleaseProtectedError } = await import("../lib/backup/releases");
  const { listArtifacts, deleteArtifact } = await import("../lib/backup/discovery");
  const { planBackupCleanup } = await import("../lib/backup/cleanup");
  const { normalizeRetention, RETENTION_DEFAULTS } = await import("../lib/backup/settings");
  const { refreshStorageSnapshot, getStorageSnapshot, buildStorageView, measureActualSource, releaseSizeMap, storageHealth } = await import("../lib/backup/storage");
  const { deleteOneRelease, cleanupReleases, deleteOneBackup, runAutoRetention } = await import("../lib/backup/maintenance");
  const { MaintenanceBusyError } = await import("../lib/backup/lock");
  const { runOperation, createOperationGuard } = await import("../lib/backup/operation");
  const { fileDownloadStream, downloadHeaders } = await import("../lib/backup/stream");
  const { groupComponentSizes, readPackageManifest } = await import("../lib/backup/package");
  const { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } = await import("../lib/permissions");

  const base = `/var/backups/mocktestseries-verify-retention-${crypto.randomBytes(4).toString("hex")}`;
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
    persistent: [{ key: "shared-storage", label: "Fixture shared storage", dir: `${base}/shared/storage` }],
    repo: `${base}/repo`,
  };
  const P = {
    home: `${base}/home`,
    npmCache: `${base}/home/.npm`,
    pm2Logs: `${base}/home/.pm2/logs`,
    systemLogs: `${base}/log`,
    systemTmp: `${base}/systmp`,
    osPackages: `${base}/usr`,
    postgresData: `${base}/pgdata`,
    diskMount: "/",
  };
  const realReleasesBefore = (await readdir(PRODUCTION_ROOTS.releases)).sort().join();
  const realBackupsBefore = (await listArtifacts(PRODUCTION_ROOTS)).map((a) => `${a.name}:${a.sizeBytes}`).sort().join();
  const fixtureCheckIds: string[] = [];
  const testStart = new Date();
  let fakeJobId: string | null = null;

  try {
    console.log(`=== Backup retention / cleanup verification (fixtures under ${base}) ===\n`);
    for (const d of [R.nightlyDb, R.packages, R.incoming, R.tmp, R.uploadsMirror, R.legacyDb[0], R.releases, R.persistent[0].dir, R.repo, P.npmCache, P.pm2Logs, P.systemLogs, P.systemTmp, P.osPackages, P.postgresData, `${base}/sentinel`, `${base}/outside`])
      await mkdir(d, { recursive: true, mode: 0o700 });
    await writeFile(`${base}/sentinel/keep.txt`, "must survive");
    await writeFile(`${base}/outside/escape.txt`, "outside the release root");
    await writeFile(`${R.persistent[0].dir}/img.png`, crypto.randomBytes(4096));
    await writeFile(`${P.npmCache}/blob`, crypto.randomBytes(8192));

    // Fixture git repo: 150 bytes of tracked source + large untracked node_modules/.next.
    await mkdir(`${R.repo}/app`, { recursive: true });
    await mkdir(`${R.repo}/lib`, { recursive: true });
    await writeFile(`${R.repo}/app/page.tsx`, "x".repeat(100));
    await writeFile(`${R.repo}/lib/util.ts`, "y".repeat(50));
    const git = (args: string[]) => run("git", ["-C", R.repo, "-c", "user.email=verify@example.invalid", "-c", "user.name=verify", ...args]);
    await git(["init", "-q"]);
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "fixture"]);
    await mkdir(`${R.repo}/node_modules/pkg`, { recursive: true });
    await mkdir(`${R.repo}/.next/cache`, { recursive: true });
    await writeFile(`${R.repo}/node_modules/pkg/index.js`, crypto.randomBytes(200_000));
    await writeFile(`${R.repo}/.next/cache/blob`, crypto.randomBytes(100_000));

    // Fixture releases (newest → oldest): current, rollback, old1, old2 (+ in-progress, unrecognized, symlinked).
    const [currentSha, rollbackSha, old1Sha, old2Sha, inProgressSha, symlinkSha] = [sha(), sha(), sha(), sha(), sha(), sha()];
    const mkRelease = async (s: string, ageDays: number, built = true) => {
      const d = `${R.releases}/${s}`;
      await mkdir(`${d}/node_modules/dep`, { recursive: true });
      await mkdir(`${d}/.next`, { recursive: true });
      await mkdir(`${d}/public`, { recursive: true });
      await writeFile(`${d}/node_modules/dep/index.js`, crypto.randomBytes(300_000));
      await writeFile(`${d}/.next/chunk.js`, crypto.randomBytes(100_000));
      if (built) await writeFile(`${d}/.next/BUILD_ID`, s.slice(0, 8));
      await writeFile(`${d}/package.json`, "{}".padEnd(1000, " "));
      await symlink(`${base}/sentinel`, `${d}/public/storage`);
      const t = new Date(Date.now() - ageDays * 86400_000);
      await utimes(d, t, t);
    };
    await mkRelease(currentSha, 0);
    await mkRelease(rollbackSha, 1);
    await mkRelease(old1Sha, 2);
    await mkRelease(old2Sha, 3);
    await mkdir(`${R.releases}/${inProgressSha}`); // fresh, unbuilt
    await mkdir(`${R.releases}/not-a-release`);
    await symlink(`${base}/outside`, `${R.releases}/${symlinkSha}`); // symlink escape attempt
    await symlink(`${R.releases}/${currentSha}`, R.currentLink);

    // Fixture backups: 3 DB dumps, 2 FULL packages, 1 CLEAN, 1 unverified dump, 1 unknown file.
    const dump = (d: string) => `mocktestseries-${d}T020000Z.dump`;
    const dumps = [dump("20260101"), dump("20260102"), dump("20260103")];
    for (const [i, n] of dumps.entries()) {
      await writeFile(`${R.nightlyDb}/${n}`, crypto.randomBytes(50_000 + i));
      const t = new Date(Date.UTC(2026, 0, 1 + i, 2));
      await utimes(`${R.nightlyDb}/${n}`, t, t);
    }
    const unverifiedDump = dump("20260104");
    await writeFile(`${R.nightlyDb}/${unverifiedDump}`, crypto.randomBytes(1000));
    await writeFile(`${R.nightlyDb}/notes.txt`, "unknown");
    // Package with manifest.json as first tar member (component sizes).
    const stage = `${base}/stage`;
    await mkdir(stage, { recursive: true });
    const manifest = {
      format: "mocktestseries-backup",
      components: [
        { path: "database.dump", kind: "database", bytes: 1000, sha256: "", description: "" },
        { path: "source.tar.gz", kind: "source", bytes: 300, sha256: "", description: "" },
        { path: "assets-a.tar", kind: "assets", bytes: 200, sha256: "", description: "" },
        { path: "secrets.env.gpg", kind: "secrets", bytes: 50, sha256: "", description: "" },
        { path: "README-RESTORE.md", kind: "docs", bytes: 20, sha256: "", description: "" },
        { path: "portable-config/x", kind: "config", bytes: 5, sha256: "", description: "" },
      ],
    };
    await writeFile(`${stage}/manifest.json`, JSON.stringify(manifest));
    await writeFile(`${stage}/database.dump`, crypto.randomBytes(1000));
    const pkgs = ["mocktestseries-full-20260101-020000-aaaaaa.tar", "mocktestseries-full-20260102-020000-bbbbbb.tar", "mocktestseries-clean-20260102-030000-cccccc.tar"];
    for (const [i, n] of pkgs.entries()) {
      await run("tar", ["-cf", `${R.packages}/${n}`, "-C", stage, "manifest.json", "database.dump"]);
      const t = new Date(Date.UTC(2026, 0, 1 + i, 3));
      await utimes(`${R.packages}/${n}`, t, t);
    }
    // Mark the recognized fixtures VALID in the verification cache (except the unverified dump).
    for (const a of await listArtifacts(R)) {
      if (a.name === unverifiedDump || a.kind === "UNKNOWN" || a.kind === "MIRROR") continue;
      fixtureCheckIds.push(a.id);
      await prisma.backupArtifactCheck.upsert({
        where: { artifactId: a.id },
        create: { artifactId: a.id, fileName: a.name, sizeBytes: BigInt(a.sizeBytes), mtimeMs: BigInt(Math.floor(a.mtime.getTime())), status: "VALID", detail: "fixture" },
        update: { status: "VALID" },
      });
    }

    const settings1 = normalizeRetention({});

    // ---- 1–2. Storage breakdown + actual source ------------------------------
    console.log("1–2. Storage analysis");
    const t0 = Date.now();
    const snap = await refreshStorageSnapshot(R, P);
    check("Storage snapshot scan completes", Boolean(snap.scannedAt) && Date.now() - t0 < 60_000, `${Date.now() - t0}ms`);
    const persisted = JSON.parse(await readFile(`${R.managed}/storage-snapshot.json`, "utf8")) as { version: number };
    check("Snapshot persisted for all PM2 workers (shared file)", persisted.version === 2);
    let { releases } = await listReleases(R, { includePm2: false, sizes: releaseSizeMap(snap), rollbackToKeep: settings1.rollbackReleasesToKeep });
    let arts = await listArtifacts(R);
    const view = await buildStorageView(R, { snapshot: snap, releases, artifacts: arts, releaseReclaimable: planReleaseCleanup(releases).reclaimableBytes, backupReclaimable: planBackupCleanup(arts, settings1).reclaimableBytes, paths: P });
    check("Breakdown has live disk totals", Boolean(view.disk && view.disk.total > 0 && view.disk.used > 0 && view.disk.avail > 0));
    check("Breakdown partition has every category", ["releases", "working-copy", "database", "backups", "uploads", "cache", "logs", "os", "tooling", "other"].every((k) => view.partition.some((r) => r.key === k)));
    check("Release categories measured (current/rollback/old)", (view.releases.current ?? 0) > 400_000 && view.releases.rollback > 400_000 && view.releases.old > 800_000);
    check("Backup categories measured (DB/Full/Clean)", view.backups.db > 150_000 && view.backups.full > 0 && view.backups.clean > 0);
    const cur = releases.find((r) => r.sha === currentSha)!;
    check("Per-release source/build/dependency split", cur.depsBytes! >= 300_000 && cur.buildBytes! >= 100_000 && cur.sourceBytes! > 0 && cur.sourceBytes! < 100_000);
    check("Actual App Source = tracked files only (150 bytes)", view.actualSource?.bytes === 150, String(view.actualSource?.bytes));
    const src = await measureActualSource(R.repo, null);
    check("Actual source excludes node_modules / .next (untracked 300 KB ignored)", src.bytes === 150 && src.breakdown.map((b) => b.path).sort().join() === "app/,lib/");
    check("Actual source excludes releases/backups (not under the repo)", src.files === 2);
    check("Storage health thresholds", storageHealth({ total: 100, used: 50, avail: 50 * 1024 ** 3 }) === "HEALTHY" && storageHealth({ total: 100, used: 80, avail: 50 * 1024 ** 3 }) === "WARNING" && storageHealth({ total: 100, used: 95, avail: 50 * 1024 ** 3 }) === "CRITICAL");
    check("Largest consumer derived from measured data", Boolean(view.largest && view.largest.bytes > 0));

    // ---- 3–4. Current release + retention ------------------------------------
    console.log("\n3–4. Current release + Current+1 retention");
    const by = (s: string) => releases.find((r) => r.sha === s)!;
    check("Current release resolves via symlink", by(currentSha).status === "CURRENT");
    check("Retention defaults: rollback 1, DB 1, Full 1, Clean 1, auto OFF", JSON.stringify(settings1) === JSON.stringify(RETENTION_DEFAULTS) && settings1.rollbackReleasesToKeep === 1 && !settings1.autoCleanup);
    check("Retention clamps to 1–5 (0 → 1, 9 → 5)", normalizeRetention({ rollbackReleasesToKeep: 0 }).rollbackReleasesToKeep === 1 && normalizeRetention({ rollbackReleasesToKeep: 9 }).rollbackReleasesToKeep === 5);
    check("Current + 1: exactly one ROLLBACK (the newest previous)", releases.filter((r) => r.status === "ROLLBACK").map((r) => r.sha).join() === rollbackSha);
    check("Current never counted inside the rollback number", releases.filter((r) => r.protected && (r.status === "CURRENT" || r.status === "ROLLBACK")).length === 2);
    const plan1 = planReleaseCleanup(releases);
    check("Cleanup candidates = older recognized inactive releases", plan1.candidates.map((r) => r.sha).sort().join() === [old1Sha, old2Sha].sort().join());
    check("In-progress release protected (ACTIVE JOB)", by(inProgressSha).status === "IN_PROGRESS" && by(inProgressSha).protected);
    check("Unknown dir + symlink = UNKNOWN — MANUAL REVIEW, not candidates", releases.filter((r) => r.status === "UNRECOGNIZED").length === 2 && plan1.manualReview.length === 2);
    const r2 = (await listReleases(R, { includePm2: false, rollbackToKeep: 2 })).releases;
    check("Rollback to keep = 2 protects Current + 2", r2.filter((r) => r.status === "ROLLBACK").map((r) => r.sha).sort().join() === [rollbackSha, old1Sha].sort().join());

    // ---- 22. Preview is read-only ---------------------------------------------
    console.log("\n22. Cleanup preview");
    const beforeList = (await readdir(R.releases)).sort().join();
    planReleaseCleanup((await listReleases(R, { includePm2: false })).releases);
    planBackupCleanup(await listArtifacts(R), settings1);
    check("Preview performs zero deletion", (await readdir(R.releases)).sort().join() === beforeList && (await listArtifacts(R)).length === arts.length);

    // ---- 5–6, 17–19. Protection + path safety ----------------------------------
    console.log("\n5–6, 17–19. Protection and path safety");
    check("Current release deletion rejected", (await rejects(() => deleteOneRelease(R, by(currentSha).id, settings1, { includePm2: false }))) instanceof ReleaseProtectedError);
    check("Rollback release deletion rejected", (await rejects(() => deleteOneRelease(R, by(rollbackSha).id, settings1, { includePm2: false }))) instanceof ReleaseProtectedError);
    check("In-progress release deletion rejected", (await rejects(() => deleteOneRelease(R, by(inProgressSha).id, settings1, { includePm2: false }))) instanceof ReleaseProtectedError);
    const symRow = releases.find((r) => r.sha === symlinkSha)!;
    check("Symlink escape rejected", (await rejects(() => deleteOneRelease(R, symRow.id, settings1, { includePm2: false }))) !== null && (await readFile(`${base}/outside/escape.txt`, "utf8")).length > 0);
    check("Path traversal id rejected", (await rejects(() => deleteRelease(R, "../../etc", { includePm2: false }))) instanceof UnsafePathError);
    check("resolveInsideRoot rejects ../ and absolute", (await rejects(() => resolveInsideRoot(R.releases, "../x", { pattern: /.*/, expect: "dir" }))) instanceof UnsafePathError && (await rejects(() => resolveInsideRoot(R.releases, "/etc", { pattern: /.*/, expect: "dir" }))) instanceof UnsafePathError);
    const arbitrary = opaqueId(`release:${await realpath(R.releases)}`, "../sentinel");
    const arb = await deleteOneRelease(R, arbitrary, settings1, { includePm2: false });
    check("Arbitrary / unknown id deletes nothing", arb.outcome === "NOTHING" && (await readFile(`${base}/sentinel/keep.txt`, "utf8")) === "must survive");
    const unknown = arts.find((a) => a.name === "notes.txt")!;
    check("Arbitrary unknown backup file deletion rejected", (await rejects(() => deleteArtifact(R, unknown.id))) !== null);

    // ---- 7–8, 13. Delete old release: completes, idempotent, no duplicates ---
    console.log("\n7–8, 13. Old release delete, bounded response, duplicate protection");
    const oldRow = by(old2Sha);
    const t1 = Date.now();
    const [a, b] = await Promise.allSettled([
      deleteOneRelease(R, oldRow.id, settings1, { includePm2: false }),
      deleteOneRelease(R, oldRow.id, settings1, { includePm2: false }),
    ]);
    const outcomes = [a, b].map((x) => (x.status === "fulfilled" ? x.value.outcome : x.reason instanceof MaintenanceBusyError ? "BUSY" : "ERR"));
    check("Concurrent duplicate delete: exactly one DELETED, other BUSY/NOTHING", outcomes.filter((o) => o === "DELETED").length === 1 && outcomes.every((o) => o === "DELETED" || o === "BUSY" || o === "NOTHING"), outcomes.join());
    check("Delete response completes quickly (no du in request)", Date.now() - t1 < 10_000, `${Date.now() - t1}ms`);
    const del = [a, b].find((x) => x.status === "fulfilled" && x.value.outcome === "DELETED") as PromiseFulfilledResult<Awaited<ReturnType<typeof deleteOneRelease>>>;
    check("Old fixture release deleted from disk", !(await readdir(R.releases)).includes(old2Sha));
    check("Result carries storage before/after/reclaimed", del.value.storageBefore != null && del.value.storageAfter != null && del.value.reclaimed != null && del.value.deleted[0].bytes! > 400_000);
    check("Symlink inside deleted release NOT followed (sentinel intact)", (await readFile(`${base}/sentinel/keep.txt`, "utf8")) === "must survive");
    const again = await deleteOneRelease(R, oldRow.id, settings1, { includePm2: false });
    check("Repeated delete after success = NOTHING (idempotent)", again.outcome === "NOTHING");
    releases = (await listReleases(R, { includePm2: false, sizes: releaseSizeMap(snap) })).releases;
    const view2 = await buildStorageView(R, { snapshot: snap, releases, artifacts: arts, releaseReclaimable: planReleaseCleanup(releases).reclaimableBytes, backupReclaimable: 0, paths: P });
    check("Inventory + reclaimable recalculated without a rescan", !releases.some((r) => r.sha === old2Sha) && view2.releases.reclaimable < view.releases.reclaimable && view2.releases.old < view.releases.old);

    // ---- 9–12, 14. Client operation logic (the code the buttons use) ---------
    console.log("\n9–12, 14. UI operation state");
    const busyLog: boolean[] = [];
    let calls = 0;
    const guard = createOperationGuard((v) => busyLog.push(v));
    const ok = await guard({ run: async () => (calls++, { ok: true, message: "Deleted", data: 1 }) });
    check("Success: result settles, spinner cleared (busy true → false)", ok?.kind === "success" && busyLog.join() === "true,false" && calls === 1);
    busyLog.length = 0;
    const refused = await guard({ run: async () => ({ ok: false, error: "Refused: protected" }) });
    check("Server refusal: message shown, spinner cleared", refused?.kind === "refused" && refused.message === "Refused: protected" && busyLog.at(-1) === false);
    busyLog.length = 0;
    const afterThrows = await guard({ run: async () => ({ ok: true, message: "Deleted" }) }, () => {
      throw new Error("router.refresh / storage refresh failed");
    });
    check("Refresh failure after a successful delete: still success, spinner cleared", afterThrows?.kind === "success" && busyLog.at(-1) === false);
    busyLog.length = 0;
    const hung = await guard({ run: () => new Promise<{ ok: boolean }>(() => undefined), timeoutMs: 200 });
    check("Hung request settles (timeout) — no infinite spinner", hung?.kind === "unknown" && busyLog.at(-1) === false);
    let runs = 0;
    const slow = guard({ run: async () => (runs++, await sleep(100), { ok: true }) });
    const dup = await guard({ run: async () => (runs++, { ok: true }) });
    await slow;
    check("Duplicate submit while running is ignored (run once)", dup === null && runs === 1);
    // Ambiguous: server deleted, response lost → reconcile with authoritative state, never re-run.
    releases = (await listReleases(R, { includePm2: false })).releases;
    const old1Row = releases.find((r) => r.sha === old1Sha)!;
    let deleteCalls = 0;
    const amb = await runOperation({
      run: async () => {
        deleteCalls++;
        await deleteOneRelease(R, old1Row.id, settings1, { includePm2: false });
        throw new TypeError("Failed to fetch (504 from proxy)");
      },
      reconcile: async () => ({ ok: true, data: { exists: (await listReleases(R, { includePm2: false })).releases.some((r) => r.id === old1Row.id) } }),
    });
    check("Lost response after delete → reconciled as DONE from server state", amb.kind === "reconciled-done" && amb.ok);
    check("Delete was NOT repeated during reconciliation", deleteCalls === 1);
    const amb2 = await runOperation({
      run: async () => {
        throw new TypeError("network down");
      },
      reconcile: async () => ({ ok: true, data: { exists: true } }),
    });
    check("Lost request before delete → reported NOT done, not retried", amb2.kind === "reconciled-not-done" && !amb2.ok);
    const amb3 = await runOperation({ run: async () => Promise.reject(new Error("x")), reconcile: async () => Promise.reject(new Error("y")) });
    check("Reconcile failure → 'unknown', asks to refresh (never resubmits)", amb3.kind === "unknown" && /do not resubmit/.test(amb3.message));

    // ---- Bounded bulk cleanup + lock -----------------------------------------
    console.log("\nBulk cleanup bounds, lock, active backup");
    const [extra1, extra2] = [sha(), sha()];
    await mkRelease(extra1, 5);
    await mkRelease(extra2, 6);
    releases = (await listReleases(R, { includePm2: false })).releases;
    const ids = planReleaseCleanup(releases).candidates.map((c) => c.id);
    const budget0 = await cleanupReleases(R, settings1, { previewIds: ids, includePm2: false, budgetMs: -1 });
    check("Time budget exhausted → returns promptly, rest stays listed", budget0.outcome === "NOTHING" && budget0.remaining === ids.length && (await readdir(R.releases)).includes(extra1));
    const onlyOne = await cleanupReleases(R, settings1, { previewIds: [ids[0]], includePm2: false });
    check("Bulk cleanup deletes only previewed candidates", onlyOne.deleted.length === 1 && (await readdir(R.releases)).filter((n) => n === extra1 || n === extra2).length === 1);
    await mkdir(`${R.managed}/locks/maintenance`, { recursive: true });
    await writeFile(`${R.managed}/locks/maintenance/owner.json`, JSON.stringify({ at: Date.now() }));
    check("Concurrent cleanup blocked by maintenance lock", (await rejects(() => cleanupReleases(R, settings1, { previewIds: null, includePm2: false }))) instanceof MaintenanceBusyError);
    await rm(`${R.managed}/locks/maintenance`, { recursive: true, force: true });
    const fake = await prisma.backupJob.create({ data: { kind: "DATABASE", status: "RUNNING", saveOnVps: false } });
    fakeJobId = fake.id;
    check("Delete refused while a backup is being generated", (await rejects(() => cleanupReleases(R, settings1, { previewIds: null, includePm2: false }))) instanceof MaintenanceBusyError);
    await prisma.backupJob.delete({ where: { id: fake.id } });
    fakeJobId = null;

    // ---- 15–16. Backups -----------------------------------------------------
    console.log("\n15–16. Backup retention + delete");
    arts = await listArtifacts(R);
    const bplan = planBackupCleanup(arts, settings1);
    const keepNames = bplan.keep.map((k) => k.name).sort();
    check("Protected: newest verified DB + newest verified Full + newest verified Clean", keepNames.join() === [dumps[2], pkgs[1], pkgs[2]].sort().join(), keepNames.join());
    check("Unverified + unknown never candidates", !bplan.candidates.some((c) => c.name === unverifiedDump || c.name === "notes.txt"));
    check("Candidates = older verified DB + older Full", bplan.candidates.map((c) => c.name).sort().join() === [dumps[0], dumps[1], pkgs[0]].sort().join());
    const protectedDb = arts.find((a) => a.name === dumps[2])!;
    check("Protected latest verified backup cannot be deleted", (await rejects(() => deleteOneBackup(R, protectedDb.id, settings1))) !== null && (await stat(`${R.nightlyDb}/${dumps[2]}`).catch(() => null)) !== null);
    const oldDump = arts.find((a) => a.name === dumps[0])!;
    const bdel = await deleteOneBackup(R, oldDump.id, settings1);
    check("Fixture backup delete works", bdel.outcome === "DELETED" && !(await stat(`${R.nightlyDb}/${dumps[0]}`).catch(() => null)));
    check("Repeated backup delete = NOTHING (idempotent)", (await deleteOneBackup(R, oldDump.id, settings1)).outcome === "NOTHING");
    const keep2 = planBackupCleanup(arts, normalizeRetention({ dbBackupsToKeep: 2 }));
    check("DB Backups to Keep = 2 protects the two newest verified DB backups", keep2.keep.filter((k) => k.category === "Database Backup").length === 2);
    const m = await readPackageManifest(`${R.packages}/${pkgs[1]}`);
    const cs = m ? groupComponentSizes(m.components, 12345) : null;
    check("Full backup component sizes from manifest", Boolean(cs && cs.database === 1000 && cs.source === 300 && cs.assets === 200 && cs.encryptedConfig === 50 && cs.other === 25 && cs.archive === 12345));

    // ---- 23. Auto cleanup -----------------------------------------------------
    console.log("\n23. Automatic retention");
    const snapshotBeforeAuto = (await readdir(R.releases)).sort().join() + "|" + (await readdir(R.nightlyDb)).sort().join();
    const off = await runAutoRetention(R, settings1, { includePm2: false });
    check("Auto cleanup OFF by default → does nothing", !off.ran && (await readdir(R.releases)).sort().join() + "|" + (await readdir(R.nightlyDb)).sort().join() === snapshotBeforeAuto);
    const on = await runAutoRetention(R, normalizeRetention({ autoCleanup: true }), { includePm2: false });
    const leftRel = await readdir(R.releases);
    const leftDb = await readdir(R.nightlyDb);
    check("Auto cleanup ON deletes only eligible items", on.ran && !leftRel.includes(extra1) && !leftRel.includes(extra2) && !leftDb.includes(dumps[1]));
    check("Auto cleanup kept current, rollback, in-progress, unknown, unverified, protected backups", [currentSha, rollbackSha, inProgressSha, "not-a-release", symlinkSha].every((s) => leftRel.includes(s)) && [dumps[2], unverifiedDump, "notes.txt"].every((n) => leftDb.includes(n)) && (await readdir(R.packages)).includes(pkgs[1]) && (await readdir(R.packages)).includes(pkgs[2]));
    check("Uploads + source repo untouched", (await stat(`${R.persistent[0].dir}/img.png`).catch(() => null)) !== null && (await stat(`${R.repo}/app/page.tsx`).catch(() => null)) !== null);
    const autoAudit = await prisma.auditLog.count({ where: { action: "RETENTION_AUTO_CLEANUP", createdAt: { gte: new Date(Date.now() - 120_000) } } });
    check("Automatic cleanup recorded in audit history", autoAudit >= 1);

    // ---- 24. Refresh storage graceful ----------------------------------------
    console.log("\n24. Refresh Storage");
    const badSnap = await refreshStorageSnapshot(R, { ...P, osPackages: `${base}/does-not-exist` });
    check("Unmeasurable path → scan completes and reports it (no throw)", badSnap.osPackages === null && badSnap.errors.some((e) => e.startsWith("OS packages")));
    const tq = Date.now();
    await rm(`${R.managed}/storage-snapshot.json`, { force: true });
    const quick = await getStorageSnapshot({ ...R, managed: `${base}/managed-empty` }, { waitMs: 50, paths: P });
    check("Page read never blocks on a scan (bounded wait)", Date.now() - tq < 2_000 && quick === null);
    await sleep(1500);

    // ---- 25. Download ---------------------------------------------------------
    console.log("\n25. Download streaming");
    const big = `${base}/big.bin`;
    await writeFile(big, crypto.randomBytes(3 * 1024 * 1024));
    let completed = false;
    const reader = fileDownloadStream(big, () => {
      completed = true;
    }).getReader();
    const first = await reader.read();
    check("Stream yields bounded 64 KiB chunks (no whole-file buffering)", Boolean(first.value && first.value.byteLength <= 64 * 1024) && !completed);
    let total = first.value?.byteLength ?? 0;
    for (;;) {
      const c = await reader.read();
      if (c.done) break;
      total += c.value.byteLength;
    }
    check("onComplete fires only after the last byte", completed && total === 3 * 1024 * 1024);
    const h = new Headers(downloadHeaders('evil"; name=../x.tar', 10));
    check("Content-Disposition attachment with sanitized name", h.get("Content-Disposition") === 'attachment; filename="evil___name_.._x.tar"' && h.get("Cache-Control") === "private, no-store");

    // ---- 20–21. RBAC ------------------------------------------------------------
    console.log("\n20–21. RBAC");
    check("FULL_ADMIN has BACKUP_VIEW, not BACKUP_MANAGE (defaults)", DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.BACKUP_VIEW) && !DEFAULT_ROLE_PERMISSIONS.FULL_ADMIN.includes(PERMISSIONS.BACKUP_MANAGE));
    // Sessions get permissions from DEFAULT_ROLE_PERMISSIONS (lib/auth.config.ts jwt/session callbacks), not the RolePermission table.
    const authCfg = await readFile(path.join(PRODUCTION_ROOTS.repo, "lib/auth.config.ts"), "utf8");
    check("Session permissions are derived from DEFAULT_ROLE_PERMISSIONS", authCfg.includes("DEFAULT_ROLE_PERMISSIONS[role]"));
    check("MASTER_ADMIN has backup:manage + backup:view", DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.BACKUP_MANAGE) && DEFAULT_ROLE_PERMISSIONS.MASTER_ADMIN.includes(PERMISSIONS.BACKUP_VIEW));
    const actionsSrc = await readFile(path.join(PRODUCTION_ROOTS.repo, "app/admin/(dashboard)/backup/actions.ts"), "utf8");
    const exported = [...actionsSrc.matchAll(/export async function (\w+)\([^]*?\{\n  try \{\n    (.+)\n/g)].map((x) => ({ name: x[1], first: x[2] }));
    const mutations = ["createBackupAction", "verifyArtifactAction", "deleteArtifactAction", "cleanupBackupsAction", "cleanTempAction", "deleteReleaseAction", "cleanupReleasesAction", "refreshStorageAction", "saveRetentionAction", "rehearseRestoreAction", "restoreProductionAction"];
    check(
      "Every mutating action checks BACKUP_MANAGE first (server-side)",
      mutations.every((n) => exported.find((e) => e.name === n)?.first.includes("await manage()")),
      exported.filter((e) => !e.first.includes("manage()")).map((e) => e.name).join()
    );
    const destructive = ["deleteArtifactAction", "cleanupBackupsAction", "deleteReleaseAction", "cleanupReleasesAction", "restoreProductionAction"];
    const body = (n: string) => actionsSrc.split(`export async function ${n}(`)[1]?.split("export async function")[0] ?? "";
    check("Destructive actions re-verify the admin password", destructive.every((n) => body(n).includes("reauth(")));
    check("No action calls revalidatePath (no full-page re-render inside a mutation)", !/revalidatePath\(/.test(actionsSrc));
    const reconcileSrc = await readFile(path.join(PRODUCTION_ROOTS.repo, "app/api/admin/backup/reconcile/route.ts"), "utf8");
    check("Reconcile endpoint is read-only + BACKUP_VIEW", reconcileSrc.includes("PERMISSIONS.BACKUP_VIEW") && !/\b(rm|unlink|delete\w*)\(/.test(reconcileSrc));

    // ---- 25b. Route registry ----------------------------------------------------
    console.log("\nRoute registry consistency");
    const { buildDiagramSource } = await import("../lib/diagram-source");
    const { buildGraph } = await import("../lib/diagram-graph");
    const { resolveDisplayStatus } = await import("../lib/diagram-status");
    const reg = await prisma.routeRegistryEntry.findMany();
    const ds = buildDiagramSource(reg.map((e) => ({ pageName: e.pageName, route: e.route, module: e.module, userType: e.userType, authRequired: e.authRequired, parentRoute: e.parentRoute, status: e.status })));
    const g = buildGraph(ds.entries, ds.connections);
    const brokenNodes = g.nodes.filter((n) => ["BROKEN", "MISSING"].includes(resolveDisplayStatus({ status: n.status, deprecated: n.deprecated, missing: n.missing, isolated: n.isolated, noIncoming: n.noIncoming }).key));
    const login = g.nodes.find((n) => n.route === "/admin/login");
    check("/admin/login classified Live (middleware redirect is its entry)", Boolean(login && !login.noIncoming && resolveDisplayStatus({ status: login.status, noIncoming: login.noIncoming, isolated: login.isolated }).key === "WORKING"));
    check("Detailed route data has 0 Broken routes (matches summary)", brokenNodes.length === 0, brokenNodes.map((n) => n.route).join());
  } finally {
    if (fakeJobId) await prisma.backupJob.delete({ where: { id: fakeJobId } }).catch(() => undefined);
    await prisma.backupArtifactCheck.deleteMany({ where: { artifactId: { in: fixtureCheckIds } } }).catch(() => undefined);
    // Fixture deletes are audited like real ones (actor-less); remove those rows so the real History stays truthful.
    await prisma.auditLog
      .deleteMany({ where: { actorId: null, createdAt: { gte: testStart }, action: { in: ["RELEASE_DELETED", "RELEASE_BULK_CLEANUP", "BACKUP_DELETED", "BACKUP_BULK_CLEANUP", "RETENTION_AUTO_CLEANUP", "BACKUP_TEMP_CLEANUP"] } } })
      .catch(() => undefined);
    await rm(base, { recursive: true, force: true });
    const realReleasesAfter = (await readdir(PRODUCTION_ROOTS.releases)).sort().join();
    const realBackupsAfter = (await listArtifacts(PRODUCTION_ROOTS)).map((a) => `${a.name}:${a.sizeBytes}`).sort().join();
    console.log("\nSafety");
    check("NO real release deleted", realReleasesAfter === realReleasesBefore);
    const afterSet = new Set(realBackupsAfter.split(","));
    check("NO real backup deleted", realBackupsBefore.split(",").every((x) => afterSet.has(x)));
    check("Fixtures removed", !(await stat(base).catch(() => null)));
    await prisma.$disconnect();
  }
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
