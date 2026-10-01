/**
 * WhatsApp Question Share message regression (lib/whatsapp-share-template.ts
 * + components/student/whatsapp-share-button.tsx). Pure logic — no DB.
 *   npx tsx scripts/verify-whatsapp-question-share.ts
 */
import { readFileSync } from "node:fs";
import {
  DEFAULT_WHATSAPP_SHARE_TEMPLATE,
  IMAGE_QUESTION_NOTE,
  LEGACY_DEFAULT_WHATSAPP_SHARE_TEMPLATE,
  buildQuestionShareText,
  examShareHeading,
  renderWhatsAppShareText,
  resolveWhatsAppShareTemplate,
  toShareText,
  whatsAppShareUrl,
} from "../lib/whatsapp-share-template";

let failures = 0;
function check(label: string, passed: boolean, detail?: unknown) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}

console.log("=== WhatsApp Question Share Verification ===\n");

// A full review-page snapshot-like object, including fields that must never leak.
const snapshot = {
  code: "Q-SECRET-CODE-123",
  text: "A 45-year-old male presents with fever of 102°F, HbA1c 9.5% & BP 150/90 mmHg. Drug of choice?",
  imageUrl: null as string | null,
  difficulty: "HARD",
  options: [
    { label: "A", text: "Metformin 500 mg", imageUrl: null },
    { label: "B", text: "Insulin glargine", imageUrl: null },
    { label: "C", text: "Glipizide", imageUrl: null },
    { label: "D", text: "Pioglitazone", imageUrl: null },
  ],
  correctLabel: "B",
  explanation: "EXPLANATION-SECRET: glargine is preferred",
  aiExplanation: "AI-EXPLANATION-SECRET",
  selected: "C",
  isCorrect: false,
  marks: -0.33,
  id: "cm_internal_question_id_xyz",
};

const msg = buildQuestionShareText({
  template: LEGACY_DEFAULT_WHATSAPP_SHARE_TEMPLATE, // what production currently stores
  examName: "RUHS MEDICAL OFFICER EXAM 2026",
  subjectName: "Medicine",
  question: snapshot,
});
console.log("--- rendered message ---\n" + msg + "\n------------------------\n");

console.log("1. Content");
check("question text included verbatim", msg.includes(snapshot.text));
check("option A included", msg.includes("*A.* Metformin 500 mg"));
check("option B included", msg.includes("*B.* Insulin glargine"));
check("option C included", msg.includes("*C.* Glipizide"));
check("option D included", msg.includes("*D.* Pioglitazone"));
check("options are in A→D order", msg.indexOf("*A.*") < msg.indexOf("*B.*") && msg.indexOf("*B.*") < msg.indexOf("*C.*") && msg.indexOf("*C.*") < msg.indexOf("*D.*"));
check("options come after the question", msg.indexOf(snapshot.text) < msg.indexOf("*A.*"));

console.log("\n2. Nothing private leaks");
check("correct answer not revealed", !/correct|answer\s*[:=]|✅/i.test(msg) && !msg.includes("correctLabel"));
check("explanation not included", !msg.includes("EXPLANATION-SECRET") && !/explanation/i.test(msg));
check("AI explanation not included", !msg.includes("AI-EXPLANATION-SECRET"));
check("student's selected answer not included", !/selected|your answer/i.test(msg));
check("marks/score not included", !msg.includes("-0.33") && !/marks|score/i.test(msg));
check("internal ids/codes not included", !msg.includes("cm_internal_question_id_xyz") && !msg.includes("Q-SECRET-CODE-123"));
check("no localhost / admin / internal routes", !/localhost|127\.0\.0\.1|\/admin|\/student|\/api\//.test(msg));

console.log("\n3. Links & layout");
const firstLink = msg.indexOf("https://mocktestseries.in");
const lastLink = msg.lastIndexOf("https://mocktestseries.in");
check("website link appears exactly twice", msg.split("https://mocktestseries.in").length - 1 === 2);
check("top link is before the question", firstLink > -1 && firstLink < msg.indexOf(snapshot.text));
check("bottom link is after the options", lastLink > msg.indexOf("*D.*"));
check("starts with the exam heading", msg.startsWith("🩺 *RUHS Medical Officer Question*"));
check("has CTA and sign-off", msg.includes("Practice more questions & mock tests:") && msg.trimEnd().endsWith("_Mock Test Series_"));
check("legacy stored template upgrades (CRLF too)", resolveWhatsAppShareTemplate(LEGACY_DEFAULT_WHATSAPP_SHARE_TEMPLATE.replace(/\n/g, "\r\n")) === DEFAULT_WHATSAPP_SHARE_TEMPLATE);
const custom = "Custom: {{question}} -- {{website_url}}";
check("custom admin template preserved", resolveWhatsAppShareTemplate(custom) === custom);
const customMsg = buildQuestionShareText({ template: custom, examName: "Neet UG", question: snapshot });
check("custom template without {{options}} still shares A–D", ["*A.*", "*B.*", "*C.*", "*D.*"].every((l) => customMsg.includes(l)));

console.log("\n4. Exam-aware heading");
const headings: [string | null, string][] = [
  ["RUHS MEDICAL OFFICER EXAM 2026", "🩺 *RUHS Medical Officer Question*"],
  ["Neet UG", "📝 *NEET UG Question*"],
  ["HARYANA MEDICAL OFFICER EXAM ", "🩺 *Haryana Medical Officer Question*"],
  ["RPSC ASST. PROFESSOR (MEDICAL EDU.)", "📝 *RPSC Asst. Professor (Medical Edu.) Question*"],
  [null, "📝 *Medical Exam Question*"],
  ["   ", "📝 *Medical Exam Question*"],
];
for (const [name, expected] of headings) check(`heading for ${JSON.stringify(name)}`, examShareHeading(name) === expected, examShareHeading(name));
check("NEET message is not hard-coded to RUHS", !customMsg.includes("RUHS") && buildQuestionShareText({ template: DEFAULT_WHATSAPP_SHARE_TEMPLATE, examName: "Neet UG", question: snapshot }).startsWith("📝 *NEET UG Question*"));
check("fallback heading when exam missing", buildQuestionShareText({ template: DEFAULT_WHATSAPP_SHARE_TEMPLATE, examName: undefined, question: snapshot }).startsWith("📝 *Medical Exam Question*"));

console.log("\n5. HTML → plain text");
const html = "<p>Which ion is H<sub>2</sub>O&rsquo;s conjugate? Ca<sup>2+</sup> level &ge; 10 mg/dL</p><p>Line&nbsp;two<br/>Line three</p><script>alert(1)</script><ul><li>x</li></ul>";
const plain = toShareText(html);
check("tags stripped", !/<[^>]+>/.test(plain), plain);
check("subscript preserved", plain.includes("H₂O"), plain);
check("superscript preserved", plain.includes("Ca²⁺"), plain);
check("entities decoded (≥, ’, nbsp)", plain.includes("≥ 10 mg/dL") && plain.includes("’") && plain.includes("Line two"), plain);
check("<br> / <p> become line breaks", plain.includes("Line two\nLine three") && plain.includes("mg/dL\nLine two"), plain);
check("script content removed", !plain.includes("alert"), plain);
check("no double decoding (&amp;lt; → &lt;)", toShareText("<b>a &amp;lt; b</b>") === "a &lt; b");
check("plain text with < & kept exactly", toShareText("If a < b & c > d then?") === "If a < b & c > d then?");
check("plain-text line breaks preserved", toShareText("Line 1\r\nLine 2\n\nLine 3") === "Line 1\nLine 2\n\nLine 3");
check("HTML option text cleaned in message", buildQuestionShareText({ template: DEFAULT_WHATSAPP_SHARE_TEMPLATE, examName: "Neet UG", question: { text: "<p>Q</p>", options: [{ label: "A", text: "<b>CO<sub>2</sub></b>" }] } }).includes("*A.* CO₂"));

console.log("\n6. Unicode & symbols");
const uni = "Na⁺/K⁺-ATPase, 37 °C, 5 µg, α-β, ≤ ≥ ±, Δ, mmHg — हिंदी प्रश्न: रक्तचाप?";
const uniMsg = buildQuestionShareText({ template: DEFAULT_WHATSAPP_SHARE_TEMPLATE, examName: "Neet UG", question: { text: uni, options: [{ label: "A", text: "β₂ agonist" }] } });
check("unicode/medical symbols/Hindi survive", uniMsg.includes(uni) && uniMsg.includes("β₂ agonist"));
check("{{…}} inside question is not re-expanded", buildQuestionShareText({ template: DEFAULT_WHATSAPP_SHARE_TEMPLATE, examName: "x", question: { text: "Q {{website_url}} $& $1", options: [] } }).includes("Q {{website_url}} $& $1"));

console.log("\n7. WhatsApp URL encoding");
const tricky = "A & B 50% + C # D ? E=F\nline2 ✓ °C हिंदी";
const url = whatsAppShareUrl(tricky);
const encoded = url.slice("https://wa.me/?text=".length);
check("wa.me base URL", url.startsWith("https://wa.me/?text="));
check("round-trips exactly", decodeURIComponent(encoded) === tricky);
check("reserved chars encoded (& % + # ? = space newline)", ["%26", "%25", "%2B", "%23", "%3F", "%3D", "%20", "%0A"].every((t) => encoded.includes(t)) && !/[&+#? \n]/.test(encoded));
check("no double encoding (encoded exactly once)", encoded === encodeURIComponent(tricky) && !encoded.includes("%2526") && !encoded.includes("%250A"));
const fullUrl = whatsAppShareUrl(msg);
check("full message round-trips through URL parsing", new URL(fullUrl).searchParams.get("text") === msg);
const btn = readFileSync("components/student/whatsapp-share-button.tsx", "utf8");
check("share button uses the single encoder (no extra encode)", btn.includes("whatsAppShareUrl(text)") && !btn.includes("encodeURIComponent"));

console.log("\n8. Image questions");
const imgMsg = buildQuestionShareText({
  template: DEFAULT_WHATSAPP_SHARE_TEMPLATE,
  examName: "Neet UG",
  question: { text: "Identify the lesion shown.", imageUrl: "/uploads/questions/private-abc.png", options: [{ label: "A", text: "", imageUrl: "/uploads/o.png" }, { label: "B", text: "Melanoma" }] },
});
check("image question keeps its text and adds a neutral note", imgMsg.includes("Identify the lesion shown.") && imgMsg.includes(IMAGE_QUESTION_NOTE));
check("no image/storage URL is placed in the message", !imgMsg.includes("/uploads/") && !imgMsg.includes(".png"));
check("image-only option is labelled, not invented", imgMsg.includes("*A.* (image)") && imgMsg.includes("*B.* Melanoma"));
check("text-only question has no image note", !msg.includes(IMAGE_QUESTION_NOTE));
const review = readFileSync("app/student/attempt/[attemptId]/review/attempt-review.tsx", "utf8");
check("review UI still renders question/option images", /imageUrl/.test(review));

console.log("\n9. Backwards compatibility");
const legacy = renderWhatsAppShareText("{{question}} | {{exam}} | {{subject}} | {{website_url}} | {{unknown_token}}", { exam: "E", subject: "S", question: "Q?", website_url: "https://x.test" });
check("old 4-value render call still works; unknown tokens untouched", legacy === "Q? | E | S | https://x.test | {{unknown_token}}", legacy);

console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
