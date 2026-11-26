#!/usr/bin/env node
// OpenRouter-only guard (owner policy 2026-11-26): fails if app code calls Gemini / OpenAI / Anthropic directly.
// Scans lib/, app/, components/ (code lines only, comments ignored).   node scripts/verify-openrouter-only-guard.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["lib", "app", "components"];
const BANNED = [
  [/generativelanguage\.googleapis\.com/, "direct Google Gemini API host"],
  [/api\.openai\.com/, "direct OpenAI API host"],
  [/api\.anthropic\.com/, "direct Anthropic API host"],
  [/new\s+Anthropic\s*\(/, "Anthropic SDK client"],
  [/from\s+["'](@google\/genai|@google\/generative-ai|openai)["']/, "direct provider SDK import"],
  [/process\.env\.(GEMINI|OPENAI|ANTHROPIC)_API_KEY/, "direct provider API key from the environment"],
];

const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|mjs|js)$/.test(n)) files.push(p);
  }
};
ROOTS.forEach(walk);

const hits = [];
for (const f of files) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
    for (const [re, why] of BANNED) if (re.test(line)) hits.push(`${f}:${i + 1}  ${why}`);
  });
}
if (hits.length) {
  console.error(`FAIL  direct provider call sites (${hits.length}):\n  ${hits.join("\n  ")}`);
  process.exit(1);
}
console.log(`PASS  OpenRouter-only guard: ${files.length} files scanned, no direct Gemini / OpenAI / Anthropic calls`);
