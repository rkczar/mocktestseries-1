/**
 * Text safety rules applied to EVERY piece of post content — AI output on
 * arrival and manual edits again at the quality gate. They block the claims
 * this studio must never make: invented repetition/frequency statistics,
 * success guarantees, exam attribution that doesn't match the paper, a
 * different "correct answer" than the stored key, references we can't verify,
 * and scripts the slide fonts can't render.
 */

export interface SafetyContext {
  paperYear: number | null;
  correctLabels: string[];
  optionLabels: string[];
}

export interface SafetyProblem {
  rule: string;
  message: string;
}

const REPETITION = [
  /\b(frequently|commonly|often|repeatedly|regularly|always)\s+(asked|repeated|tested|seen|appears?|comes?)\b/i,
  /\b(repeated|repeat(?:s|ing)?)\s+(question|pyq|topic|concept|mcq)s?\b/i,
  /\b(most|highly)\s+(repeated|asked)\b/i,
  /\b(every|each)\s+(single\s+)?(year|exam|paper)\b/i,
  /\basked\s+\d+\s+times\b/i,
  /\b(sure[-\s]?shot|guaranteed?|must\s+come|will\s+(definitely\s+)?(come|be\s+asked))\b/i,
];
const AUDIENCE_PERCENT = /\b\d{1,3}(\.\d+)?\s*%\s*(of\s+)?(students|aspirants|candidates|doctors|people|toppers|you)\b|\b(students|aspirants|candidates|doctors)\s+(get|got)\s+(this|it)\s+wrong\b/i;
const REFERENCE = /\b(et\s+al\.?|doi\s*:|isbn|\bpg\.?\s*\d+|page\s+\d+|\d+(st|nd|rd|th)\s+edition|edition\s+\d+)\b/i;
const DEVANAGARI = /[ऀ-ॿ]/;
const URL = /\b(?:https?:\/\/|www\.)[^\s]+/gi;
const YEAR = /\b(19[6-9]\d|20[0-4]\d)\b/g;

function answerClaims(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:correct\s+)?answer\s*(?:is|:|=|-)\s*(?:option\s*)?\(?([A-F])\)?(?![A-Za-z])/gi,
    /\boption\s*\(?([A-F])\)?\s+is\s+(?:the\s+)?(?:correct|right|answer)\b/gi,
    /\b(?:correct|right)\s+option\s*(?:is|:)?\s*\(?([A-F])\)?(?![A-Za-z])/gi,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) out.push(m[1].toUpperCase());
  return out;
}

/**
 * `strictYears`: hooks and captions may only mention the paper's own year
 * (they are attribution surfaces); explanations may cite guideline years.
 */
export function checkText(text: string, ctx: SafetyContext, opts: { strictYears?: boolean; allowedDomains?: string[] } = {}): SafetyProblem[] {
  const problems: SafetyProblem[] = [];
  if (!text.trim()) return problems;
  for (const re of REPETITION) {
    if (re.test(text)) {
      problems.push({ rule: "UNSUPPORTED_FREQUENCY_CLAIM", message: "Claims the question/topic is repeated, frequent or guaranteed — there is no data for that." });
      break;
    }
  }
  if (AUDIENCE_PERCENT.test(text)) {
    problems.push({ rule: "UNSUPPORTED_STATISTIC", message: "Mentions a share of students/aspirants — only the captured Most Missed numbers may be shown, and those are added by the template." });
  }
  if (REFERENCE.test(text)) problems.push({ rule: "UNVERIFIED_REFERENCE", message: "Cites a page, edition or paper reference that can't be verified." });
  if (DEVANAGARI.test(text)) problems.push({ rule: "UNSUPPORTED_SCRIPT", message: "Contains Hindi (Devanagari) text — slides and captions are English only." });
  const claims = answerClaims(text);
  if (claims.some((l) => ctx.optionLabels.includes(l) && !ctx.correctLabels.includes(l))) {
    problems.push({ rule: "ANSWER_CONTRADICTION", message: `States a different answer than the stored key (${ctx.correctLabels.join(", ")}).` });
  }
  if (opts.strictYears) {
    const years = [...text.matchAll(YEAR)].map((m) => Number(m[1]));
    const bad = years.filter((y) => y !== ctx.paperYear);
    if (bad.length) problems.push({ rule: "UNVERIFIED_YEAR", message: `Mentions year ${bad[0]}, which is not this paper's year${ctx.paperYear ? ` (${ctx.paperYear})` : ""}.` });
  }
  if (opts.allowedDomains) {
    for (const m of text.matchAll(URL)) {
      const host = m[0].replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();
      if (!opts.allowedDomains.some((d) => host === d || host.endsWith(`.${d}`))) {
        problems.push({ rule: "UNKNOWN_LINK", message: `Links to ${host}, which is not one of the configured links.` });
        break;
      }
    }
  }
  return problems;
}
