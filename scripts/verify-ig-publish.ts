/**
 * Direct Instagram publishing — library regression (lib/instagram/publish.ts)
 * against a LOCAL mock of graph.instagram.com (scripts/mock-meta-graph.mjs)
 * that really downloads every slide from a local copy of the public media
 * route. Never talks to Meta; every outbound fetch is checked. Tokens are fake.
 *
 *   set -a; . ./.env; set +a     # DATABASE_URL = an *igstudio* scratch DB with scripts/ig-studio-fixture.ts setup
 *   export STORAGE_DIR=<scratch dir>
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ig-publish.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import * as posts from "@/lib/instagram/posts";
import { saveStudioSettings } from "@/lib/instagram/config";
import { REVIEW_CHECKLIST } from "@/lib/instagram/quality";
import { publishingApi } from "@/lib/instagram/meta";
import {
  classifyPublishFailure,
  getPublishStatus,
  getPublishingSwitch,
  mediaUrl,
  publishPreflight,
  readPublishMedia,
  reconcilePublish,
  runPublishJob,
  setPublishingSwitch,
  startPublish,
  type PublishFormat,
} from "@/lib/instagram/publish";
import { composeCaption, type PostContent } from "@/lib/instagram/types";
import { MOCK_USER_ID, mockToken, startMockGraph } from "./mock-meta-graph.mjs";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.includes("igstudio")) {
  console.error(`Refusing to run: database "${dbName}" is not an igstudio scratch database.`);
  process.exit(2);
}
if (!process.env.STORAGE_DIR || process.env.STORAGE_DIR.startsWith("/var/www")) {
  console.error("Refusing to run: export STORAGE_DIR=<scratch dir> (never production storage).");
  process.exit(2);
}

const GRAPH_PORT = Number(process.env.MOCK_GRAPH_PORT ?? 3197);
const MEDIA_PORT = Number(process.env.MOCK_MEDIA_PORT ?? 3196);
let passes = 0;
let failures = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passes++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        → ${String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join("\n          ")}`);
  }
}

const logged: string[] = [];
for (const m of ["log", "error", "warn", "info", "debug"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    orig(...args);
  };
}

const tokens: string[] = [];
function installToken(scenario: string) {
  const t = mockToken(scenario);
  tokens.push(t);
  process.env.INSTAGRAM_ACCESS_TOKEN = t;
  return t;
}

async function main() {
  const { server: graph, stats, base } = await startMockGraph(GRAPH_PORT);
  // Local stand-in for app/api/instagram-media/[token]/[file]/route.ts (same reader).
  const media = http.createServer(async (req, res) => {
    const m = /^\/api\/instagram-media\/([^/]+)\/([^/]+)$/.exec(req.url ?? "");
    const buf = m ? await readPublishMedia(m[1], m[2]) : null;
    if (!buf) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(buf.length) });
    res.end(buf);
  });
  await new Promise<void>((r) => media.listen(MEDIA_PORT, "127.0.0.1", () => r()));
  const mediaBase = `http://127.0.0.1:${MEDIA_PORT}`;

  const realFetch = globalThis.fetch;
  let stray = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    if (!u.startsWith(base + "/") && !u.startsWith(mediaBase + "/") && !u.startsWith("data:")) {
      stray++;
      console.log(`    (stray request: ${u.slice(0, 80)})`);
      throw new Error(`blocked outbound request to ${u.slice(0, 40)}`);
    }
    return realFetch(input, init);
  }) as typeof fetch;

  Object.assign(process.env, {
    INSTAGRAM_GRAPH_API_BASE: base,
    INSTAGRAM_USER_ID: MOCK_USER_ID,
    INSTAGRAM_MEDIA_BASE_URL: mediaBase,
    INSTAGRAM_PUBLISH_POLL_MS: "150",
    INSTAGRAM_WRITE_TIMEOUT_MS: "1500",
  });
  delete process.env.INSTAGRAM_APP_SECRET;

  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { username: "igmaster" } });
  const actorId = admin.id;
  await saveStudioSettings({ instagramHandle: "mocktestseries.in", telegramUrl: "https://t.me/mocktestseries_fixture" });
  const q = (code: string) => prisma.question.findUniqueOrThrow({ where: { code } });
  const CODES = ["IGFIX-RUHS21-W01", "IGFIX-RUHS19-W01", "IGFIX-RUHS19-W02", "IGFIX-RPSC24I-W01", "IGFIX-RPSC24II-W01"];
  const qIds = await Promise.all(CODES.map(async (c) => (await q(c)).id));
  await prisma.instagramPost.deleteMany({ where: { questionId: { in: qIds } } });
  let nth = 0;

  /** A fresh, approved (READY) post on a fixture question. */
  async function readyPost(code = CODES[nth++ % CODES.length]) {
    const qid = (await q(code)).id;
    await prisma.instagramPost.deleteMany({ where: { questionId: qid } });
    const { post } = await posts.createDraft({ questionId: qid, series: "PYQ", stats: null, actorId });
    const content: PostContent = {
      ...post.content,
      hookText: "Can You Solve This PYQ?",
      explanation: "The stored answer is correct; this fixture explanation is short and plain.",
      memoryTrick: "Fixture memory line.",
      clinicalPearl: "Fixture pearl.",
      quickRevision: ["Point one", "Point two"],
      caption: `Fixture caption ${code} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}\nComment your answer below.`,
      hashtags: ["#RUHSMO", "#MedicalMCQs", "#MockTestSeries"],
      origin: { kind: "manual" },
    };
    const saved = await posts.applyChange({ postId: post.id, expectedRevision: post.revision, content, note: "fixture content", actorId });
    const dto = await posts.getPostDto(saved.id);
    const errors = dto.issues.filter((i) => i.severity === "error");
    assert.equal(errors.length, 0, `fixture post has blocking issues: ${JSON.stringify(errors)}`);
    const warn = dto.issues.filter((i) => i.severity === "warning").map((i) => i.code);
    const all = Object.fromEntries(REVIEW_CHECKLIST.map((c) => [c.key, true]));
    const r = await posts.markReady({ postId: dto.id, expectedRevision: dto.revision, checklist: all, acknowledged: warn, actorId });
    assert.equal(r.post.status, "READY");
    return r.post;
  }
  const key = () => crypto.randomUUID();
  async function publish(post: { id: string; revision: number }, format: PublishFormat = "CAROUSEL") {
    const { job } = await startPublish({ postId: post.id, expectedRevision: post.revision, requestKey: key(), format, actorId });
    return runPublishJob(post.id, job.leaseId);
  }
  const resetMock = () => realFetch(`${base}/__mock/reset`).then((r) => r.json());
  const mockState = () => realFetch(`${base}/__mock/state`).then((r) => r.json()) as Promise<{ containers: { id: string; kind: string; carouselItem?: boolean; children?: string[]; caption: string }[]; media: { id: string; caption: string; media_type: string; containerId: string }[] }>;
  const row = (id: string) => prisma.instagramPost.findUniqueOrThrow({ where: { id } });

  try {
    console.log("\n--- A. Switch, approval and request validation ---");
    await setPublishingSwitch(false, actorId);
    installToken("valid");

    await check("switch OFF by default → publishing refused", async () => {
      assert.equal((await getPublishingSwitch()).enabled, false);
      const p = await readyPost();
      await assert.rejects(startPublish({ postId: p.id, expectedRevision: p.revision, requestKey: key(), format: "CAROUSEL", actorId }), /turned off/);
      assert.equal((await row(p.id)).status, "READY");
    });
    await setPublishingSwitch(true, actorId);

    await check("no token installed → refused before any claim", async () => {
      const p = await readyPost();
      delete process.env.INSTAGRAM_ACCESS_TOKEN;
      await assert.rejects(startPublish({ postId: p.id, expectedRevision: p.revision, requestKey: key(), format: "CAROUSEL", actorId }), /No Instagram access token/);
      installToken("valid");
      assert.equal((await row(p.id)).status, "READY");
    });

    await check("a DRAFT (not approved) post can't be published", async () => {
      const p = await readyPost();
      const d = await posts.backToDraft(p.id, actorId);
      await assert.rejects(startPublish({ postId: d.id, expectedRevision: d.revision, requestKey: key(), format: "CAROUSEL", actorId }), /approved \(Ready\)/);
    });

    await check("approval bypass: status forced to READY in the DB without a review → refused", async () => {
      const p = await readyPost();
      await prisma.instagramPost.update({ where: { id: p.id }, data: { reviewedAt: null, reviewedById: null, review: undefined } });
      await prisma.$executeRaw`UPDATE "InstagramPost" SET "review" = NULL WHERE id = ${p.id}`;
      await assert.rejects(startPublish({ postId: p.id, expectedRevision: p.revision, requestKey: key(), format: "CAROUSEL", actorId }), /not been approved/);
      // Approval for another revision doesn't count either.
      await prisma.$executeRaw`UPDATE "InstagramPost" SET "review" = '{"revision": 1}'::jsonb, "reviewedAt" = now(), "reviewedById" = ${actorId} WHERE id = ${p.id}`;
      await assert.rejects(startPublish({ postId: p.id, expectedRevision: p.revision, requestKey: key(), format: "CAROUSEL", actorId }), /not been approved/);
    });

    await check("stale tab: wrong expectedRevision → conflict; preflight reports caption, slides, account", async () => {
      const p = await readyPost();
      await assert.rejects(startPublish({ postId: p.id, expectedRevision: p.revision - 1, requestKey: key(), format: "CAROUSEL", actorId }), /changed in another window/);
      const pre = await publishPreflight(p.id, p.revision, "CAROUSEL");
      assert.equal(pre.username, "mocktestseries.in");
      assert.equal(pre.slideCount, p.design.modules.length);
      assert.equal(pre.caption, composeCaption(p.content));
      assert.equal(pre.enabled, true);
      assert.equal(pre.configured, true);
      assert.equal((await publishPreflight(p.id, p.revision, "IMAGE")).slideCount, 1);
    });

    await check("Question Bank edited after approval → publishing blocked (source changed)", async () => {
      const p = await readyPost();
      const before = await prisma.question.findUniqueOrThrow({ where: { id: p.questionId }, select: { text: true } });
      await prisma.question.update({ where: { id: p.questionId }, data: { text: before.text + " (edited)" } });
      try {
        await assert.rejects(startPublish({ postId: p.id, expectedRevision: p.revision, requestKey: key(), format: "CAROUSEL", actorId }), /Publishing blocked/);
      } finally {
        await prisma.question.update({ where: { id: p.questionId }, data: { text: before.text } });
      }
    });

    await check("publishing API refuses any account other than the pinned INSTAGRAM_USER_ID", async () => {
      const api = publishingApi()!;
      assert.throws(() => api.createImageContainer("17841499999999999", "http://127.0.0.1:1/x.jpg", {}), /pinned Instagram account/);
      assert.throws(() => api.publishContainer("17841499999999999", "1234567"), /pinned Instagram account/);
      assert.throws(() => api.containerStatus("../../me"), /Invalid Instagram object id/);
    });

    console.log("\n--- B. Carousel + single image publishing (mock Meta downloads every slide) ---");
    await resetMock();
    let carouselPostId = "";
    await check("carousel: READY → PUBLISHED with media ID, permalink, time; Meta fetched every slide as JPEG", async () => {
      const p = await readyPost();
      carouselPostId = p.id;
      const v = await publish(p);
      assert.equal(v.status, "PUBLISHED", JSON.stringify(v));
      const r = await row(p.id);
      assert.match(r.igMediaId ?? "", /^\d+$/);
      assert.match(r.igPermalink ?? "", /^https:\/\/www\.instagram\.com\/p\//);
      assert.ok(r.publishedAt && Date.now() - r.publishedAt.getTime() < 60_000);
      assert.equal(r.publishError, null);
      const st = await mockState();
      assert.equal(st.media.length, 1);
      assert.equal(st.media[0].media_type, "CAROUSEL_ALBUM");
      assert.equal(st.media[0].caption, composeCaption(p.content));
      const carousel = st.containers.find((c) => c.kind === "CAROUSEL")!;
      assert.equal(carousel.children!.length, p.design.modules.length);
      assert.equal(stats.imageFetches.length, p.design.modules.length);
      assert.ok(stats.imageFetches.every((f: { ok: boolean; bytes: number; url: string }) => f.ok && f.bytes > 10_000 && /\/api\/instagram-media\/[a-f0-9]{48}\/slide-\d\.jpg$/.test(f.url)));
      assert.equal(stats.publishCalls, 1);
      const audits = await prisma.auditLog.findMany({ where: { entityId: p.id, action: { startsWith: "INSTAGRAM_PUBLISH" } } });
      assert.ok(audits.some((a) => a.action === "INSTAGRAM_PUBLISH_STARTED"));
      assert.ok((await prisma.auditLog.count({ where: { entityId: p.id, action: "INSTAGRAM_PUBLISHED" } })) === 1);
    });

    await check("after publishing: public media copies are removed (URL → 404), post is locked, can't publish twice", async () => {
      const job = (await row(carouselPostId)).publishJob as { mediaToken: string };
      assert.equal(await readPublishMedia(job.mediaToken, "slide-1.jpg"), null);
      assert.equal(existsSync(path.join(process.env.STORAGE_DIR!, "instagram-publish", job.mediaToken)), false);
      const p = await posts.getPostDto(carouselPostId);
      assert.equal(p.publish.status, "PUBLISHED");
      assert.equal(p.igMediaId, (await row(carouselPostId)).igMediaId);
      await assert.rejects(posts.applyChange({ postId: p.id, expectedRevision: p.revision, note: "x", actorId }), /published post can't be edited/);
      await assert.rejects(startPublish({ postId: p.id, expectedRevision: p.revision, requestKey: key(), format: "CAROUSEL", actorId }), /already published/);
      assert.equal(stats.publishCalls, 1);
    });

    await check("single image: one container with the caption, not a carousel item; published as IMAGE", async () => {
      await resetMock();
      const p = await readyPost();
      const v = await publish(p, "IMAGE");
      assert.equal(v.status, "PUBLISHED");
      const st = await mockState();
      assert.equal(st.containers.length, 1);
      assert.equal(st.containers[0].kind, "IMAGE");
      assert.equal(st.containers[0].carouselItem, false);
      assert.equal(st.containers[0].caption, composeCaption(p.content));
      assert.equal(st.media[0].media_type, "IMAGE");
      assert.equal(stats.imageFetches.length, 1);
    });

    await check("slow processing (IN_PROGRESS) is waited out, then published once", async () => {
      await resetMock();
      installToken("slow");
      const p = await readyPost();
      const v = await publish(p);
      assert.equal(v.status, "PUBLISHED", JSON.stringify(v));
      assert.equal(stats.publishCalls, 1);
      installToken("valid");
    });

    console.log("\n--- C. Duplicate protection ---");
    await check("double click / several tabs: 6 concurrent claims → exactly one job", async () => {
      await resetMock();
      const p = await readyPost();
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => startPublish({ postId: p.id, expectedRevision: p.revision, requestKey: key(), format: "CAROUSEL", actorId })));
      const ok = results.filter((r) => r.status === "fulfilled");
      assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.status)));
      assert.ok(results.filter((r) => r.status === "rejected").every((r) => /already being published|changed in the meantime/.test(String((r as PromiseRejectedResult).reason))));
      const job = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof startPublish>>>).value.job;
      // Same confirmation re-sent (network retry) → the same job, no second claim.
      const again = await startPublish({ postId: p.id, expectedRevision: p.revision, requestKey: job.requestKey, format: "CAROUSEL", actorId });
      assert.equal(again.existing, true);
      assert.equal(again.job.jobId, job.jobId);
      // Two workers for one job: only the lease owner runs; a duplicate worker with a wrong lease does nothing.
      const [v1, v2] = await Promise.all([runPublishJob(p.id, job.leaseId), runPublishJob(p.id, "not-the-lease")]);
      assert.equal(v1.status, "PUBLISHED");
      assert.ok(v2.status === "PUBLISHING" || v2.status === "PUBLISHED");
      assert.equal(stats.publishCalls, 1);
      assert.equal((await mockState()).media.length, 1);
    });

    await check("one question: a second version can't publish while another is PUBLISHING (partial unique index)", async () => {
      const p = await readyPost(CODES[1]);
      await prisma.instagramPost.update({ where: { id: p.id }, data: { status: "PUBLISHING" } });
      // Second, older row of the same question pretending to be READY.
      const clone = await prisma.instagramPost.findUniqueOrThrow({ where: { id: p.id } });
      await prisma.instagramPost.update({ where: { id: p.id }, data: { supersededAt: new Date() } });
      const other = await prisma.instagramPost.create({
        data: { questionId: clone.questionId, questionCode: clone.questionCode, series: clone.series, version: clone.version + 1, status: "READY", revision: clone.revision, content: clone.content as object, design: clone.design as object, sourceSnapshot: clone.sourceSnapshot as object, sourceHash: clone.sourceHash, review: clone.review as object, reviewedAt: new Date(), reviewedById: actorId, createdById: actorId },
      });
      await assert.rejects(startPublish({ postId: other.id, expectedRevision: other.revision, requestKey: key(), format: "CAROUSEL", actorId }), /being published right now/);
      await prisma.instagramPost.deleteMany({ where: { questionId: clone.questionId } });
    });

    console.log("\n--- D. Failures: friendly message, nothing published, draft intact, safe retry ---");
    const failCases: [string, string, RegExp][] = [
      ["expired", "TOKEN_EXPIRED", /access token has expired/],
      ["invalid", "TOKEN_INVALID", /rejected the access token/],
      ["nopublish", "PERMISSION", /instagram_business_content_publish/],
      ["ratelimit", "RATE_LIMIT", /rate limit/],
      ["quotafull", "QUOTA", /publishing limit/],
      ["badimage", "INVALID_MEDIA", /could not use the slide images/],
      ["procerror", "PROCESSING", /could not process the media/],
      ["wrongid", "WRONG_ACCOUNT", /not @mocktestseries\.in/],
    ];
    for (const [scenario, category, msg] of failCases) {
      await check(`${scenario} → FAILED (${category}), nothing published, content unchanged`, async () => {
        await resetMock();
        const token = installToken(scenario);
        const p = await readyPost();
        const v = await publish(p);
        assert.equal(v.status, "FAILED", JSON.stringify(v));
        assert.equal(v.errorCategory, category);
        assert.match(v.publishError ?? "", msg);
        assert.equal(v.canRetry, true);
        assert.ok(!(v.publishError ?? "").includes(token) && !JSON.stringify(await row(p.id)).includes(token));
        assert.equal((await mockState()).media.length, 0);
        const after = await posts.getPostDto(p.id);
        assert.equal(after.revision, p.revision);
        assert.deepEqual(after.content, p.content);
        installToken("valid");
      });
    }

    await check("retry after a failure (token renewed) → published exactly once", async () => {
      await resetMock();
      installToken("expired");
      const p = await readyPost();
      assert.equal((await publish(p)).status, "FAILED");
      installToken("valid");
      const v = await publish(await posts.getPostDto(p.id));
      assert.equal(v.status, "PUBLISHED");
      assert.equal(stats.publishCalls, 1);
      assert.equal((await mockState()).media.length, 1);
    });

    await check("editing a FAILED post needs confirmation and sends it back to Draft (re-approval needed)", async () => {
      installToken("badimage");
      const p = await readyPost();
      assert.equal((await publish(p)).status, "FAILED");
      installToken("valid");
      const f = await posts.getPostDto(p.id);
      await assert.rejects(posts.applyChange({ postId: f.id, expectedRevision: f.revision, note: "x", actorId }), (e: Error & { kind?: string }) => e.kind === "needs-confirm");
      const d = await posts.applyChange({ postId: f.id, expectedRevision: f.revision, content: { ...f.content, memoryTrick: "Changed" }, note: "edit after failure", actorId, confirmReplaceApproved: true });
      assert.equal(d.status, "DRAFT");
      await assert.rejects(startPublish({ postId: d.id, expectedRevision: d.revision, requestKey: key(), format: "CAROUSEL", actorId }), /approved \(Ready\)/);
    });

    console.log("\n--- E. Lost responses, timeouts, restarts: reconcile, never re-publish blindly ---");
    for (const scenario of ["pubtimeout", "publost"]) {
      await check(`${scenario}: Meta published but the answer was lost → recorded as PUBLISHED (found via container status), one post`, async () => {
        await resetMock();
        installToken(scenario);
        const p = await readyPost();
        const v = await publish(p);
        assert.equal(v.status, "PUBLISHED", JSON.stringify(v));
        const st = await mockState();
        assert.equal(st.media.length, 1);
        assert.equal((await row(p.id)).igMediaId, st.media[0].id);
        assert.equal(stats.publishCalls, 1);
        installToken("valid");
      });
    }

    await check("media_publish failed (5xx) without publishing → FAILED; retry reuses the SAME container, one post", async () => {
      await resetMock();
      installToken("pubfailonce");
      const p = await readyPost();
      const v = await publish(p);
      assert.equal(v.status, "FAILED", JSON.stringify(v));
      assert.match(v.publishError ?? "", /Nothing was published/);
      const firstJob = (await row(p.id)).publishJob as { containerId: string };
      const fetchesBefore = stats.imageFetches.length;
      const v2 = await publish(await posts.getPostDto(p.id));
      assert.equal(v2.status, "PUBLISHED");
      const st = await mockState();
      assert.equal(st.media.length, 1);
      assert.equal(st.media[0].containerId, firstJob.containerId);
      assert.equal(stats.imageFetches.length, fetchesBefore, "no new uploads on retry");
      assert.equal(stats.publishCalls, 2);
      installToken("valid");
    });

    await check("Meta unreachable after media_publish → stays PUBLISHING (UNKNOWN, locked); no retry possible; reconcile resolves it", async () => {
      await resetMock();
      installToken("blackout");
      const p = await readyPost();
      const v = await publish(p);
      assert.equal(v.status, "PUBLISHING", JSON.stringify(v));
      assert.equal(v.stage, "UNKNOWN");
      assert.equal(v.needsReconcile, true);
      await assert.rejects(startPublish({ postId: p.id, expectedRevision: p.revision, requestKey: key(), format: "CAROUSEL", actorId }), /already being published/);
      await assert.rejects(posts.applyChange({ postId: p.id, expectedRevision: p.revision, note: "x", actorId }), /can't be edited/);
      const still = await reconcilePublish(p.id, actorId);
      assert.equal(still.status, "PUBLISHING");
      assert.equal(still.stage, "UNKNOWN");
      await realFetch(`${base}/__mock/control`, { method: "POST", body: JSON.stringify({ blackout: false }) });
      const done = await reconcilePublish(p.id, actorId);
      assert.equal(done.status, "PUBLISHED", JSON.stringify(done));
      const st = await mockState();
      assert.equal((await row(p.id)).igMediaId, st.media[0].id);
      assert.equal(stats.publishCalls, 1);
      installToken("valid");
    });

    await check("server restart before media_publish (stale worker) → auto-reconciled to FAILED/INTERRUPTED; retry publishes once", async () => {
      await resetMock();
      const p = await readyPost();
      const { job } = await startPublish({ postId: p.id, expectedRevision: p.revision, requestKey: key(), format: "CAROUSEL", actorId });
      // The worker "died" right after creating containers.
      const dead = { ...job, stage: "CONTAINERS", heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() };
      await prisma.$executeRaw`UPDATE "InstagramPost" SET "publishJob" = ${JSON.stringify(dead)}::jsonb WHERE id = ${p.id}`;
      const v = await getPublishStatus(p.id, actorId);
      assert.equal(v.status, "FAILED");
      assert.equal(v.errorCategory, "INTERRUPTED");
      assert.equal(stats.publishCalls, 0);
      // The dead worker coming back can't write anything (its lease was taken).
      const zombie = await runPublishJob(p.id, job.leaseId);
      assert.equal(zombie.status, "FAILED");
      assert.equal(stats.publishCalls, 0);
      const r = await publish(await posts.getPostDto(p.id));
      assert.equal(r.status, "PUBLISHED");
      assert.equal(stats.publishCalls, 1);
    });

    await check("server restart right after Meta published (worker died before saving) → status check records it, no second post", async () => {
      await resetMock();
      const p = await readyPost();
      const { job } = await startPublish({ postId: p.id, expectedRevision: p.revision, requestKey: key(), format: "CAROUSEL", actorId });
      const real = publishingApi()!;
      const crashing = { ...real, publishContainer: async (u: string, c: string) => (await real.publishContainer(u, c), Promise.reject(new Error("process killed"))) };
      const v = await runPublishJob(p.id, job.leaseId, crashing);
      assert.equal(v.status, "PUBLISHING");
      assert.equal(v.stage, "UNKNOWN");
      await assert.rejects(startPublish({ postId: p.id, expectedRevision: p.revision, requestKey: key(), format: "CAROUSEL", actorId }), /already being published/);
      const done = await getPublishStatus(p.id, actorId).then((x) => (x.needsReconcile ? reconcilePublish(p.id, actorId) : x));
      assert.equal(done.status, "PUBLISHED", JSON.stringify(done));
      const st = await mockState();
      assert.equal(st.media.length, 1);
      assert.equal((await row(p.id)).igMediaId, st.media[0].id);
      assert.equal(stats.publishCalls, 1);
    });

    await check("a live job is never taken over by a status check", async () => {
      const p = await readyPost();
      const { job } = await startPublish({ postId: p.id, expectedRevision: p.revision, requestKey: key(), format: "CAROUSEL", actorId });
      const v = await reconcilePublish(p.id, actorId);
      assert.equal(v.status, "PUBLISHING");
      assert.equal(((await row(p.id)).publishJob as { leaseId: string }).leaseId, job.leaseId);
      assert.equal((await runPublishJob(p.id, job.leaseId)).status, "PUBLISHED");
    });

    console.log("\n--- F. Media URLs, errors, secrets ---");
    await check("media route: unknown/malformed tokens and names → nothing; expired manifest → nothing", async () => {
      assert.equal(await readPublishMedia("0".repeat(48), "slide-1.jpg"), null);
      assert.equal(await readPublishMedia("../../etc", "slide-1.jpg"), null);
      assert.equal(await readPublishMedia("a".repeat(48), "../manifest.json"), null);
      const tok = "b".repeat(48);
      const dir = path.join(process.env.STORAGE_DIR!, "instagram-publish", tok);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "slide-1.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ postId: "x", jobId: "y", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString(), count: 1 }));
      assert.equal(await readPublishMedia(tok, "slide-1.jpg"), null);
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ postId: "x", jobId: "y", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), count: 1 }));
      assert.ok(await readPublishMedia(tok, "slide-1.jpg"));
      assert.equal(await readPublishMedia(tok, "slide-2.jpg"), null);
      assert.match(mediaUrl(tok, 0), /\/api\/instagram-media\/b{48}\/slide-1\.jpg$/);
    });

    await check("error classification covers token, permission, rate limit, media, outage", () => {
      const f = (o: Partial<Parameters<typeof classifyPublishFailure>[0]>) => classifyPublishFailure({ ok: false, kind: "http", httpStatus: 400, code: null, subcode: null, message: "m", ...o });
      assert.equal(f({ code: 190, subcode: 463 }).category, "TOKEN_EXPIRED");
      assert.equal(f({ code: 190 }).category, "TOKEN_INVALID");
      assert.equal(f({ code: 10 }).category, "PERMISSION");
      assert.equal(f({ code: 4 }).category, "RATE_LIMIT");
      assert.equal(f({ code: 9, subcode: 2207042 }).category, "QUOTA");
      assert.equal(f({ code: 9004, subcode: 2207052 }).category, "INVALID_MEDIA");
      assert.equal(f({ httpStatus: 503, code: 2 }).category, "UNAVAILABLE");
      assert.equal(f({ kind: "timeout" }).category, "UNAVAILABLE");
    });

    await check("no token anywhere: DB rows, audit log, settings, URLs/bodies sent, console", async () => {
      const dump = JSON.stringify([
        await prisma.instagramPost.findMany(),
        await prisma.auditLog.findMany({ where: { entityType: { in: ["InstagramPost", "Setting"] } } }),
        await prisma.setting.findMany({ where: { key: { startsWith: "instagram." } } }),
      ]);
      for (const t of tokens) {
        assert.ok(!dump.includes(t), "token in DB");
        assert.ok(!logged.some((l) => l.includes(t)), "token logged");
      }
      assert.ok(!/IGAAMOCK/.test(dump));
      assert.equal(stats.tokenInUrl, 0);
      assert.equal(stats.tokenInBody, 0);
      assert.equal(stats.missingAuth, 0);
      assert.equal(stray, 0, "outbound request outside the mocks");
    });

    await check("code: only publish.ts calls the publishing API; client components import no server module", () => {
      const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));
      const files = [...walk("app"), ...walk("components"), ...walk("lib")].filter((f) => /\.(ts|tsx)$/.test(f));
      const users = files.filter((f) => /publishingApi\(/.test(readFileSync(f, "utf8")));
      assert.deepEqual(users.sort(), ["lib/instagram/meta.ts", "lib/instagram/publish.ts"]);
      for (const f of files.filter((x) => readFileSync(x, "utf8").startsWith('"use client"'))) {
        const src = readFileSync(f, "utf8");
        assert.ok(!/from "@\/lib\/instagram\/(publish|meta)"/.test(src.replace(/import type [^;]+;/g, "")), `${f} imports a server module`);
      }
      const route = readFileSync("app/api/instagram-media/[token]/[file]/route.ts", "utf8");
      assert.ok(!/prisma|requirePermission|question/i.test(route.replace(/\/\*[\s\S]*?\*\//, "")), "public media route touches nothing else");
      const pub = readFileSync("lib/instagram/publish.ts", "utf8");
      assert.ok(!/scheduled_publish_time|setInterval|cron/i.test(pub), "no scheduling");
    });
  } finally {
    globalThis.fetch = realFetch;
    graph.close();
    media.close();
    await setPublishingSwitch(false, actorId).catch(() => {});
    await prisma.$disconnect();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
