/**
 * NEET Phase 2 — scientific media & QuestionAsset engine (server side).
 *
 * Proves against a DISPOSABLE database and a DISPOSABLE storage root:
 *  - validation: PNG/JPEG/WebP/AVIF accepted by DECODED type; SVG, HTML,
 *    executables, disguised files, mismatched MIME/extension, unsafe names,
 *    corrupt/truncated, animated, tiny, oversized and bomb images refused;
 *  - processing: auto-orient, EXIF/GPS/ICC stripped, no upscaling, 1600 px
 *    cap, lossless WebP for line art (pixel-exact), lossy fallback for photos;
 *  - storage: content-addressed keys, never overwritten, verified on reuse,
 *    no absolute paths / base64 in the DB, exact-duplicate dedup;
 *  - QuestionAsset: multiple QUESTION images, A–D OPTION images, multiple
 *    EXPLANATION images, alt policy, replace = new file + old file kept,
 *    remove = reference only;
 *  - snapshot v2 history: an attempt frozen with image A still shows A after
 *    the question is switched to image B; a new attempt shows B;
 *  - the DRAFT-only content-format guard.
 *
 *   STORAGE_DIR=<scratch dir> DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" \
 *     npx tsx scripts/verify-media-engine.ts
 *
 * `setup` / `cleanup <fixture.json>` prepare scripts/verify-media-engine.mjs.
 */
import "dotenv/config";
import { readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import argon2 from "argon2";
import sharp from "sharp";
import { PrismaClient, QuestionDifficulty, QuestionSource, QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { MEDIA_LIMITS, MediaValidationError, processScientificImage, storeScientificImage } from "@/lib/media-processing";
import { isContentAddressedKey, mediaRootDir, mediaStorage, sha256Hex, storageKeyFor } from "@/lib/media-storage";
import { attachQuestionAsset, QuestionMediaError, removeQuestionAsset, setQuestionRichFields, updateQuestionAsset } from "@/lib/question-media-admin";
import { startPreviousYearPaperAttempt, submitAttempt, type QuestionSnapshot } from "@/lib/test-attempt";
import { explanationView, richQuestionView } from "@/lib/rich-content";
import { toPlayerQuestions } from "@/lib/test-player-data";
import { nextStudentId } from "@/lib/student-id";
import { ensureDefaultExamEnrollmentSafely } from "@/lib/default-enrollment";
import { createFixtureSubject, createFixtureTopic, deleteFixtureTaxonomy } from "./fixture-taxonomy";
import { DRAWING_NAMES, animatedWebp, bombPng, diagramAs, diagramPng, noisePng, photoWithExif, solidPng, type DrawingName } from "./media-fixtures";

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "") && process.env.ALLOW_PRODUCTION_DB !== "1") {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
if (!process.env.STORAGE_DIR || process.env.STORAGE_DIR.startsWith("/var/www/mocktestseries-shared")) {
  console.error("Set STORAGE_DIR to a disposable directory (never the shared production storage).");
  process.exit(2);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (!passed) failures++;
}
const info = (s: string) => console.log(`  INFO  ${s}`);

async function rejected(fn: () => Promise<unknown>, re?: RegExp): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!(e instanceof MediaValidationError) && !(e instanceof QuestionMediaError)) return `UNEXPECTED ${e instanceof Error ? e.name : ""}: ${msg}`;
    return re && !re.test(msg) ? `WRONG MESSAGE: ${msg}` : msg;
  }
}
const ok = (r: string | null) => r !== null && !r.startsWith("UNEXPECTED") && !r.startsWith("WRONG");

// ---------------------------------------------------------------------------
// Fixture question builder (shared with setup)
// ---------------------------------------------------------------------------

async function seedExam(suffix: string) {
  const exam = await prisma.exam.create({ data: { name: `MED Exam ${suffix}`, code: `MED-${suffix}`, isActive: true } });
  const subject = await createFixtureSubject(prisma, { examId: exam.id, name: "MED Science" });
  const topic = await createFixtureTopic(prisma, { subjectId: subject.id, name: "MED Topic" });
  const paper = await prisma.previousYearPaper.create({ data: { examId: exam.id, year: 2026, title: `MED Paper ${suffix}`, isActive: true } });
  return { examId: exam.id, subjectId: subject.id, topicId: topic.id, paperId: paper.id };
}

let qSeq = 0;
async function richQuestion(
  f: { examId: string; subjectId: string; topicId: string; paperId: string | null },
  suffix: string,
  text: string,
  options: string[] = ["A option", "B option", "C option", "D option"],
  extra: { explanation?: string; status?: QuestionStatus; createdAt?: Date } = {}
) {
  qSeq++;
  return prisma.question.create({
    data: {
      examId: f.examId,
      subjectId: f.subjectId,
      topicId: f.topicId,
      previousYearPaperId: f.paperId,
      source: QuestionSource.PYQ,
      examYear: 2026,
      code: `MED-${suffix}-${String(qSeq).padStart(3, "0")}`,
      text,
      contentFormat: "RICH_V1",
      explanation: extra.explanation ?? null,
      status: extra.status ?? QuestionStatus.PUBLISHED,
      difficulty: QuestionDifficulty.MEDIUM,
      createdAt: extra.createdAt ?? new Date(Date.now() - 1_000_000 + qSeq * 1000),
      options: { create: ["A", "B", "C", "D"].map((label, order) => ({ label, text: options[order], isCorrect: label === "A", order })) },
    },
  });
}

async function attach(questionId: string, drawing: DrawingName, role: string, alt: string, opts: { optionLabel?: string; order?: number; format?: "png" | "jpeg" | "webp" | "avif"; darkBacking?: boolean; scale?: number } = {}) {
  const fmt = opts.format ?? "png";
  const bytes = await diagramAs(drawing, fmt, opts.scale ?? 2);
  return attachQuestionAsset({
    questionId,
    actorId: null,
    file: { bytes, filename: `${drawing}.${fmt === "jpeg" ? "jpg" : fmt}`, mime: `image/${fmt}` },
    role,
    optionLabel: opts.optionLabel,
    order: opts.order,
    alt,
    darkBacking: opts.darkBacking ?? true,
  });
}

/** The 12 Phase 2 acceptance fixtures, as PUBLISHED RICH_V1 questions of one active paper. */
async function seedScientificPaper(f: Awaited<ReturnType<typeof seedExam>>, suffix: string) {
  const ids: Record<string, string> = {};
  const q = async (key: string, text: string, options?: string[], explanation?: string) => {
    const row = await richQuestion(f, suffix, text, options, { explanation });
    ids[key] = row.id;
    return row.id;
  };
  // 1 + 10: circuit, text + KaTeX + image
  await attach(await q("circuit", "In the circuit shown, find the current $I$ drawn from the cell if $R_{eq} = R_1 + \\frac{R_2 R_3}{R_2 + R_3}$.", ["$1\\ \\mathrm{A}$", "$2\\ \\mathrm{A}$", "$3\\ \\mathrm{A}$", "$4\\ \\mathrm{A}$"]), "circuit", "QUESTION", "Circuit: 12 V cell, R1 = 4 ohm in series with R2 = 6 ohm and R3 = 3 ohm in parallel");
  // 2: graph
  await attach(await q("graph", "The velocity–time graph of a car is shown. Find the distance travelled in $14\\ \\mathrm{s}$.\n$$s = \\int_0^{14} v\\,dt$$", ["$200\\ \\mathrm{m}$", "$180\\ \\mathrm{m}$", "$160\\ \\mathrm{m}$", "$220\\ \\mathrm{m}$"]), "graph", "QUESTION", "Velocity-time graph rising to 20 m/s at 4 s, constant until 10 s, falling to zero at 14 s");
  // 3: ray optics
  await attach(await q("ray", "For the convex lens shown, the image formed is:", ["Real and inverted", "Virtual and erect", "Real and erect", "Virtual and inverted"]), "ray", "QUESTION", "Ray diagram: object beyond F of a convex lens forming a real inverted image");
  // 4: biology labelled diagram
  await attach(await q("biology", "Identify the structure labelled X in the diagram of the human heart.", ["Aorta", "Pulmonary vein", "Vena cava", "Pulmonary artery"]), "biology", "QUESTION", "Longitudinal section of the human heart with four chambers labelled and a vessel marked X");
  // 5 + 11: molecule + mhchem
  await attach(await q("molecule", "The compound shown, $\\ce{C6H5OH}$, reacts with $\\ce{Br2(aq)}$ to give:", ["$\\ce{2,4,6-tribromophenol}$", "$\\ce{o-bromophenol}$", "$\\ce{p-bromophenol}$", "no reaction"]), "benzene", "QUESTION", "Structure of phenol: benzene ring with an OH group");
  // 6 + 7: reaction diagram + 4 structure options (text empty)
  const rx = await q("reaction", "Identify the major product $\\ce{X}$ of the reaction shown.", ["", "", "", ""]);
  await attach(rx, "reaction", "QUESTION", "Ethanol heated with concentrated sulphuric acid at 443 K giving a product and water");
  await attach(rx, "ethene", "OPTION", "Structure A: ethene, H2C=CH2", { optionLabel: "A" });
  await attach(rx, "ethanal", "OPTION", "Structure B: ethanal", { optionLabel: "B" });
  await attach(rx, "ether", "OPTION", "Structure C: diethyl ether", { optionLabel: "C" });
  await attach(rx, "acid", "OPTION", "Structure D: ethanoic acid", { optionLabel: "D" });
  // 8: two ordered images in one question (attached out of order on purpose)
  const two = await q("twoImages", "Compare figure 1 (the graph) with figure 2 (the circuit).");
  await attach(two, "circuit", "QUESTION", "Figure 2: the circuit", { order: 1 });
  await attach(two, "graph", "QUESTION", "Figure 1: the graph", { order: 0 });
  // 9: explanation with two images
  const ex = await q("explained", "A ray goes from glass ($n = 1.5$) to air. Find the critical angle $C$.", ["$\\sin^{-1}(2/3)$", "$\\sin^{-1}(1/3)$", "$45^\\circ$", "$90^\\circ$"], "By Snell's law $$\\sin C = \\frac{1}{n} = \\frac{2}{3}$$ Beyond $C$ the ray is totally reflected.");
  await attach(ex, "snell", "EXPLANATION", "Ray at the critical angle grazing the surface", { order: 0 });
  await attach(ex, "tir", "EXPLANATION", "Total internal reflection for an angle greater than C", { order: 1 });
  // 12: transparent black-line diagram in dark mode — every fixture above is one; this one is decorative-policy.
  const dec = await q("decorative", "A decorative divider is shown (no information in it).");
  await attachQuestionAsset({ questionId: dec, actorId: null, file: { bytes: await solidPng(400, 40), filename: "divider.png", mime: "image/png" }, role: "QUESTION", decorative: true });
  return ids;
}

async function cleanupExam(examId: string, studentIds: string[]) {
  await prisma.studentActivity.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.savedQuestion.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.testAttempt.deleteMany({ where: { OR: [{ studentId: { in: studentIds } }, { examId }] } });
  await prisma.question.deleteMany({ where: { examId } });
  await prisma.previousYearPaper.deleteMany({ where: { examId } });
  await prisma.studentExamEnrollment.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentSession.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.studentDevice.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await deleteFixtureTaxonomy(prisma, [examId]);
  await prisma.exam.deleteMany({ where: { id: examId } });
}

// ---------------------------------------------------------------------------

async function main() {
  const suffix = Date.now().toString(36);
  const students: string[] = [];
  const mkStudent = async (tag: string) => {
    const s = await prisma.student.create({ data: { studentId: `MED${tag}-${suffix}`, name: `MED ${tag}`, email: `med-${tag.toLowerCase()}-${suffix}@example.test`, authProvider: StudentAuthProvider.CREDENTIALS } });
    students.push(s.id);
    return s.id;
  };
  console.log(`storage root: ${mediaRootDir()}`);

  console.log("\n--- Accepted inputs (decoded type) and processing ---");
  for (const fmt of ["png", "jpeg", "webp", "avif"] as const) {
    const img = await processScientificImage(await diagramAs("circuit", fmt, 1), { declaredMime: `image/${fmt}`, filename: `c.${fmt === "jpeg" ? "jpg" : fmt}` });
    check(`${fmt.toUpperCase()} accepted → WebP ${img.width}×${img.height}`, img.mime === "image/webp" && img.width === 640 && img.height === 360 && img.original.mime === `image/${fmt}`);
  }
  const pngIn = await diagramPng("circuit", 2);
  const pngOut = await processScientificImage(pngIn, { filename: "circuit.png" });
  check("line-art PNG → LOSSLESS WebP", pngOut.bytes.toString("ascii", 12, 16) === "VP8L");
  const a = await sharp(pngIn).ensureAlpha().raw().toBuffer();
  const b = await sharp(pngOut.bytes).ensureAlpha().raw().toBuffer();
  check("lossless output is pixel-identical (thin lines/labels intact)", a.equals(b));
  check("transparency kept (no flattening/recolouring)", (await sharp(pngOut.bytes).metadata()).hasAlpha === true);
  info(`circuit 1280×720 PNG ${(pngIn.length / 1024).toFixed(1)} KiB → WebP ${(pngOut.bytes.length / 1024).toFixed(1)} KiB`);
  const small = await processScientificImage(await diagramPng("ethene", 1));
  check("small diagram is never upscaled", small.width === 260 && small.height === 160);
  const big = await processScientificImage(await diagramPng("reaction", 3));
  check(`oversized image scaled to fit 1600 px (2580 → ${big.width}) keeping aspect`, big.width === MEDIA_LIMITS.maxOutputWidth && Math.abs(big.width / big.height - 2580 / 780) < 0.01, { w: big.width, h: big.height });
  const tall = await processScientificImage(await diagramPng("biology", 5));
  check(`tall diagram fits 2400 px height (${tall.width}×${tall.height})`, tall.height <= MEDIA_LIMITS.maxOutputHeight && tall.width <= MEDIA_LIMITS.maxOutputWidth);

  console.log("\n--- Metadata / orientation ---");
  const photoIn = await photoWithExif();
  const inMeta = await sharp(photoIn).metadata();
  const photo = await processScientificImage(photoIn, { declaredMime: "image/jpeg", filename: "scan.jpg" });
  const outMeta = await sharp(photo.bytes).metadata();
  check("input fixture really has EXIF orientation 6 + GPS + camera model", inMeta.orientation === 6 && !!inMeta.exif && inMeta.exif.includes(Buffer.from("Secret Device")));
  check("EXIF orientation applied (600×400 → 400×600)", photo.width === 400 && photo.height === 600, { w: photo.width, h: photo.height });
  check("no EXIF / XMP / ICC / IPTC in output", !outMeta.exif && !outMeta.xmp && !outMeta.icc && !outMeta.iptc && !photo.bytes.includes(Buffer.from("Secret Device")) && !photo.bytes.includes(Buffer.from("GPS")));
  check("JPEG photo → lossy WebP", photo.bytes.toString("ascii", 12, 16) === "VP8 ");
  const noiseIn = await noisePng();
  const noise = await processScientificImage(noiseIn);
  const noiseLossless = await sharp(noiseIn).webp({ lossless: true, effort: 5 }).toBuffer();
  check(
    `photographic PNG (lossless would be ${(noiseLossless.length / 1024).toFixed(0)} KiB) falls back to lossy (${(noise.bytes.length / 1024).toFixed(0)} KiB)`,
    noiseLossless.length > MEDIA_LIMITS.losslessCeilingBytes && noise.bytes.toString("ascii", 12, 16) === "VP8 " && noise.bytes.length < noiseLossless.length
  );

  console.log("\n--- Rejected inputs ---");
  const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert(1)</script><rect width="100" height="100"/></svg>');
  const cases: [string, () => Promise<unknown>, RegExp?][] = [
    ["SVG", () => processScientificImage(svgBytes, { filename: "x.svg", declaredMime: "image/svg+xml" })],
    ["SVG disguised as .png", () => processScientificImage(svgBytes, { filename: "x.png", declaredMime: "image/png" }), /Unsupported image type|not a readable/],
    ["HTML disguised as .png", () => processScientificImage(Buffer.from("<!doctype html><script>alert(1)</script>"), { filename: "x.png" }), /not a readable/],
    ["ELF executable as .png", () => processScientificImage(Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(200)]), { filename: "x.png" }), /not a readable/],
    ["PE (MZ) executable as .jpg", () => processScientificImage(Buffer.concat([Buffer.from("MZ"), Buffer.alloc(300)]), { filename: "x.jpg" }), /not a readable/],
    ["PNG bytes sent as image/jpeg", () => processScientificImage(pngIn, { declaredMime: "image/jpeg", filename: "x.png" }), /sent as image\/jpeg/],
    ["PNG bytes named .jpg", () => processScientificImage(pngIn, { filename: "x.jpg" }), /name ends in \.jpg/],
    ["truncated PNG", () => processScientificImage(pngIn.subarray(0, Math.floor(pngIn.length / 2)), { filename: "x.png" })],
    ["corrupted bytes in PNG body", async () => {
      const c = Buffer.from(pngIn);
      for (let i = 200; i < c.length - 20; i += 7) c[i] ^= 0xff;
      return processScientificImage(c, { filename: "x.png" });
    }],
    ["GIF", async () => processScientificImage(await sharp(pngIn).gif().toBuffer(), { filename: "x.png" }), /Unsupported image type/],
    ["animated WebP", async () => processScientificImage(await animatedWebp(), { filename: "x.webp" }), /Animated/],
    ["decompression bomb (20000×20000 header, 112 bytes)", async () => processScientificImage(await bombPng(), { filename: "x.png" })],
    ["9000×6000 (54 MP, over 40 MP)", async () => processScientificImage(await bombPng(9000).then(async () => sharp({ create: { width: 9000, height: 6000, channels: 3, background: "#fff" } }).png({ compressionLevel: 9 }).toBuffer()), { filename: "x.png" })],
    ["8×8 too small", async () => processScientificImage(await solidPng(8, 8), { filename: "x.png" }), /at least 16 px/],
    ["over 8 MB", async () => processScientificImage(Buffer.alloc(MEDIA_LIMITS.maxUploadBytes + 1, 1), { filename: "x.png" }), /at most 8 MB/],
    ["empty file", () => processScientificImage(Buffer.alloc(0)), /empty/],
    ["path traversal name ../../x.png", () => processScientificImage(pngIn, { filename: "../../x.png" }), /path/],
    ["dot-file .htaccess.png", () => processScientificImage(pngIn, { filename: ".htaccess.png" }), /dot/],
    ["directory name a/b.png", () => processScientificImage(pngIn, { filename: "a/b.png" }), /path/],
    ["name with control chars", () => processScientificImage(pngIn, { filename: "x\u0007.png" }), /unsafe/],
  ];
  for (const [label, fn, re] of cases) {
    const r = await rejected(fn, re);
    check(`refused: ${label}${r ? `  (“${r.slice(0, 70)}”)` : ""}`, ok(r), r);
  }

  console.log("\n--- Content-addressed immutable storage ---");
  const stored = await storeScientificImage(pngIn, { filename: "circuit.png", declaredMime: "image/png" });
  const file = path.join(mediaRootDir(), stored.storageKey);
  check("key is q/<aa>/<sha256>.webp of the stored bytes", isContentAddressedKey(stored.storageKey) && stored.storageKey === storageKeyFor(stored.sha256, "webp") && stored.storageKey.slice(2, 4) === stored.sha256.slice(0, 2));
  check("file exists and its sha256 matches the key", existsSync(file) && sha256Hex(readFileSync(file)) === stored.sha256);
  check("file mode 0644 (world-readable for nginx, not writable)", (statSync(file).mode & 0o777) === 0o644);
  const mtime = statSync(file).mtimeMs;
  const again = await storeScientificImage(pngIn, { filename: "circuit-copy.png" });
  check("exact duplicate upload → same key, no new file (dedup)", again.storageKey === stored.storageKey && again.created === false && statSync(file).mtimeMs === mtime);
  check("one MediaObject row for the duplicate", (await prisma.mediaObject.count({ where: { sha256: stored.sha256 } })) === 1);
  const asLosslessWebp = await sharp(pngIn).webp({ lossless: true }).toBuffer();
  const viaWebp = await storeScientificImage(asLosslessWebp, { filename: "circuit.webp" });
  check("same pixels from a different file (lossless WebP) → same processed file", viaWebp.storageKey === stored.storageKey, { a: stored.storageKey, b: viaWebp.storageKey });
  // Unique to this run, so a re-run never meets the previous run's tampered file.
  const otherBytes = (await processScientificImage(await solidPng(100 + (Date.now() % 400), 60))).bytes;
  const overwrite = await mediaStorage()
    .put(stored.storageKey, otherBytes)
    .then(() => "written")
    .catch((e: Error) => e.message);
  check("put() refuses bytes that don't match the key (never overwrites)", overwrite !== "written" && sha256Hex(readFileSync(file)) === stored.sha256, overwrite);
  writeFileSync(path.join(mediaRootDir(), "tamper-probe"), "x");
  const tamperKey = storageKeyFor(sha256Hex(otherBytes), "webp");
  await mediaStorage().put(tamperKey, otherBytes);
  const tamperFile = path.join(mediaRootDir(), tamperKey);
  writeFileSync(tamperFile, Buffer.from("corrupted on disk"));
  const reput = await mediaStorage()
    .put(tamperKey, otherBytes)
    .then(() => "accepted")
    .catch((e: Error) => e.message);
  check("an existing file whose content no longer matches is reported, never silently replaced", /does not match its hash/.test(reput) && readFileSync(tamperFile).toString() === "corrupted on disk", reput);
  const badKeys = ["../x.webp", "/etc/passwd", "q/../../x.webp", "q/zz/abc.webp", `q/${"a".repeat(64)}.svg`];
  let keyRefused = 0;
  for (const k of badKeys) await mediaStorage().put(k, otherBytes).catch(() => keyRefused++);
  check("driver refuses non content-addressed / traversal keys", keyRefused === badKeys.length);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => storeScientificImage(pngIn, { filename: "c.png" })));
  check("8 concurrent identical uploads → one key, one row", new Set(concurrent.map((c) => c.storageKey)).size === 1 && (await prisma.mediaObject.count({ where: { sha256: stored.sha256 } })) === 1);

  const f = await seedExam(suffix);
  try {
    console.log("\n--- QuestionAsset integration (12 scientific fixtures) ---");
    const ids = await seedScientificPaper(f, suffix);
    const assetsOf = (key: string) => prisma.questionAsset.findMany({ where: { questionId: ids[key] }, orderBy: [{ role: "asc" }, { optionLabel: "asc" }, { order: "asc" }] });
    for (const key of ["circuit", "graph", "ray", "biology", "molecule"]) {
      const as = await assetsOf(key);
      check(`${key}: one QUESTION image with alt, dims, content-addressed key`, as.length === 1 && as[0].role === "QUESTION" && as[0].alt.length > 10 && as[0].width > 0 && isContentAddressedKey(as[0].storageKey));
    }
    const rx = await assetsOf("reaction");
    check("reaction: diagram + A–D structure option images", rx.filter((x) => x.role === "QUESTION").length === 1 && JSON.stringify(rx.filter((x) => x.role === "OPTION").map((x) => x.optionLabel)) === '["A","B","C","D"]');
    const two = await assetsOf("twoImages");
    check("two QUESTION images keep their explicit order", two.length === 2 && two[0].alt.startsWith("Figure 1") && two[1].alt.startsWith("Figure 2"));
    const ex = await assetsOf("explained");
    check("two EXPLANATION images, ordered", ex.length === 2 && ex.every((x) => x.role === "EXPLANATION") && ex[0].order === 0 && ex[1].order === 1);
    const dec = await assetsOf("decorative");
    check("decorative image stored with alt=\"\" (explicit policy)", dec.length === 1 && dec[0].alt === "");
    const twoCircuit = two.find((x) => x.alt.startsWith("Figure 2"))!;
    const circuitAsset = (await assetsOf("circuit"))[0];
    check("same image on two questions shares one file (separate references)", twoCircuit.storageKey === circuitAsset.storageKey && twoCircuit.id !== circuitAsset.id);

    console.log("\n--- Alt / role / format rules ---");
    const qid = ids.ray;
    const png = await diagramPng("ray", 1);
    const tryAttach = (o: Record<string, unknown>) => rejected(() => attachQuestionAsset({ questionId: qid, actorId: null, file: { bytes: png, filename: "ray.png", mime: "image/png" }, role: "QUESTION", ...o }));
    check("missing alt refused", ok(await tryAttach({ alt: "" })));
    check("filename as alt refused", ok(await tryAttach({ alt: "ray.png" })));
    check("'IMG_1234' as alt refused", ok(await tryAttach({ alt: "IMG_1234" })));
    check("unknown role refused", ok(await tryAttach({ role: "BACKGROUND", alt: "A real description" })));
    check("OPTION without a valid label refused", ok(await tryAttach({ role: "OPTION", optionLabel: "E", alt: "A real description" })));
    check("order out of range refused", ok(await tryAttach({ order: 500, alt: "A real description" })));
    const plainQ = await prisma.question.create({ data: { examId: f.examId, subjectId: f.subjectId, code: `MED-${suffix}-plain`, text: "Plain $x$", options: { create: [{ label: "A", text: "a", isCorrect: true }, { label: "B", text: "b" }] } } });
    check("images cannot be attached to a PLAIN question", ok(await rejected(() => attachQuestionAsset({ questionId: plainQ.id, actorId: null, file: { bytes: png, filename: "r.png", mime: "image/png" }, role: "QUESTION", alt: "A real description" }))));
    const pubPlain = await prisma.question.create({ data: { examId: f.examId, subjectId: f.subjectId, code: `MED-${suffix}-pub`, text: "Published plain", status: "PUBLISHED", options: { create: [{ label: "A", text: "a", isCorrect: true }, { label: "B", text: "b" }] } } });
    check("PUBLISHED question's format can't be changed (RUHS-safe)", ok(await rejected(() => setQuestionRichFields({ questionId: pubPlain.id, actorId: null, contentFormat: "RICH_V1" }))));
    check("PUBLISHED question format unchanged", (await prisma.question.findUnique({ where: { id: pubPlain.id } }))!.contentFormat === "PLAIN");
    const drafted = await setQuestionRichFields({ questionId: plainQ.id, actorId: null, contentFormat: "RICH_V1", explanation: "E = mc^2" });
    check("DRAFT question can become RICH_V1 + get an explanation", drafted.contentFormat === "RICH_V1" && drafted.explanation === "E = mc^2");
    const updated = await updateQuestionAsset({ questionId: ids.ray, assetId: (await assetsOf("ray"))[0].id, actorId: null, alt: "Updated ray diagram description", darkBacking: false, order: 3 });
    check("alt / darkBacking / order editable", updated.alt === "Updated ray diagram description" && updated.darkBacking === false && updated.order === 3);
    check("asset of another question can't be edited through this one", ok(await rejected(() => updateQuestionAsset({ questionId: ids.graph, assetId: updated.id, actorId: null, alt: "x y z" }))));

    console.log("\n--- No paths / bytes in the database ---");
    const leaks = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "QuestionAsset" WHERE "storageKey" LIKE '/%' OR "storageKey" LIKE '%var/www%' OR "storageKey" LIKE '%..%' OR length("storageKey") > 120`;
    check("no absolute / traversal storage keys", Number(leaks[0].n) === 0);
    const b64 = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "QuestionAsset" WHERE "storageKey" LIKE 'data:%' OR length(alt) > 600`;
    check("no base64/data URLs stored", Number(b64[0].n) === 0);
    const mo = await prisma.mediaObject.findUnique({ where: { sha256: circuitAsset.sha256 } });
    check("MediaObject records original + delivered dims, bytes, MIME, hashes", !!mo && mo.originalWidth > 0 && mo.originalBytes > 0 && mo.originalMime === "image/png" && mo.mime === "image/webp" && mo.originalSha256.length === 64);

    console.log("\n--- Snapshot V2 history: replace image A → B ---");
    const hist = await richQuestion({ ...f, paperId: null }, suffix, "History check: which figure is shown? $x^2$");
    const histPaper = await prisma.previousYearPaper.create({ data: { examId: f.examId, year: 2025, title: `MED History ${suffix}`, isActive: true } });
    await prisma.question.update({ where: { id: hist.id }, data: { previousYearPaperId: histPaper.id } });
    const { asset: imgA } = await attach(hist.id, "graph", "QUESTION", "Image A: the graph");
    const s1 = await mkStudent("H1");
    const oldAttempt = await startPreviousYearPaperAttempt(s1, histPaper.id, { answerMode: "EXAM", durationMode: "FIXED" });
    const { asset: imgB } = await attachQuestionAsset({ questionId: hist.id, actorId: null, file: { bytes: await diagramPng("circuit", 1.5), filename: "b.png", mime: "image/png" }, role: "QUESTION", alt: "Image B: the circuit", replaceAssetId: imgA.id });
    check("replace created a NEW file (different key)", imgB.storageKey !== imgA.storageKey);
    check("old reference row removed, old FILE kept", !(await prisma.questionAsset.findUnique({ where: { id: imgA.id } })) && existsSync(path.join(mediaRootDir(), imgA.storageKey)));
    check("replacement keeps the slot (role/order)", imgB.role === "QUESTION" && imgB.order === imgA.order);
    await submitAttempt(oldAttempt.id, s1);
    const oldSnap = (await prisma.testAttemptQuestion.findFirst({ where: { attemptId: oldAttempt.id } }))!.questionSnapshot as unknown as QuestionSnapshot;
    const oldView = richQuestionView(oldSnap)!;
    check("OLD attempt still renders Image A after the edit", oldView.assets.length === 1 && oldView.assets[0].url === `/media/${imgA.storageKey}` && oldView.assets[0].alt === "Image A: the graph");
    const s2 = await mkStudent("H2");
    const newAttempt = await startPreviousYearPaperAttempt(s2, histPaper.id, { answerMode: "EXAM", durationMode: "FIXED" });
    const newRows = await prisma.testAttempt.findUnique({ where: { id: newAttempt.id }, include: { questions: { include: { answer: true } } } });
    const newView = toPlayerQuestions(newRows!.questions, { instantMode: false })[0].rich!;
    check("NEW attempt renders Image B", newView.assets.length === 1 && newView.assets[0].url === `/media/${imgB.storageKey}`);
    await removeQuestionAsset({ questionId: hist.id, assetId: imgB.id, actorId: null });
    check("remove = reference only; Image B's file kept", (await prisma.questionAsset.count({ where: { questionId: hist.id } })) === 0 && existsSync(path.join(mediaRootDir(), imgB.storageKey)));
    check("the running attempt still has Image B frozen", toPlayerQuestions((await prisma.testAttempt.findUnique({ where: { id: newAttempt.id }, include: { questions: { include: { answer: true } } } }))!.questions, { instantMode: false })[0].rich!.assets[0].url === `/media/${imgB.storageKey}`);
    const audit = await prisma.auditLog.findMany({ where: { entityType: "Question", entityId: hist.id }, orderBy: { createdAt: "asc" }, select: { action: true } });
    check("audit trail: attached → replaced → removed", JSON.stringify(audit.map((x) => x.action)) === '["QUESTION_ASSET_ATTACHED","QUESTION_ASSET_REPLACED","QUESTION_ASSET_REMOVED"]', audit);

    console.log("\n--- Explanation images stay out of the player ---");
    const s3 = await mkStudent("P1");
    const run = await startPreviousYearPaperAttempt(s3, f.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
    const rows = (await prisma.testAttempt.findUnique({ where: { id: run.id }, include: { questions: { orderBy: { order: "asc" }, include: { answer: true } } } }))!.questions;
    const payload = toPlayerQuestions(rows, { instantMode: false });
    const json = JSON.stringify(payload);
    const explKeys = ex.map((x) => x.storageKey);
    check("no EXPLANATION image key in the Exam Mode payload", explKeys.every((k) => !json.includes(k)));
    const exRow = rows.find((r) => r.questionId === ids.explained)!;
    const ev = explanationView(exRow.questionSnapshot as never)!;
    check("review/reveal view has both explanation images", ev.assets.length === 2 && ev.assets.every((x) => x.url.startsWith("/media/q/")));
    const rxPayload = payload.find((p) => p.questionId === ids.reaction)!;
    check("player carries reaction diagram + 4 option images (all /media/ URLs)", rxPayload.rich!.assets.length === 5 && rxPayload.rich!.assets.every((x) => x.url.startsWith("/media/q/")));
  } finally {
    console.log("\nCleaning up fixture data (DB only; scratch files stay with the scratch dir)...");
    await cleanupExam(f.examId, students);
    await prisma.mediaObject.deleteMany({});
    await prisma.$disconnect();
  }

  console.log(failures === 0 ? "\nALL MEDIA ENGINE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Browser fixture
// ---------------------------------------------------------------------------

const HTTP_PASSWORD = "MediaEngine!2345";

async function setup() {
  const suffix = Date.now().toString(36);
  // The browser suite uploads some of these through the admin UI/API (FX_DIR).
  if (process.env.FX_DIR) {
    mkdirSync(process.env.FX_DIR, { recursive: true });
    for (const name of DRAWING_NAMES) writeFileSync(path.join(process.env.FX_DIR, `${name}.png`), await diagramPng(name, 2));
  }
  const f = await seedExam(suffix);
  const ids = await seedScientificPaper(f, suffix);
  // 180-question paper: 60 image questions, the rest text/formula only (an image-heavy NEET-like mix).
  const perfPaper = await prisma.previousYearPaper.create({ data: { examId: f.examId, year: 2024, title: `MED Perf ${suffix}`, isActive: true } });
  const perfPool: DrawingName[] = ["circuit", "graph", "ray", "biology", "benzene", "reaction"];
  for (let i = 0; i < 180; i++) {
    const row = await richQuestion({ ...f, paperId: perfPaper.id }, suffix, `Q${i + 1}. Using $v = u + at$ with $a = ${i % 9 + 1}\\ \\mathrm{m\\,s^{-2}}$, answer the question about the figure.`, undefined, { createdAt: new Date(Date.now() - 500_000 + i * 1000) });
    if (i % 3 === 0) await attach(row.id, perfPool[(i / 3) % perfPool.length], "QUESTION", `Figure for question ${i + 1}`, { scale: 1.6 + ((i / 3) % 5) * 0.1 });
  }
  // A draft question for the admin upload/RBAC tests.
  const draft = await richQuestion({ ...f, paperId: null }, suffix, "Admin upload target $\\ce{H2O}$", undefined, { status: QuestionStatus.DRAFT });
  const students: Record<string, { id: string; email: string }> = {};
  for (const tag of ["exam", "dark", "practice", "perf", "review"]) {
    const s = await prisma.student.create({ data: { studentId: await nextStudentId(), name: `MED ${tag}`, email: `med-${tag}-${suffix}@example.test`, passwordHash: await argon2.hash(HTTP_PASSWORD), authProvider: StudentAuthProvider.CREDENTIALS } });
    await prisma.studentProfile.create({ data: { studentId: s.id } });
    await ensureDefaultExamEnrollmentSafely(s.id);
    students[tag] = { id: s.id, email: s.email! };
  }
  const exam = await startPreviousYearPaperAttempt(students.exam.id, f.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
  const dark = await startPreviousYearPaperAttempt(students.dark.id, f.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
  const practice = await startPreviousYearPaperAttempt(students.practice.id, f.paperId, { answerMode: "INSTANT", durationMode: "FIXED" });
  const perf = await startPreviousYearPaperAttempt(students.perf.id, perfPaper.id, { answerMode: "EXAM", durationMode: "FIXED" });
  const review = await startPreviousYearPaperAttempt(students.review.id, f.paperId, { answerMode: "EXAM", durationMode: "FIXED" });
  await submitAttempt(review.id, students.review.id);
  const order = (await prisma.testAttemptQuestion.findMany({ where: { attemptId: exam.id }, orderBy: { order: "asc" }, select: { questionId: true } })).map((r) => r.questionId);
  console.log(
    JSON.stringify(
      { suffix, password: HTTP_PASSWORD, examId: f.examId, paperId: f.paperId, perfPaperId: perfPaper.id, ids, order, draftId: draft.id, students, attempts: { exam: exam.id, dark: dark.id, practice: practice.id, perf: perf.id, review: review.id } },
      null,
      2
    )
  );
  await prisma.$disconnect();
}

async function cleanup(fixturePath: string) {
  const F = JSON.parse(readFileSync(fixturePath, "utf8"));
  await cleanupExam(F.examId, Object.values(F.students as Record<string, { id: string }>).map((s) => s.id));
  await prisma.$disconnect();
  console.log("cleaned up (DB rows; scratch media files stay in the scratch STORAGE_DIR)");
}

const mode = process.argv[2];
const runIt = mode === "setup" ? setup() : mode === "cleanup" ? cleanup(process.argv[3]) : main();
runIt.catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
