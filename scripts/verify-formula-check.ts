/**
 * Formula transport + damage checks (2026-11-11). Pure functions only: no DB, no network, no AI.
 *   npx tsx scripts/verify-formula-check.ts
 */
import { escapeLatexCommands, parseModelJson } from "@/lib/ai-import/ai";
import { controlCharFindings, showControlChars } from "@/lib/ai-import/formula-check";
import { BILINGUAL_RULES } from "@/lib/ai-import/bilingual";
import { EXTRACT_SYSTEM, RESCAN_RULES, extractUserText } from "@/lib/ai-import/prompts";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}
const field = (raw: string) => (parseModelJson(`{"s":"${raw}"}`) as { s: string }).s;
const R = String.raw;

// 1. Parser: single-backslash LaTeX survives
for (const raw of [
  R`grows between $16 - 26\text{ }^\text{o}\text{C}$`, // Q63 copy
  R`$13^{\text{th}}$ February, 1986`, // Q136 copy
  R`$22^{\text{nd}}$ July, 2019`, // Q139 copy
  R`$a \ne b$`, R`$x \ni S$`, R`$A \nRightarrow B$`, R`$x \nsubseteq y$`, R`$E = mc^2 \tag{1}$`, R`$\triangleq$`, R`$\tiny x$`,
  R`$\underline{x}$`, R`$\uparrow$`, R`$\upsilon$`, R`\underline{outside}`,
  R`$\sigma = \sqrt{\frac{\sum (x - \bar{x})^2}{N}}$`, // Q37-style
  R`price \$5 and $\frac{1}{2}$`, R`$$\text{H}_3\text{C}$$`, R`\ce{H2SO4}`,
]) check(`parse keeps ${raw}`, field(raw) === raw, field(raw));
check("\\ne outside maths stays a line break", field(R`a\ne b`) === "a\ne b");
check("\\ni) outside maths stays a line break", field(R`Statements:\ni) one`) === "Statements:\ni) one");
check("TAB before a word outside maths stays", field(R`Name\tAge`) === "Name\tAge");
check("Devanagari \\u escape kept", field("\\u0915\\u0930") === "कर");
check("maths state does not leak between JSON strings", (parseModelJson(R`{"a":"$x","b":"y\ne z"}`) as { b: string }).b === "y\ne z");
const ok = JSON.stringify({ s: R`$13^{\text{th}}$ \ce{C6H6} $\underline{a} \ne b$` });
check("properly escaped JSON unchanged", escapeLatexCommands(ok) === ok);
let threw = false;
try { parseModelJson(`{"s":"cut off`); } catch { threw = true; }
check("cut-off answer still an error", threw);

// 2. Damage detector
const q136 = "$13^{\text{th}}$ February"; // TAB from a lost \t
const q136f = controlCharFindings(q136);
check("Q136 damage found", q136f.spots.length === 1 && q136f.spots[0].includes("⟨TAB⟩ext"), q136f);
check("Q136 suggestion restores \\text", q136f.suggestion === R`$13^{\text{th}}$ February`, q136f.suggestion);
const q63 = "$16 - 26\text{ }^\text{o}\text{C}$";
check("Q63: 3 spots, suggestion restores", controlCharFindings(q63).spots.length === 3 && controlCharFindings(q63).suggestion === R`$16 - 26\text{ }^\text{o}\text{C}$`);
check("form feed (\\frac) found anywhere", controlCharFindings("$\frac{1}{2}$").suggestion === R`$\frac{1}{2}$`);
check("backspace (\\beta) found", controlCharFindings("$\beta$").suggestion === R`$\beta$`);
check("LF + letters inside maths found (\\ne)", controlCharFindings("$a \ne b$").suggestion === R`$a \ne b$`);
check("NUL found, no suggestion", (() => { const f = controlCharFindings("a\u0000b"); return f.spots.length === 1 && f.suggestion === null; })());
check("ordinary line breaks not flagged", controlCharFindings("Statements:\n1. one\n2. two $x^2$").spots.length === 0);
check("multi-line display maths before a digit not flagged", controlCharFindings("$$a\n= 2$$").spots.length === 0);
check("\\$ literal dollar does not open maths", controlCharFindings("costs \\$5\nThe end").spots.length === 0);
check("clean LaTeX not flagged", controlCharFindings(R`$\sigma = \sqrt{\frac{\sum (x-\bar{x})^2}{N}}$`).spots.length === 0);
check("Hindi + formula not flagged", controlCharFindings(R`मानक विचलन का सूत्र $\sigma$ है`).spots.length === 0);
check("showControlChars", showControlChars("a\tb\fc") === "a⟨TAB⟩b⟨FF⟩c");

// 3. Prompts
check("system prompt teaches doubled backslashes", EXTRACT_SYSTEM.includes(R`"$\\frac{1}{2}$"`));
check("system prompt has formula rules F1-F5", ["F1 Detect", "F2 Preserve", "F3 The page image", "F4 Diagrams", "F5 \"confidence\""].every((s) => EXTRACT_SYSTEM.includes(s)));
check("text layer is labelled a hint, never a formula source", extractUserText({ exam: "E", subject: null, page: 1, pages: 1, textLayer: "x" }).includes("never from the text layer"));
check("bilingual-only rules keep formulas identical in both languages; English prompt never mentions Hindi", BILINGUAL_RULES.includes("never put Devanagari inside $...$") && !/Hindi/.test(EXTRACT_SYSTEM));
check("re-scan rules: one number once, candidate only", RESCAN_RULES.includes("at most once") && RESCAN_RULES.includes("candidate"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
