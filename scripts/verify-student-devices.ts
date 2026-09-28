/**
 * Regression coverage for STUDENT DEVICE LIMIT + SESSION MANAGEMENT +
 * ONE ACTIVE TEST DEVICE (lib/student-devices.ts, lib/attempt-device-lease.ts,
 * lib/device-cookie.ts, lib/device-info.ts, lib/student-device-settings.ts).
 *
 * Library level: exercises the exact functions the sign-in paths, the jwt
 * callback, the Student Profile and the Admin actions call. The HTTP
 * end-to-end flow (real cookies, real Auth.js, two server workers) lives in
 * scripts/verify-student-devices-http.ts.
 *
 * Run from the repo root against a DISPOSABLE database:
 *   DATABASE_URL=postgresql://…/scratch NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-student-devices.ts
 */
import "dotenv/config";
import { AttemptSourceType, DeviceSecurityEventType as E, StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  admitStudentSignIn,
  checkStudentToken,
  DeviceLimitError,
  DeviceActionError,
  getDeviceMonitoringData,
  getStudentDeviceOverview,
  logoutAllStudentSessions,
  resetStudentDeviceLimit,
  revokeSessionBySecret,
  revokeStudentDevice,
  revokeStudentSession,
  studentRemoveOwnDevice,
  maskIp,
  type AdmittedSignIn,
  type RequestSignals,
} from "@/lib/student-devices";
import { hashDeviceId, mintDeviceCookieValue, verifyDeviceCookieValue } from "@/lib/device-cookie";
import { describeUserAgent } from "@/lib/device-info";
import {
  clearStudentDeviceSettingsCache,
  DEFAULT_STUDENT_DEVICE_SETTINGS,
  normalizeStudentDeviceSettings,
  saveStudentDeviceSettings,
} from "@/lib/student-device-settings";
import { claimAttemptLease, LEASE_MS } from "@/lib/attempt-device-lease";

if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run device-security fixtures against what looks like the production database.");
  process.exit(2);
}

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}
async function rejectsWith(fn: () => Promise<unknown>, cls: new (...a: never[]) => Error) {
  try {
    await fn();
    return false;
  } catch (e) {
    return e instanceof cls;
  }
}

const UA = {
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:130.0) Gecko/20100101 Firefox/130.0",
  linuxEdge: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  ipadSafari:
    "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  androidReduced: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
};
const sig = (userAgent: string, ip = "103.21.44.7"): RequestSignals => ({ userAgent, ip });

/** A fresh browser: a verified raw device id, as middleware would mint it. */
async function newBrowser(): Promise<string> {
  return (await verifyDeviceCookieValue(await mintDeviceCookieValue()))!;
}

/** The token claims the jwt callback would hold after this sign-in. */
function claimsOf(studentDbId: string, a: AdmittedSignIn) {
  return { studentDbId, sid: a.sessionSecret ?? undefined, sref: a.sessionRowId ?? undefined, did: a.deviceId, authAt: a.authAt };
}

const tag = Date.now().toString(36);
const createdStudents: string[] = [];
let examId: string | null = null;

async function mkStudent(label: string) {
  const s = await prisma.student.create({
    data: {
      studentId: `DEV-${tag}-${label}`,
      name: `Device Test ${label}`,
      email: `dev-${tag}-${label}@example.test`,
      mobile: `9${Math.floor(Math.random() * 1e9).toString().padStart(9, "0")}`,
      authProvider: StudentAuthProvider.CREDENTIALS,
    },
  });
  createdStudents.push(s.id);
  return s;
}

async function events(studentId: string, eventType: E) {
  return prisma.deviceSecurityEvent.count({ where: { studentId, eventType } });
}

async function main() {
  await saveStudentDeviceSettings(DEFAULT_STUDENT_DEVICE_SETTINGS);
  const admin = await prisma.adminUser.findFirst({ select: { id: true } });
  if (!admin) throw new Error("the scratch DB needs at least one AdminUser (seed it first)");

  console.log("\n0. Device cookie + labels");
  {
    const v = await mintDeviceCookieValue();
    const id = await verifyDeviceCookieValue(v);
    check("minted cookie verifies", !!id && /^[0-9a-f]{32}$/.test(id));
    const [ver, raw, mac] = v.split(".");
    check("tampered id rejected", (await verifyDeviceCookieValue(`${ver}.${"0".repeat(32)}.${mac}`)) === null);
    check("forged mac rejected", (await verifyDeviceCookieValue(`${ver}.${raw}.AAAA`)) === null);
    check("garbage rejected", (await verifyDeviceCookieValue("hello")) === null && (await verifyDeviceCookieValue(undefined)) === null);
    check("stored hash is not the raw id", (await hashDeviceId(raw)) !== raw && (await hashDeviceId(raw)).length === 64);
    const labels = Object.fromEntries(Object.entries(UA).map(([k, ua]) => [k, describeUserAgent(ua).displayName]));
    check("Samsung Galaxy / Chrome / Android", labels.androidChrome === "Samsung Galaxy / Chrome / Android", labels.androidChrome);
    check("Windows PC / Chrome", labels.windowsChrome === "Windows PC / Chrome", labels.windowsChrome);
    check("iPhone / Safari", labels.iphoneSafari === "iPhone / Safari", labels.iphoneSafari);
    check("Mac / Firefox", labels.macFirefox === "Mac / Firefox", labels.macFirefox);
    check("Linux PC / Edge", labels.linuxEdge === "Linux PC / Edge", labels.linuxEdge);
    check("iPad tablet", describeUserAgent(UA.ipadSafari).deviceType === "TABLET");
    check("reduced Android UA -> generic, no invented model", labels.androidReduced === "Android Phone / Chrome / Android", labels.androidReduced);
    check("empty UA -> Unknown device", describeUserAgent("").displayName === "Unknown device");
    check("IP masked for admin display", maskIp("103.21.44.7") === "103.21.x.x" && maskIp("2401:4900:1c2a::1") === "2401:4900:x:x");
    const n = normalizeStudentDeviceSettings({ maxDevices: 999, enabled: "yes" });
    check("settings normalize (clamped, bad types -> default)", n.maxDevices === 10 && n.enabled === true);
  }

  console.log("\n1-6. Device limit at sign-in");
  const a = await mkStudent("a");
  const phone = await newBrowser();
  const laptop = await newBrowser();
  const third = await newBrowser();
  const s1 = await admitStudentSignIn(a.id, "PASSWORD", { deviceIdRaw: phone, signals: sig(UA.androidChrome), identifier: a.email! });
  check("1. first device login -> PASS, registered", s1.newlyRegistered && !!s1.sessionSecret);
  const s1b = await admitStudentSignIn(a.id, "OTP", { deviceIdRaw: phone, signals: sig(UA.androidChrome), identifier: a.mobile! });
  check("2. same device again -> PASS, not newly registered", !s1b.newlyRegistered && s1b.deviceId === s1.deviceId);
  check("2. no duplicate device row", (await prisma.studentDevice.count({ where: { studentId: a.id } })) === 1);
  check("2. re-login on same browser replaces the old session", (await checkStudentToken(claimsOf(a.id, s1))).ok === false);
  const s2 = await admitStudentSignIn(a.id, "GOOGLE", { deviceIdRaw: laptop, signals: sig(UA.windowsChrome), identifier: a.email! });
  check("3. second device -> PASS", s2.newlyRegistered);
  const blocked = await rejectsWith(
    () => admitStudentSignIn(a.id, "PASSWORD", { deviceIdRaw: third, signals: sig(UA.iphoneSafari), identifier: a.email! }),
    DeviceLimitError
  );
  check("4. third device -> BLOCK (DeviceLimitError)", blocked);
  check("4. message is the exact student-facing text", new DeviceLimitError().message.startsWith("Device Limit Reached\n\nYour account is already registered on the maximum number of devices."));
  check("4. blocked device got no device row", (await prisma.studentDevice.count({ where: { studentId: a.id } })) === 2);
  check("4. blocked device got no session", (await prisma.studentSession.count({ where: { studentId: a.id, revokedAt: null } })) === 2);
  check("5. DEVICE_LIMIT_REACHED event recorded", (await events(a.id, E.DEVICE_LIMIT_REACHED)) === 1);
  check("5. DEVICE_LIMIT login attempt recorded", (await prisma.studentLoginAttempt.count({ where: { studentId: a.id, method: "DEVICE_LIMIT" } })) === 1);
  check("6. existing device 1 still valid", (await checkStudentToken(claimsOf(a.id, s1b))).ok);
  check("6. existing device 2 still valid", (await checkStudentToken(claimsOf(a.id, s2))).ok);
  const s1c = await admitStudentSignIn(a.id, "PASSWORD", { deviceIdRaw: phone, signals: sig(UA.androidChrome), identifier: a.email! });
  check("6. existing device can sign in again after a block", !s1c.newlyRegistered);

  console.log("\n7. Admin view");
  {
    const o = await getStudentDeviceOverview(a.id);
    check("7. admin overview 2/2 registered", o.registered === 2 && o.limit === 2, { r: o.registered, l: o.limit });
    check("7. status LIMIT_REACHED after a block", o.status === "LIMIT_REACHED", o.status);
    check("7. two active sessions", o.activeSessions === 2, o.activeSessions);
    const m = await getDeviceMonitoringData();
    const row = m.rows.find((r) => r.id === a.id);
    check("7. monitoring row 2 devices / LIMIT_REACHED", row?.devices === 2 && row.status === "LIMIT_REACHED", row);
    check("7. monitoring summary counts a block today", m.summary.blocksToday >= 1);
  }

  console.log("\n11-12. Tabs and IP changes");
  {
    // Every tab of a browser sends the same cookie -> same device id.
    const tabs = await Promise.all([1, 2, 3].map(() => checkStudentToken(claimsOf(a.id, s2))));
    check("11. three tabs share one valid session", tabs.every((t) => t.ok));
    const again = await admitStudentSignIn(a.id, "PASSWORD", { deviceIdRaw: laptop, signals: sig(UA.windowsChrome, "49.36.1.9"), identifier: a.email! });
    check("12. IP change (Wi-Fi -> mobile data) = same device", !again.newlyRegistered && again.deviceId === s2.deviceId);
    const vpn = await admitStudentSignIn(a.id, "PASSWORD", { deviceIdRaw: laptop, signals: sig(UA.windowsChrome, "185.220.101.4"), identifier: a.email! });
    check("12. VPN IP = same device", !vpn.newlyRegistered);
    check("12. still exactly 2 devices", (await prisma.studentDevice.count({ where: { studentId: a.id } })) === 2);
    const dev = await prisma.studentDevice.findUniqueOrThrow({ where: { id: s2.deviceId } });
    check("12. IP stored only hashed + masked", dev.lastIpMasked === "185.220.x.x" && !!dev.lastIpHash && !dev.lastIpHash.includes("185."));
    check("12. browser update (new UA) = same device", !(await admitStudentSignIn(a.id, "PASSWORD", { deviceIdRaw: laptop, signals: sig(UA.windowsChrome.replace("129", "130")), identifier: a.email! })).newlyRegistered);
    s2.sessionSecret = vpn.sessionSecret; // (keep a live reference; the last sign-in wins)
  }
  const laptopSession = await admitStudentSignIn(a.id, "PASSWORD", { deviceIdRaw: laptop, signals: sig(UA.windowsChrome), identifier: a.email! });
  const phoneSession = await admitStudentSignIn(a.id, "PASSWORD", { deviceIdRaw: phone, signals: sig(UA.androidChrome), identifier: a.email! });

  console.log("\n10. Revocation");
  {
    await revokeStudentSession(a.id, laptopSession.sessionRowId!, { adminId: admin.id }, "ADMIN_LOGOUT");
    const c = await checkStudentToken(claimsOf(a.id, laptopSession));
    check("10. revoked session -> rejected", !c.ok && c.reason === "SESSION_REVOKED", c);
    check("10. session logout keeps the device slot", (await prisma.studentDevice.count({ where: { studentId: a.id, active: true } })) === 2);
    check("10. other device unaffected", (await checkStudentToken(claimsOf(a.id, phoneSession))).ok);
    const relog = await admitStudentSignIn(a.id, "PASSWORD", { deviceIdRaw: laptop, signals: sig(UA.windowsChrome), identifier: a.email! });
    check("10. logged-out device can sign in again (slot kept)", !relog.newlyRegistered);
    await revokeStudentDevice(a.id, relog.deviceId, { adminId: admin.id }, "ADMIN_REVOKED");
    const d = await checkStudentToken(claimsOf(a.id, relog));
    check("10. revoked device -> rejected", !d.ok, d);
    check("10. revoked device frees a slot", (await prisma.studentDevice.count({ where: { studentId: a.id, active: true } })) === 1);
    const ev = await prisma.deviceSecurityEvent.findFirst({ where: { studentId: a.id, eventType: E.DEVICE_REMOVED }, orderBy: { createdAt: "desc" } });
    check("10. DEVICE_REMOVED names the acting admin", ev?.actorAdminId === admin.id);
    check("10. SESSION_REVOKED recorded", (await events(a.id, E.SESSION_REVOKED)) >= 1);
    const cross = await rejectsWith(() => revokeStudentSession(createdStudents[0] === a.id ? "someone-else" : a.id, phoneSession.sessionRowId!, { adminId: admin.id }), DeviceActionError);
    check("10. a session can't be revoked under another student id", cross);
    // Sign out via Auth.js signOut event.
    const tmp = await admitStudentSignIn(a.id, "PASSWORD", { deviceIdRaw: third, signals: sig(UA.iphoneSafari), identifier: a.email! });
    check("10. freed slot lets a new device in", tmp.newlyRegistered);
    await revokeSessionBySecret(tmp.sessionSecret!, "LOGOUT");
    check("10. signOut revokes its session", !(await checkStudentToken(claimsOf(a.id, tmp))).ok);
  }

  console.log("\n8-9. Admin reset");
  {
    const before = await prisma.deviceSecurityEvent.count({ where: { studentId: a.id } });
    const r = await resetStudentDeviceLimit(a.id, admin.id);
    check("8. reset revokes every active device", r.devicesRevoked === 2, r);
    check("8. no active devices remain", (await prisma.studentDevice.count({ where: { studentId: a.id, active: true } })) === 0);
    check("8. device rows kept as history (not deleted)", (await prisma.studentDevice.count({ where: { studentId: a.id } })) === 3);
    check("8. no event history deleted", (await prisma.deviceSecurityEvent.count({ where: { studentId: a.id } })) === before + 1);
    const ev = await prisma.deviceSecurityEvent.findFirst({ where: { studentId: a.id, eventType: E.ADMIN_DEVICE_RESET } });
    check("8. ADMIN_DEVICE_RESET names admin + time", ev?.actorAdminId === admin.id && !!(ev.metadata as { at?: string })?.at);
    check("8. AuditLog row written", (await prisma.auditLog.count({ where: { entityId: a.id, action: "STUDENT_DEVICE_LIMIT_RESET", actorId: admin.id } })) === 1);
    check("8. old sessions stop working", !(await checkStudentToken(claimsOf(a.id, phoneSession))).ok);
    const o = await getStudentDeviceOverview(a.id);
    check("8. status back to NORMAL after reset", o.status === "NORMAL" && o.registered === 0, { s: o.status, r: o.registered });
    const n1 = await admitStudentSignIn(a.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.macFirefox), identifier: a.email! });
    const n2 = await admitStudentSignIn(a.id, "OTP", { deviceIdRaw: phone, signals: sig(UA.androidChrome), identifier: a.email! });
    check("9. new device after reset -> PASS", n1.newlyRegistered);
    check("9. previously revoked browser can re-register after reset", n2.newlyRegistered);
    check("9. limit enforced again after reset", await rejectsWith(() => admitStudentSignIn(a.id, "PASSWORD", { deviceIdRaw: laptop, signals: sig(UA.windowsChrome) }), DeviceLimitError));
    await saveStudentDeviceSettings({ ...DEFAULT_STUDENT_DEVICE_SETTINGS, allowAdminReset: false });
    check("8. reset refused when disabled in settings", await rejectsWith(() => resetStudentDeviceLimit(a.id, admin.id), DeviceActionError));
    await saveStudentDeviceSettings(DEFAULT_STUDENT_DEVICE_SETTINGS);
  }

  console.log("\n13. Concurrency (race to the last slot)");
  {
    const b = await mkStudent("b");
    const browsers = await Promise.all(Array.from({ length: 6 }, () => newBrowser()));
    const results = await Promise.allSettled(
      browsers.map((d) => admitStudentSignIn(b.id, "PASSWORD", { deviceIdRaw: d, signals: sig(UA.windowsChrome), identifier: b.email! }))
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const limitErrs = results.filter((r) => r.status === "rejected" && r.reason instanceof DeviceLimitError).length;
    check("13. 6 simultaneous new devices -> exactly 2 admitted", ok === 2, { ok, limitErrs });
    check("13. the other 4 are DeviceLimitError", limitErrs === 4);
    check("13. exactly 2 active device rows", (await prisma.studentDevice.count({ where: { studentId: b.id, active: true } })) === 2);
    const same = await newBrowser();
    const c = await mkStudent("c");
    const par = await Promise.allSettled(
      [1, 2, 3, 4].map(() => admitStudentSignIn(c.id, "PASSWORD", { deviceIdRaw: same, signals: sig(UA.windowsChrome), identifier: c.email! }))
    );
    check("11/13. 4 parallel logins from ONE browser -> one device", par.every((r) => r.status === "fulfilled") && (await prisma.studentDevice.count({ where: { studentId: c.id } })) === 1);
    check("11/13. ...and exactly one live session for it", (await prisma.studentSession.count({ where: { studentId: c.id, revokedAt: null } })) === 1);
  }

  console.log("\nLogout all / password reset / legacy tokens / settings");
  {
    const d = await mkStudent("d");
    const x = await admitStudentSignIn(d.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.windowsChrome) });
    const y = await admitStudentSignIn(d.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.androidChrome) });
    await logoutAllStudentSessions(d.id, { studentId: d.id }, { exceptSessionRowId: x.sessionRowId, reason: "PASSWORD_CHANGED" });
    check("password change: current session kept", (await checkStudentToken(claimsOf(d.id, x))).ok);
    check("password change: other session signed out", !(await checkStudentToken(claimsOf(d.id, y))).ok);
    check("password change: device slots kept", (await prisma.studentDevice.count({ where: { studentId: d.id, active: true } })) === 2);
    // Legacy token (issued before this feature): no sid / did.
    const legacyBrowser = await newBrowser();
    const e = await mkStudent("e");
    const legacy = { studentDbId: e.id, iat: Math.floor(Date.now() / 1000) - 3600 };
    const l1 = await checkStudentToken(legacy, async () => legacyBrowser, async () => sig(UA.iphoneSafari));
    check("existing user: legacy token stays signed in", l1.ok);
    check("existing user: device lazily registered", l1.ok && !!l1.deviceId && (await prisma.studentDevice.count({ where: { studentId: e.id, registeredVia: "LEGACY_SESSION" } })) === 1);
    check("existing user: legacy token without cookie still valid", (await checkStudentToken(legacy, async () => null)).ok);
    // Legacy tokens never get blocked, even over the limit.
    await admitStudentSignIn(e.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.windowsChrome) });
    const overflow = await checkStudentToken(legacy, async () => "f".repeat(32), async () => sig(UA.macFirefox));
    check("existing user over limit: legacy token NOT locked out", overflow.ok);
    check("existing user over limit: no extra slot taken", (await prisma.studentDevice.count({ where: { studentId: e.id, active: true } })) === 2);
    await logoutAllStudentSessions(e.id, { adminId: admin.id }, { reason: "ADMIN_LOGOUT_ALL" });
    check("logout all ends legacy tokens too (sessionsValidAfter)", !(await checkStudentToken(legacy, async () => legacyBrowser)).ok);
    check("LOGOUT_ALL event names admin", (await prisma.deviceSecurityEvent.count({ where: { studentId: e.id, eventType: E.LOGOUT_ALL, actorAdminId: admin.id } })) === 1);
    // Revoked legacy device loses access by its cookie.
    const f = await mkStudent("f");
    const fb = await newBrowser();
    const fl = { studentDbId: f.id, iat: Math.floor(Date.now() / 1000) };
    const reg = await checkStudentToken(fl, async () => fb, async () => sig(UA.windowsChrome));
    await revokeStudentDevice(f.id, reg.ok ? reg.deviceId! : "", { adminId: admin.id });
    check("revoked device ends a legacy token on that browser", !(await checkStudentToken(fl, async () => fb)).ok);
    // Account status.
    await prisma.student.update({ where: { id: f.id }, data: { status: "SUSPENDED" } });
    check("suspended student token rejected", !(await checkStudentToken(fl, async () => null)).ok);
    // Settings: enforcement off.
    await saveStudentDeviceSettings({ ...DEFAULT_STUDENT_DEVICE_SETTINGS, enabled: false });
    const g = await mkStudent("g");
    for (let i = 0; i < 3; i++) await admitStudentSignIn(g.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.windowsChrome) });
    check("limit disabled -> 3 devices allowed, still recorded", (await prisma.studentDevice.count({ where: { studentId: g.id, active: true } })) === 3);
    await saveStudentDeviceSettings({ ...DEFAULT_STUDENT_DEVICE_SETTINGS, blockNewDevice: false });
    await admitStudentSignIn(g.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.windowsChrome) });
    const warn = await prisma.deviceSecurityEvent.findFirst({ where: { studentId: g.id, eventType: E.DEVICE_REGISTERED }, orderBy: { createdAt: "desc" } });
    check("block off -> allowed but flagged overLimit", (warn?.metadata as { overLimit?: boolean })?.overLimit === true);
    await saveStudentDeviceSettings({ ...DEFAULT_STUDENT_DEVICE_SETTINGS, maxDevices: 3 });
    const h = await mkStudent("h");
    for (let i = 0; i < 3; i++) await admitStudentSignIn(h.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.windowsChrome) });
    check("maxDevices=3 -> 3 allowed", (await prisma.studentDevice.count({ where: { studentId: h.id, active: true } })) === 3);
    check("maxDevices=3 -> 4th blocked", await rejectsWith(() => admitStudentSignIn(h.id, "PASSWORD", { deviceIdRaw: "a".repeat(32), signals: sig(UA.windowsChrome) }), DeviceLimitError));
    await saveStudentDeviceSettings({ ...DEFAULT_STUDENT_DEVICE_SETTINGS, trackSessions: false });
    const k = await mkStudent("k");
    const untracked = await admitStudentSignIn(k.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.windowsChrome) });
    check("trackSessions off -> no session row", untracked.sessionSecret === null && (await prisma.studentSession.count({ where: { studentId: k.id } })) === 0);
    check("trackSessions off -> token still valid via device", (await checkStudentToken(claimsOf(k.id, untracked))).ok);
    await revokeStudentDevice(k.id, untracked.deviceId, { adminId: admin.id });
    check("trackSessions off -> device revocation still ends it", !(await checkStudentToken(claimsOf(k.id, untracked))).ok);
    await saveStudentDeviceSettings(DEFAULT_STUDENT_DEVICE_SETTINGS);
    clearStudentDeviceSettingsCache();
  }

  console.log("\nStudent self-removal (off by default, rate-limited)");
  {
    const s = await mkStudent("s");
    const cur = await admitStudentSignIn(s.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.windowsChrome) });
    const other = await admitStudentSignIn(s.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.androidChrome) });
    check("self-remove disabled by default", await rejectsWith(() => studentRemoveOwnDevice(s.id, other.deviceId, cur.deviceId), DeviceActionError));
    await saveStudentDeviceSettings({ ...DEFAULT_STUDENT_DEVICE_SETTINGS, studentSelfRemove: true, selfRemoveCooldownDays: 30 });
    check("can't remove the current device", await rejectsWith(() => studentRemoveOwnDevice(s.id, cur.deviceId, cur.deviceId), DeviceActionError));
    await studentRemoveOwnDevice(s.id, other.deviceId, cur.deviceId);
    check("self-remove frees the slot", (await prisma.studentDevice.count({ where: { studentId: s.id, active: true } })) === 1);
    const next = await admitStudentSignIn(s.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.macFirefox) });
    check("second self-remove inside cooldown refused", await rejectsWith(() => studentRemoveOwnDevice(s.id, next.deviceId, cur.deviceId), DeviceActionError));
    const t = await mkStudent("t");
    const tc = await admitStudentSignIn(t.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.windowsChrome) });
    const t1 = await admitStudentSignIn(t.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.windowsChrome) });
    // Parallel removals: the cooldown is checked under the student row lock.
    const extra = await prisma.studentDevice.create({ data: { studentId: t.id, deviceHash: `x-${tag}`, displayName: "x", deviceType: "DESKTOP" } });
    const race = await Promise.allSettled([studentRemoveOwnDevice(t.id, t1.deviceId, tc.deviceId), studentRemoveOwnDevice(t.id, extra.id, tc.deviceId)]);
    check("two parallel self-removals -> only one succeeds", race.filter((r) => r.status === "fulfilled").length === 1);
    await saveStudentDeviceSettings(DEFAULT_STUDENT_DEVICE_SETTINGS);
  }

  console.log("\n18. One active test device");
  {
    const exam = await prisma.exam.create({ data: { name: `Device Exam ${tag}`, code: `DEVX-${tag}` } });
    examId = exam.id;
    const st = await mkStudent("lease");
    const devA = await admitStudentSignIn(st.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.windowsChrome) });
    const devB = await admitStudentSignIn(st.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.androidChrome) });
    const mkAttempt = () =>
      prisma.testAttempt.create({
        data: { studentId: st.id, examId: exam.id, sourceType: AttemptSourceType.MOCK_TEST, durationMinutes: 60, totalQuestions: 10 },
      });
    const att = await mkAttempt();
    check("18. device A claims the attempt", (await claimAttemptLease(att.id, st.id, devA.deviceId)).ok);
    check("18. device A renews", (await claimAttemptLease(att.id, st.id, devA.deviceId)).ok);
    const b = await claimAttemptLease(att.id, st.id, devB.deviceId);
    check("18. device B rejected (OTHER_DEVICE)", !b.ok);
    const held = await prisma.testAttempt.findUniqueOrThrow({ where: { id: att.id } });
    check("18. original device keeps the attempt, still IN_PROGRESS", held.activeDeviceId === devA.deviceId && held.status === "IN_PROGRESS");
    const att2 = await mkAttempt();
    check("18. B can't open a DIFFERENT test while A runs one", !(await claimAttemptLease(att2.id, st.id, devB.deviceId)).ok);
    check("18. TEST_DEVICE_CONFLICT + SUSPICIOUS recorded", (await events(st.id, E.TEST_DEVICE_CONFLICT)) === 1 && (await events(st.id, E.SUSPICIOUS_DEVICE_ACTIVITY)) === 1);
    check("18. status SUSPICIOUS", (await getStudentDeviceOverview(st.id)).status === "SUSPICIOUS");
    const race = await Promise.all([claimAttemptLease(att2.id, st.id, devB.deviceId), claimAttemptLease(att.id, st.id, devA.deviceId)]);
    check("18. concurrent claim: A keeps, B still refused", race[1].ok && !race[0].ok);
    await prisma.testAttempt.update({ where: { id: att.id }, data: { activeSeenAt: new Date(Date.now() - LEASE_MS - 1000) } });
    check("18. stale lease (device closed) can be taken over", (await claimAttemptLease(att.id, st.id, devB.deviceId)).ok);
    check("18. ...and then A is the one refused", !(await claimAttemptLease(att.id, st.id, devA.deviceId)).ok);
    await revokeStudentDevice(st.id, devB.deviceId, { adminId: admin.id });
    const afterRevoke = await prisma.testAttempt.findUniqueOrThrow({ where: { id: att.id } });
    check("18. revoking the holder releases the lease, attempt untouched", afterRevoke.activeDeviceId === null && afterRevoke.status === "IN_PROGRESS" && afterRevoke.submittedAt === null);
    check("18. A can continue after B revoked", (await claimAttemptLease(att.id, st.id, devA.deviceId)).ok);
    check("18. no device context (legacy) -> not enforced", (await claimAttemptLease(att.id, st.id, null)).ok);
    await resetStudentDeviceLimit(st.id, admin.id);
    const afterReset = await prisma.testAttempt.findUniqueOrThrow({ where: { id: att.id } });
    check("18. admin reset releases lease, never submits", afterReset.activeDeviceId === null && afterReset.status === "IN_PROGRESS");
    await saveStudentDeviceSettings({ ...DEFAULT_STUDENT_DEVICE_SETTINGS, oneActiveTestDevice: false });
    check("18. feature off -> not enforced", (await claimAttemptLease(att.id, st.id, "anything")).ok);
    await saveStudentDeviceSettings(DEFAULT_STUDENT_DEVICE_SETTINGS);
    await prisma.testAttempt.update({ where: { id: att.id }, data: { status: "SUBMITTED", submittedAt: new Date() } });
    check("18. submitted attempt -> lease not required (engine reports state)", (await claimAttemptLease(att.id, st.id, devA.deviceId)).ok);
  }

  console.log("\nDeleted accounts");
  {
    const z = await mkStudent("z");
    const zs = await admitStudentSignIn(z.id, "PASSWORD", { deviceIdRaw: await newBrowser(), signals: sig(UA.windowsChrome) });
    await prisma.student.update({ where: { id: z.id }, data: { status: "DELETED" } });
    check("deleted student's session rejected", !(await checkStudentToken(claimsOf(z.id, zs))).ok);
    await prisma.student.delete({ where: { id: z.id } });
    createdStudents.splice(createdStudents.indexOf(z.id), 1);
    check("hard delete cascades devices/sessions", (await prisma.studentDevice.count({ where: { studentId: z.id } })) === 0);
    check("hard delete keeps audit events (studentId nulled)", (await prisma.deviceSecurityEvent.count({ where: { deviceId: null, studentId: null, metadata: { path: ["method"], equals: "PASSWORD" } } })) >= 1);
  }
}

async function cleanup() {
  await prisma.testAttempt.deleteMany({ where: { studentId: { in: createdStudents } } });
  await prisma.deviceSecurityEvent.deleteMany({ where: { studentId: { in: createdStudents } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: createdStudents } } });
  await prisma.studentLoginAttempt.deleteMany({ where: { studentId: { in: createdStudents } } });
  await prisma.student.deleteMany({ where: { id: { in: createdStudents } } });
  if (examId) await prisma.exam.delete({ where: { id: examId } });
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup failed", e));
    await prisma.$disconnect();
    console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
    process.exit(failures ? 1 : 0);
  });
