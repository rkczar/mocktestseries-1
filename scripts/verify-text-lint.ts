/**
 * Shared text lint (lib/text-lint) — pure regression: Instagram caption checks, video-script checks.
 * No database, no network.
 *
 *   npx tsx scripts/verify-text-lint.ts
 */
import assert from "node:assert/strict";
import { cleanCaption, feedPreview, hashtagsOf, invisibleCharacters, lintCaption, lintScript, worst } from "@/lib/text-lint";

let passes = 0;
let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passes++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        → ${String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join("\n          ")}`);
  }
}
const OPTS = { captionMax: 2200, hashtagLimit: 15, allowedDomains: ["mocktestseries.in"] };
const codes = (f: { code: string }[]) => f.map((x) => x.code);

const GOOD = `Which artery supplies the SA node in most people? Swipe to check your answer.

The right coronary artery supplies the SA node in about 60% of hearts. Remember: "Right side starts the beat."

Practice the full RUHS MO paper on mocktestseries.in.

#RUHSMO #MedicalOfficer #Anatomy #Cardiology`;

console.log("\nA. Captions");
check("a clean caption has no error or warning", () => {
  const r = lintCaption(GOOD, OPTS);
  assert.ok(!r.findings.some((f) => f.severity !== "info"), JSON.stringify(r.findings));
  assert.equal(r.hashtags.length, 4);
});
check("empty caption is an error", () => assert.deepEqual(codes(lintCaption("  ", OPTS).findings).includes("CAPTION_EMPTY"), true));
check("over the publisher limit is an error; the limit comes from the caller", () => {
  assert.ok(codes(lintCaption("a".repeat(2201), OPTS).findings).includes("CAPTION_TOO_LONG"));
  assert.ok(!codes(lintCaption("a ".repeat(500), OPTS).findings).includes("CAPTION_TOO_LONG"));
  assert.ok(codes(lintCaption("a ".repeat(500), { ...OPTS, captionMax: 500 }).findings).includes("CAPTION_TOO_LONG"));
});
check("hashtag limit is configurable (15 default here; 5 would flag the same caption)", () => {
  const tags = Array.from({ length: 12 }, (_, i) => `#tag${i}`).join(" ");
  const text = `A complete sentence about the topic that gives context. ${tags}`;
  assert.ok(!codes(lintCaption(text, OPTS).findings).includes("HASHTAGS_OVER_LIMIT"));
  assert.ok(codes(lintCaption(text, { ...OPTS, hashtagLimit: 5 }).findings).includes("HASHTAGS_OVER_LIMIT"));
});
check("duplicate hashtags (case-insensitive) and a broken '# ' are reported", () => {
  const r = lintCaption(`A complete sentence about the topic for context. #Anatomy #anatomy # Cardio`, OPTS);
  assert.ok(codes(r.findings).includes("HASHTAG_DUPLICATE"));
  assert.ok(codes(r.findings).includes("HASHTAG_FORMAT"));
});
check("hashtags: '#1' in prose and C# are handled; Devanagari hashtags count", () => {
  assert.deepEqual(hashtagsOf("Step #1 then C#code #चिकित्सा #NEETPG"), ["#1", "#चिकित्सा", "#NEETPG"]);
});
check("feed preview: about 125 characters or two lines, grapheme-safe, marked approximate", () => {
  const p = feedPreview(`${"x".repeat(200)}`);
  assert.equal(p.text.length, 125);
  assert.equal(p.truncated, true);
  assert.equal(p.approximate, true);
  const two = feedPreview("Line one.\nLine two.\nLine three.");
  assert.equal(two.text, "Line one.\nLine two.");
  assert.equal(two.truncated, true);
  const emoji = feedPreview("👩🏽‍⚕️".repeat(130));
  assert.equal([...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(emoji.text)].length, 125);
});
check("a first line longer than the preview is flagged; starting with a hashtag is flagged", () => {
  assert.ok(codes(lintCaption(`${"word ".repeat(40)}\n\nMore.`, OPTS).findings).includes("FEED_PREVIEW_CUT"));
  assert.ok(codes(lintCaption(`#RUHS Which artery supplies the SA node? A full sentence follows here.`, OPTS).findings).includes("CAPTION_STARTS_WITH_HASHTAG"));
});
check("links: own site is info only, another site is a warning", () => {
  const own = lintCaption("Practice the full paper at https://mocktestseries.in today, it is free to try.", OPTS);
  assert.ok(codes(own.findings).includes("CAPTION_LINK") && !codes(own.findings).includes("CAPTION_LINK_FOREIGN"));
  assert.ok(codes(lintCaption("Read the full notes at https://example.com before your exam this week.", OPTS).findings).includes("CAPTION_LINK_FOREIGN"));
});
check("several asks, markdown and short captions are reported", () => {
  const r = lintCaption("**Big news** Comment YES, save this for later, follow us and DM me for notes.", OPTS);
  assert.ok(codes(r.findings).includes("CAPTION_MANY_ASKS"));
  assert.ok(codes(r.findings).includes("CAPTION_MARKDOWN"));
  assert.ok(codes(lintCaption("Nice one #MBBS", OPTS).findings).includes("CAPTION_SHORT"));
});
check("invisible characters: found, named, removable; a Devanagari ZWJ conjunct is NOT flagged", () => {
  const dirty = "Save​ this﻿ for the exam⁠ tomorrow, it covers the full topic.";
  assert.ok(codes(lintCaption(dirty, OPTS).findings).includes("INVISIBLE_CHARACTERS"));
  assert.equal(cleanCaption(dirty), "Save this for the exam tomorrow, it covers the full topic.");
  assert.deepEqual(invisibleCharacters("क्‍ष"), []);
  assert.equal(invisibleCharacters("a‍b").length, 1);
});
check("stock phrasing and repetition are info (suggestions), never errors", () => {
  const r = lintCaption("Let's dive in! In today's fast-paced world this game-changer will unlock your potential. The renal artery anatomy matters. The renal artery anatomy matters.", OPTS);
  const stock = r.findings.filter((f) => f.code === "STOCK_PHRASE");
  assert.ok(stock.length >= 3);
  assert.ok(stock.every((f) => f.severity === "info" && f.suggestion));
  assert.ok(codes(r.findings).includes("REPEATED_PHRASE"));
});
check("worst() ranks error > warning > info", () => {
  assert.equal(worst([{ code: "a", severity: "info", message: "" }, { code: "b", severity: "warning", message: "" }]), "warning");
  assert.equal(worst([]), null);
});

console.log("\nB. Video scripts");
const SOURCE = "Adrenaline 0.5 mg IM (1:1000) in anaphylaxis; repeat after 5 minutes if needed. Adult dose.";
check("a clean, sourced script has no warnings", () => {
  const f = lintScript(
    [
      { narration: "Anaphylaxis kills in minutes, so the first drug matters.", onScreenText: "Anaphylaxis: first drug" },
      { narration: "Give adrenaline 0.5 mg intramuscularly, one in one thousand.", onScreenText: "Adrenaline 0.5 mg IM" },
      { narration: "Repeat after 5 minutes if needed. Practice more questions on MockTestSeries.", onScreenText: "Repeat after 5 min" },
    ],
    { sourceText: SOURCE }
  );
  assert.ok(!f.some((x) => x.severity !== "info"), JSON.stringify(f));
});
check("greeting / 'in this video' opening is flagged on scene 1", () => {
  for (const o of ["Hello everyone, today we learn anaphylaxis.", "In this video we will see anaphylaxis.", "Namaste doston, aaj hum anaphylaxis padhenge."]) {
    const f = lintScript([{ narration: o }, { narration: "Content." }]);
    assert.ok(f.some((x) => x.code === "SCRIPT_INTRO_FILLER" && x.scene === 1), o);
  }
});
check("a changed dose or an invented number is flagged against the source", () => {
  const f = lintScript([{ narration: "Give adrenaline 5 mg IM." }, { narration: "Repeat every 15 minutes." }], { sourceText: SOURCE });
  const n = f.filter((x) => x.code === "SCRIPT_NUMBER_NOT_IN_SOURCE");
  assert.equal(n.length, 2);
  assert.match(n[0].message, /5mg/);
});
check("no source → no number check (cannot compare)", () => {
  assert.ok(!lintScript([{ narration: "Give 5 mg." }]).some((x) => x.code === "SCRIPT_NUMBER_NOT_IN_SOURCE"));
});
check("an ask before the content is delivered is flagged; one at the end is fine", () => {
  const early = lintScript([{ narration: "Follow us for more." }, { narration: "Point one." }, { narration: "Point two." }, { narration: "Point three." }]);
  assert.ok(early.some((x) => x.code === "SCRIPT_EARLY_CTA" && x.scene === 1));
  const late = lintScript([{ narration: "Point one." }, { narration: "Point two." }, { narration: "Point three." }, { narration: "Comment your answer below." }]);
  assert.ok(!late.some((x) => x.code === "SCRIPT_EARLY_CTA"));
});
check("guarantee / absolute claims are warnings; pronunciation hints are info", () => {
  const f = lintScript([{ narration: "This drug cures all infections, guaranteed. Dose 10 mg/kg IV with ECG monitoring." }]);
  assert.ok(f.some((x) => x.code === "SCRIPT_ABSOLUTE_CLAIM" && x.severity === "warning"));
  const p = f.find((x) => x.code === "SCRIPT_PRONUNCIATION");
  assert.ok(p && p.severity === "info" && /ECG/.test(p.excerpt ?? "") && /mg\/kg/.test(p.excerpt ?? ""));
});
check("exam names are not pronunciation noise", () => {
  assert.ok(!lintScript([{ narration: "This NEET PG and RUHS MO MCQ is common." }]).some((x) => x.code === "SCRIPT_PRONUNCIATION"));
});
check("on-screen text unrelated to the narration is flagged", () => {
  const f = lintScript([{ narration: "Adrenaline is the first drug in anaphylaxis.", onScreenText: "Thyroid storm management protocol" }]);
  assert.ok(f.some((x) => x.code === "SCRIPT_SCREEN_MISMATCH"));
});
check("repetition across scenes is reported", () => {
  const f = lintScript([{ narration: "The first line of treatment is adrenaline." }, { narration: "Remember, the first line of treatment is adrenaline." }]);
  assert.ok(f.some((x) => x.code === "SCRIPT_REPEATED_PHRASE"));
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
