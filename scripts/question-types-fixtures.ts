/**
 * NEET Phase 4 synthetic fixtures: MULTIPLE_CORRECT and MATCH_THE_FOLLOWING
 * questions (no copyrighted content). Shared by scripts/verify-question-types.ts
 * (server) and its `setup` mode for scripts/verify-question-types.mjs (browser).
 *
 * Image assets use fake immutable keys by default; pass `mediaKey` to point
 * them at real files (the browser suite stores real WebPs first).
 */
export interface QtAsset {
  role: "QUESTION" | "OPTION" | "EXPLANATION" | "LIST_ITEM";
  optionLabel?: string | null;
  listKey?: string | null;
  order: number;
  storageKey: string;
  alt: string;
  width: number;
  height: number;
}

export interface QtQuestion {
  key: string;
  questionType: "SINGLE_CORRECT" | "MULTIPLE_CORRECT" | "MATCH_THE_FOLLOWING";
  contentFormat: "PLAIN" | "RICH_V1";
  text: string;
  options: { label: string; text: string; isCorrect: boolean }[];
  explanation?: string | null;
  matchSpec?: { v: 1; listI: { key: string; text: string }[]; listII: { key: string; text: string }[] } | null;
  assets?: QtAsset[];
}

const LABELS = ["A", "B", "C", "D"] as const;
const opts = (texts: [string, string, string, string], correct: string[]) =>
  LABELS.map((label, i) => ({ label, text: texts[i], isCorrect: correct.includes(label) }));
export const fakeKey = (n: number) => `q/${(0xf4000 + n).toString(16).padStart(64, "0")}.webp`;

export function qtFixtureQuestions(mediaKey: (n: number) => string = fakeKey): QtQuestion[] {
  const img = (role: QtAsset["role"], n: number, alt: string, extra: Partial<QtAsset> = {}, w = 480, h = 320): QtAsset => ({
    role,
    order: 0,
    storageKey: mediaKey(n),
    alt,
    width: w,
    height: h,
    ...extra,
  });
  return [
    // --- SINGLE_CORRECT controls (legacy path) ---
    { key: "single-plain", questionType: "SINGLE_CORRECT", contentFormat: "PLAIN", text: "QT single plain: which is a prime number?", options: opts(["4", "6", "7", "9"], ["C"]) },
    {
      key: "single-rich",
      questionType: "SINGLE_CORRECT",
      contentFormat: "RICH_V1",
      text: "QT single rich: $v^2=u^2+2as$ with $u=0$ gives:",
      options: opts(["$v=\\sqrt{2as}$", "$v=2as$", "$v=as$", "$v=\\frac{as}{2}$"], ["A"]),
      explanation: "With $u=0$, $v=\\sqrt{2as}$.",
    },
    // --- MULTIPLE_CORRECT ---
    { key: "msq-ab", questionType: "MULTIPLE_CORRECT", contentFormat: "PLAIN", text: "QT MSQ 1: which are even numbers?", options: opts(["2", "4", "5", "7"], ["A", "B"]) },
    { key: "msq-abd", questionType: "MULTIPLE_CORRECT", contentFormat: "PLAIN", text: "QT MSQ 2: which are mammals?", options: opts(["Whale", "Bat", "Shark", "Human"], ["A", "B", "D"]), explanation: "Sharks are fish." },
    { key: "msq-all", questionType: "MULTIPLE_CORRECT", contentFormat: "PLAIN", text: "QT MSQ 3: which are vowels?", options: opts(["a", "e", "i", "o"], ["A", "B", "C", "D"]) },
    {
      key: "msq-phys",
      questionType: "MULTIPLE_CORRECT",
      contentFormat: "RICH_V1",
      text: "QT MSQ 4 (Physics): which have the dimensions of energy? $$E=\\frac{1}{2}mv^2$$",
      options: opts(["$\\frac{1}{2}mv^2$", "$mgh$", "$\\frac{F}{A}$", "$Fs$"], ["A", "B", "D"]),
      explanation: "Pressure $\\frac{F}{A}$ is not energy.",
    },
    {
      key: "msq-chem",
      questionType: "MULTIPLE_CORRECT",
      contentFormat: "RICH_V1",
      text: "QT MSQ 5 (Chemistry): which are redox reactions?",
      options: opts(["\\ce{2H2 + O2 -> 2H2O}", "\\ce{Zn + Cu^2+ -> Zn^2+ + Cu}", "\\ce{NaCl + AgNO3 -> AgCl v + NaNO3}", "\\ce{2Na + Cl2 -> 2NaCl}"], ["A", "B", "D"]),
    },
    {
      key: "msq-img",
      questionType: "MULTIPLE_CORRECT",
      contentFormat: "RICH_V1",
      text: "QT MSQ 6: which figures have four sides?",
      options: opts(["", "", "", ""], ["B", "D"]),
      assets: [
        img("OPTION", 1, "A triangle", { optionLabel: "A" }, 240, 240),
        img("OPTION", 2, "A square", { optionLabel: "B" }, 240, 240),
        img("OPTION", 3, "A circle", { optionLabel: "C" }, 240, 240),
        img("OPTION", 4, "A rectangle", { optionLabel: "D" }, 240, 240),
      ],
    },
    {
      key: "msq-bio",
      questionType: "MULTIPLE_CORRECT",
      contentFormat: "RICH_V1",
      text: "QT MSQ 7 (Biology): in the labelled cell diagram, which structures are found only in plant cells?",
      options: opts(["Cell wall", "Mitochondrion", "Chloroplast", "Nucleus"], ["A", "C"]),
      assets: [img("QUESTION", 5, "Labelled plant cell diagram", {}, 640, 400)],
    },
    // --- MATCH_THE_FOLLOWING ---
    {
      key: "mtf-bio",
      questionType: "MATCH_THE_FOLLOWING",
      contentFormat: "PLAIN",
      text: "QT MTF 8 (Biology): match List I with List II.",
      matchSpec: {
        v: 1,
        listI: [
          { key: "A", text: "Insulin" },
          { key: "B", text: "Thyroxine" },
          { key: "C", text: "ADH" },
          { key: "D", text: "Aldosterone" },
        ],
        listII: [
          { key: "I", text: "Pancreas" },
          { key: "II", text: "Thyroid" },
          { key: "III", text: "Pituitary" },
          { key: "IV", text: "Adrenal cortex" },
        ],
      },
      options: opts(["A-I, B-II, C-III, D-IV", "A-II, B-I, C-III, D-IV", "A-I, B-III, C-II, D-IV", "A-IV, B-II, C-III, D-I"], ["A"]),
      explanation: "Insulin–pancreas, thyroxine–thyroid, ADH–pituitary, aldosterone–adrenal cortex.",
    },
    {
      key: "mtf-phys",
      questionType: "MATCH_THE_FOLLOWING",
      contentFormat: "RICH_V1",
      text: "QT MTF 9 (Physics): match each graph with its equation.",
      matchSpec: {
        v: 1,
        listI: [
          { key: "A", text: "" },
          { key: "B", text: "" },
          { key: "C", text: "Straight line through the origin" },
        ],
        listII: [
          { key: "I", text: "$y = kx$" },
          { key: "II", text: "$y = kx^2$" },
          { key: "III", text: "$y = \\frac{k}{x}$" },
        ],
      },
      options: opts(["A-II, B-III, C-I", "A-I, B-II, C-III", "A-III, B-I, C-II", "A-II, B-I, C-III"], ["A"]),
      assets: [img("LIST_ITEM", 6, "Parabola graph", { listKey: "I:A" }, 320, 240), img("LIST_ITEM", 7, "Hyperbola graph", { listKey: "I:B" }, 320, 240)],
    },
    {
      key: "mtf-chem",
      questionType: "MATCH_THE_FOLLOWING",
      contentFormat: "RICH_V1",
      text: "QT MTF 10 (Chemistry): match each structure with its name.",
      matchSpec: {
        v: 1,
        listI: [
          { key: "A", text: "" },
          { key: "B", text: "" },
          { key: "C", text: "\\ce{CH3COOH}" },
          { key: "D", text: "\\ce{C6H6}" },
        ],
        listII: [
          { key: "I", text: "Ethanol" },
          { key: "II", text: "Methane" },
          { key: "III", text: "Acetic acid" },
          { key: "IV", text: "Benzene" },
        ],
      },
      options: opts(["A-I, B-II, C-III, D-IV", "A-II, B-I, C-III, D-IV", "A-II, B-I, C-IV, D-III", "A-I, B-II, C-IV, D-III"], ["B"]),
      assets: [img("LIST_ITEM", 8, "Methane structure", { listKey: "I:A" }, 300, 300), img("LIST_ITEM", 9, "Ethanol structure", { listKey: "I:B" }, 300, 300)],
    },
    {
      key: "mtf-mixed",
      questionType: "MATCH_THE_FOLLOWING",
      contentFormat: "RICH_V1",
      text: "QT MTF 11 (Mixed): match the quantity with its expression.",
      matchSpec: {
        v: 1,
        listI: [
          { key: "A", text: "Kinetic energy" },
          { key: "B", text: "Lorentz force $\\vec{F}$" },
          { key: "C", text: "Field around a wire" },
          { key: "D", text: "de Broglie wavelength" },
        ],
        listII: [
          { key: "I", text: "$\\frac{1}{2}mv^2$" },
          { key: "II", text: "$q\\vec{v}\\times\\vec{B}$" },
          { key: "III", text: "" },
          { key: "IV", text: "$\\lambda = \\frac{h}{p}$ — a deliberately long entry to test wrapping on a narrow phone screen without overflow" },
        ],
      },
      options: opts(["A-I, B-II, C-III, D-IV", "A-II, B-I, C-IV, D-III", "A-III, B-IV, C-I, D-II", "A-IV, B-III, C-II, D-I"], ["A"]),
      assets: [img("LIST_ITEM", 10, "Concentric magnetic field lines", { listKey: "II:III" }, 360, 240)],
    },
  ];
}
