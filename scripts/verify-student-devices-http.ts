/**
 * END-TO-END (HTTP) coverage for STUDENT DEVICE LIMIT + SESSION REVOCATION +
 * ONE ACTIVE TEST DEVICE, through real Auth.js sign-ins, real cookies and
 * the real middleware / jwt callback / run page.
 *
 * Each "device" is its own cookie jar (= one browser profile). Two server
 * processes on BASE_A and BASE_B share one database, standing in for PM2
 * cluster workers: sign-ins alternate between them and the concurrency test
 * fires at both at once. Cookies are host-scoped (not port-scoped), so one
 * jar is valid on both workers exactly as behind the PM2 load balancer.
 *
 * Prereqs: a DISPOSABLE database (migrated + seeded) and two `next start`
 * processes pointed at it with NEXTAUTH_URL/AUTH_URL = their own origin:
 *   DATABASE_URL=… NODE_OPTIONS="--conditions=react-server" \
 *   BASE_A=http://localhost:3101 BASE_B=http://localhost:3102 \
 *   ADMIN_USER=qa-admin ADMIN_PASS=… npx tsx scripts/verify-student-devices-http.ts
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import argon2 from "argon2";
import { DeviceSecurityEventType as E, StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resetStudentDeviceLimit, revokeStudentDevice, revokeStudentSession, logoutAllStudentSessions } from "@/lib/student-devices";
import { LEASE_MS } from "@/lib/attempt-device-lease";

if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
const BASE_A = process.env.BASE_A ?? "http://localhost:3101";
const BASE_B = process.env.BASE_B ?? "http://localhost:3102";
const ADMIN_USER = process.env.ADMIN_USER ?? "";
const ADMIN_PASS = process.env.ADMIN_PASS ?? "";

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}

const UA = {
  phone: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  laptop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
};

/** One browser profile: its own cookies, UA and (simulated) client IP. */
class Browser {
  cookies = new Map<string, string>();
  constructor(
    public name: string,
    public ua: string,
    public ip = "103.21.44.7"
  ) {}
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0\b/i.test(a) || /expires=Thu, 01 Jan 1970/i.test(a));
      if (!v || expired) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }
  async fetch(base: string, path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(base + path, {
        ...init,
        redirect: "manual",
        headers: { "user-agent": this.ua, "x-forwarded-for": this.ip, cookie: this.header(), ...(init.headers ?? {}) },
      });
    } catch (e) {
      // A pooled keep-alive socket the server already closed (undici race) — retry once.
      if (retry) return this.fetch(base, path, init, false);
      throw e;
    }
    this.absorb(res);
    return res;
  }
  get deviceCookie() {
    return this.cookies.get("mts-device");
  }
  get session() {
    return this.cookies.get("student-session-token");
  }
}

async function passwordLogin(b: Browser, base: string, identifier: string, password: string) {
  // A real browser keeps its old (possibly revoked) cookie; "signed in" here
  // means THIS sign-in issued a new one.
  b.cookies.delete("student-session-token");
  await b.fetch(base, "/login");
  const csrf = await b.fetch(base, "/api/student-auth/csrf");
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const res = await b.fetch(base, "/api/student-auth/callback/password", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ identifier, password, csrfToken, callbackUrl: "/student/dashboard" }).toString(),
  });
  return { status: res.status, location: res.headers.get("location") ?? "", signedIn: !!b.session };
}

/** 200 = signed-in page; a redirect to /login = signed out. */
async function dashboard(b: Browser, base = BASE_A) {
  const res = await b.fetch(base, "/student/dashboard");
  const location = res.headers.get("location") ?? "";
  return { status: res.status, ok: res.status === 200, toLogin: location.includes("/login") };
}

async function adminLogin(b: Browser) {
  const csrf = await b.fetch(BASE_A, "/api/auth/csrf");
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  await b.fetch(BASE_A, "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS, csrfToken, callbackUrl: "/admin" }).toString(),
  });
  return [...b.cookies.keys()].some((k) => k.endsWith("authjs.session-token"));
}

const tag = Date.now().toString(36);
const created: string[] = [];
let fixture: { examId: string; studentIds: string[]; token: string; mockAttemptId: string; pyqAttemptId: string } | null = null;
const PASSWORD = "Device-Test-2026!";

async function mkStudent(label: string) {
  const s = await prisma.student.create({
    data: {
      studentId: `HTTP-${tag}-${label}`,
      name: `HTTP Device ${label}`,
      email: `http-${tag}-${label}@example.test`,
      passwordHash: await argon2.hash(PASSWORD),
      authProvider: StudentAuthProvider.CREDENTIALS,
    },
  });
  created.push(s.id);
  return s;
}

function runFixture(args: string[]) {
  return execFileSync("npx", ["tsx", "scripts/test-engine-ui-fixture.ts", ...args], {
    env: { ...process.env, UI_CONCURRENCY: "0" },
    encoding: "utf8",
  });
}

async function main() {
  const admin = await prisma.adminUser.findFirstOrThrow({ select: { id: true } });

  console.log("\nDevice cookie");
  {
    const b = new Browser("probe", UA.laptop);
    await b.fetch(BASE_A, "/login");
    const first = b.deviceCookie;
    check("/login sets a signed mts-device cookie", !!first && /^v1\.[0-9a-f]{32}\./.test(first));
    await b.fetch(BASE_B, "/login");
    check("cookie is stable across requests and workers", b.deviceCookie === first);
    const adminProbe = new Browser("adminprobe", UA.laptop);
    await adminProbe.fetch(BASE_A, "/admin/login");
    check("no device cookie on /admin", !adminProbe.deviceCookie);
  }

  console.log("\n1-6, 14-15. Third-device rejection over HTTP (alternating workers)");
  const s = await mkStudent("main");
  const phone = new Browser("phone", UA.phone, "103.21.44.7");
  const laptop = new Browser("laptop", UA.laptop, "49.36.1.9");
  const iphone = new Browser("iphone", UA.iphone, "157.48.2.2");
  const l1 = await passwordLogin(phone, BASE_A, s.email!, PASSWORD);
  check("1. first device password login -> session cookie", l1.signedIn, l1);
  check("1. dashboard reachable on worker A", (await dashboard(phone, BASE_A)).ok);
  check("1. ...and on worker B (PM2 cluster)", (await dashboard(phone, BASE_B)).ok);
  const l1b = await passwordLogin(phone, BASE_B, s.email!, PASSWORD);
  check("2. same device again -> PASS", l1b.signedIn);
  check("2. still one device row", (await prisma.studentDevice.count({ where: { studentId: s.id } })) === 1);
  const l2 = await passwordLogin(laptop, BASE_B, s.email!, PASSWORD);
  check("3. second device -> PASS", l2.signedIn && (await dashboard(laptop)).ok);
  const l3 = await passwordLogin(iphone, BASE_A, s.email!, PASSWORD);
  check("4. third device -> NO session cookie", !l3.signedIn, l3);
  check("4. third device -> dashboard redirects to /login", (await dashboard(iphone)).toLogin);
  check("4. third device got no device row", (await prisma.studentDevice.count({ where: { studentId: s.id } })) === 2);
  check("5. DEVICE_LIMIT_REACHED event", (await prisma.deviceSecurityEvent.count({ where: { studentId: s.id, eventType: E.DEVICE_LIMIT_REACHED } })) === 1);
  check("6. device 1 still works after the block", (await dashboard(phone, BASE_B)).ok);
  check("6. device 2 still works after the block", (await dashboard(laptop, BASE_A)).ok);
  const loginHtml = await (await iphone.fetch(BASE_A, "/login?error=DeviceLimit")).text();
  check("4. /login?error=DeviceLimit (Google path) renders the message", loginHtml.includes("Device Limit Reached") && loginHtml.includes("maximum number of devices"));

  console.log("\n11-12. Tabs + IP change");
  {
    const tabs = await Promise.all([BASE_A, BASE_B, BASE_A, BASE_B].map((base) => dashboard(phone, base)));
    check("11. 4 parallel tabs (both workers) all signed in", tabs.every((t) => t.ok));
    phone.ip = "185.220.101.4"; // Wi-Fi -> mobile data / VPN
    check("12. IP change: still signed in", (await dashboard(phone)).ok);
    const relog = await passwordLogin(phone, BASE_A, s.email!, PASSWORD);
    check("12. IP change: re-login allowed, same device", relog.signedIn && (await prisma.studentDevice.count({ where: { studentId: s.id } })) === 2);
  }

  console.log("\n7. Admin sees 2/2 (admin auth unaffected)");
  const adminB = new Browser("admin", UA.laptop);
  if (ADMIN_USER && ADMIN_PASS) {
    check("14. admin login works", await adminLogin(adminB));
    const page = await (await adminB.fetch(BASE_A, `/admin/students/${s.id}`)).text();
    check("7. /admin/students/[id] shows DEVICE ACCESS", /Device Access/i.test(page));
    check("7. ...with 2 / 2 registered and LIMIT REACHED", /2\s*(<!-- -->)?\s*\/\s*(<!-- -->)?\s*2/.test(page) && /LIMIT REACHED/i.test(page));
    const mon = await (await adminB.fetch(BASE_A, "/admin/monitoring/authentication")).text();
    check("7. monitoring page shows Student Device Monitoring", mon.includes("Student Device Monitoring") && mon.includes(s.name));
    const sec = await (await adminB.fetch(BASE_A, "/admin/settings/security")).text();
    check("settings page shows Student Device Security", /Student Device Security/i.test(sec) && /Maximum Registered Devices/i.test(sec));
    check("admin session cookie is not a student cookie", !adminB.session);
  } else {
    console.log("  SKIP  admin HTTP checks (set ADMIN_USER / ADMIN_PASS)");
  }

  console.log("\n10. Revocation over HTTP");
  {
    const laptopSession = await prisma.studentSession.findFirstOrThrow({
      where: { studentId: s.id, revokedAt: null, device: { userAgent: UA.laptop } },
    });
    await revokeStudentSession(s.id, laptopSession.id, { adminId: admin.id }, "ADMIN_LOGOUT");
    const d = await dashboard(laptop, BASE_B);
    check("10. logged-out session -> dashboard redirects to login", d.toLogin, d);
    const api = await laptop.fetch(BASE_A, "/api/student/invoices/does-not-exist");
    check("10. logged-out session -> student API 401", api.status === 401, api.status);
    check("10. other device unaffected", (await dashboard(phone)).ok);
    check("10. logged-out device may sign in again (slot kept)", (await passwordLogin(laptop, BASE_A, s.email!, PASSWORD)).signedIn);
    const dev = await prisma.studentDevice.findFirstOrThrow({ where: { studentId: s.id, userAgent: UA.laptop, active: true } });
    await revokeStudentDevice(s.id, dev.id, { adminId: admin.id }, "ADMIN_REVOKED");
    check("10. revoked device -> dashboard stops (worker A)", (await dashboard(laptop, BASE_A)).toLogin);
    check("10. revoked device -> dashboard stops (worker B)", (await dashboard(laptop, BASE_B)).toLogin);
    check("10. revoked device -> profile stops", ((await laptop.fetch(BASE_A, "/student/profile")).headers.get("location") ?? "").includes("/login"));
    check("10. freed slot: third device can now sign in", (await passwordLogin(iphone, BASE_B, s.email!, PASSWORD)).signedIn);
    check("10. revoked laptop now blocked (limit full again)", !(await passwordLogin(laptop, BASE_A, s.email!, PASSWORD)).signedIn);
    // Explicit sign-out revokes the session server-side.
    const before = iphone.session!;
    const csrf = await iphone.fetch(BASE_A, "/api/student-auth/csrf");
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    await iphone.fetch(BASE_A, "/api/student-auth/signout", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken }).toString(),
    });
    iphone.cookies.set("student-session-token", before); // a stolen copy of the old cookie
    check("10. signed-out cookie replayed -> rejected", (await dashboard(iphone)).toLogin);
  }

  console.log("\n8-9. Admin reset over HTTP");
  {
    await resetStudentDeviceLimit(s.id, admin.id);
    check("8. after reset: phone signed out", (await dashboard(phone)).toLogin);
    check("8. ADMIN_DEVICE_RESET with admin id", (await prisma.deviceSecurityEvent.count({ where: { studentId: s.id, eventType: E.ADMIN_DEVICE_RESET, actorAdminId: admin.id } })) === 1);
    check("9. brand-new device can sign in after reset", (await passwordLogin(new Browser("new1", UA.iphone), BASE_A, s.email!, PASSWORD)).signedIn);
    check("9. previously revoked laptop can sign in after reset", (await passwordLogin(laptop, BASE_B, s.email!, PASSWORD)).signedIn);
    check("9. limit applies again (3rd blocked)", !(await passwordLogin(phone, BASE_A, s.email!, PASSWORD)).signedIn);
    if (ADMIN_USER) {
      const page = await (await adminB.fetch(BASE_A, `/admin/students/${s.id}`)).text();
      check("8. admin page shows the reset in the audit trail", /ADMIN_DEVICE_RESET|Admin reset|Device limit reset/i.test(page));
    }
  }

  console.log("\n13, 19. Simultaneous logins across both workers");
  {
    const r = await mkStudent("race");
    const browsers = Array.from({ length: 8 }, (_, i) => new Browser(`race${i}`, i % 2 ? UA.phone : UA.laptop, `10.0.0.${i}`));
    for (const b of browsers) await b.fetch(BASE_A, "/login"); // each gets its own device cookie
    const results = await Promise.all(browsers.map((b, i) => passwordLogin(b, i % 2 ? BASE_B : BASE_A, r.email!, PASSWORD)));
    const ok = results.filter((x) => x.signedIn).length;
    check("13/19. 8 new devices at once over 2 workers -> exactly 2 sessions", ok === 2, { ok });
    check("13/19. exactly 2 device rows", (await prisma.studentDevice.count({ where: { studentId: r.id, active: true } })) === 2);
  }

  console.log("\nExisting users (legacy session cookies)");
  fixture = JSON.parse(runFixture(["setup"]).trim().split("\n").pop()!);
  const legacy = new Browser("legacy", UA.laptop);
  legacy.cookies.set("student-session-token", fixture!.token);
  check("existing session (issued before device security) keeps working", (await dashboard(legacy)).ok);
  check("its device is registered lazily on use", (await prisma.studentDevice.count({ where: { studentId: fixture!.studentIds[0], registeredVia: "LEGACY_SESSION" } })) === 1);

  console.log("\n17-18. One active test device (real run page)");
  {
    const mainId = fixture!.studentIds[0];
    // The fixture's email has upper-case letters; sign-in lower-cases the identifier.
    const who = await prisma.student.update({
      where: { id: mainId },
      data: { passwordHash: await argon2.hash(PASSWORD), email: `http-${tag}-testmain@example.test` },
      select: { email: true },
    });
    // Start clean: only the two browsers below hold this student's slots.
    await resetStudentDeviceLimit(mainId, admin.id);
    const devA = new Browser("testA", UA.laptop);
    const devB = new Browser("testB", UA.phone);
    check("A signs in", (await passwordLogin(devA, BASE_A, who.email!, PASSWORD)).signedIn);
    check("B signs in", (await passwordLogin(devB, BASE_B, who.email!, PASSWORD)).signedIn);
    const run = (b: Browser, base: string, id: string) => b.fetch(base, `/student/attempt/${id}/run`).then(async (res) => ({ status: res.status, html: await res.text() }));
    const aRun = await run(devA, BASE_A, fixture!.mockAttemptId);
    check("18. A opens the test -> player rendered", aRun.status === 200 && !aRun.html.includes("Test open on another device"), aRun.status);
    const answersBefore = await prisma.answer.count({ where: { attemptId: fixture!.mockAttemptId } });
    const bRun = await run(devB, BASE_B, fixture!.mockAttemptId);
    check("18. B opens the SAME test -> 'Test open on another device'", bRun.html.includes("Test open on another device"));
    check("18. B's page has no question text", !bRun.html.includes("UI engine question"));
    const bOther = await run(devB, BASE_A, fixture!.pyqAttemptId);
    check("18. B opens a DIFFERENT test -> also refused", bOther.html.includes("Test open on another device"));
    const att = await prisma.testAttempt.findUniqueOrThrow({ where: { id: fixture!.mockAttemptId } });
    const aDev = await prisma.studentDevice.findFirstOrThrow({ where: { studentId: mainId, userAgent: UA.laptop, active: true } });
    check("18. A keeps the lease; attempt still IN_PROGRESS, answers untouched", att.activeDeviceId === aDev.id && att.status === "IN_PROGRESS" && (await prisma.answer.count({ where: { attemptId: att.id } })) === answersBefore);
    check("18. A can reload its test", !(await run(devA, BASE_B, fixture!.mockAttemptId)).html.includes("Test open on another device"));
    // A closes the laptop: the lease goes stale and B may take over.
    await prisma.testAttempt.update({ where: { id: att.id }, data: { activeSeenAt: new Date(Date.now() - LEASE_MS - 1000) } });
    check("18. stale lease -> B may continue", !(await run(devB, BASE_B, fixture!.mockAttemptId)).html.includes("Test open on another device"));
    check("18. ...and now A is refused", (await run(devA, BASE_A, fixture!.mockAttemptId)).html.includes("Test open on another device"));
    const after = await prisma.testAttempt.findUniqueOrThrow({ where: { id: att.id } });
    check("18. hand-over never submitted the attempt", after.status === "IN_PROGRESS" && after.submittedAt === null);
    await logoutAllStudentSessions(mainId, { adminId: admin.id });
    check("logout all: A signed out", (await dashboard(devA)).toLogin);
    check("logout all: B signed out", (await dashboard(devB)).toLogin);
    check("logout all released leases", (await prisma.testAttempt.findUniqueOrThrow({ where: { id: att.id } })).activeDeviceId === null);
  }
}

async function cleanup() {
  if (fixture) {
    await prisma.deviceSecurityEvent.deleteMany({ where: { studentId: { in: fixture.studentIds } } });
    await prisma.studentLoginAttempt.deleteMany({ where: { studentId: { in: fixture.studentIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: fixture.studentIds } } });
    runFixture(["cleanup", fixture.examId, ...fixture.studentIds]);
  }
  await prisma.deviceSecurityEvent.deleteMany({ where: { studentId: { in: created } } });
  await prisma.studentLoginAttempt.deleteMany({ where: { studentId: { in: created } } });
  await prisma.studentActivity.deleteMany({ where: { studentId: { in: created } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: created } } });
  await prisma.studentExamEnrollment.deleteMany({ where: { studentId: { in: created } } });
  await prisma.student.deleteMany({ where: { id: { in: created } } });
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
