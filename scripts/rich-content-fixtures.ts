/**
 * RICH_V1 fixture content for the Phase 1 rich-content suites
 * (scripts/verify-rich-content.ts and .mjs). Scratch/test data only — never
 * production NEET questions.
 */

export const SENTINEL = "EXPLSENTINEL";

export interface FixtureOption {
  label: string;
  text: string;
  isCorrect?: boolean;
  imageUrl?: string | null;
}

export interface FixtureAsset {
  role: "QUESTION" | "OPTION" | "EXPLANATION";
  optionLabel?: string | null;
  order: number;
  storageKey: string;
  alt: string;
  caption?: string | null;
  width: number;
  height: number;
  darkBacking?: boolean;
}

export interface FixtureQuestion {
  key: string;
  contentFormat: "PLAIN" | "RICH_V1";
  text: string;
  imageUrl?: string | null;
  explanation?: string | null;
  options: FixtureOption[];
  assets?: FixtureAsset[];
}

const opts = (texts: [string, string, string, string], correct = "A"): FixtureOption[] =>
  (["A", "B", "C", "D"] as const).map((label, i) => ({ label, text: texts[i], isCorrect: label === correct }));

const sha = (n: number) => n.toString(16).padStart(64, "0");
const asset = (role: FixtureAsset["role"], order: number, n: number, alt: string, optionLabel: string | null = null, w = 640, h = 360): FixtureAsset => ({
  role,
  optionLabel,
  order,
  storageKey: `q/${sha(n)}.webp`,
  alt,
  width: w,
  height: h,
});

/** Legacy content that must render byte-for-byte as plain text. */
export const PLAIN_TRICKY =
  "Cost is $5 and $10; $$x$$ \\ce{H2O} \\frac{1}{2} <b>bold</b> <script>window.__xss=9</script> & 2 < 3 > 1 — Ω ² ₂ → ⇌ √ “quotes” 'apos'\nSecond line\ttab";

export function fixtureQuestions(suffix: string): FixtureQuestion[] {
  return [
    {
      key: "plain",
      contentFormat: "PLAIN",
      text: PLAIN_TRICKY,
      imageUrl: "/storage/question-images/legacy-plain-fixture.webp",
      options: [
        { label: "A", text: "$5 \\ce{NaCl} <i>i</i>", isCorrect: true, imageUrl: "/storage/question-images/legacy-opt-a.webp" },
        { label: "B", text: "B & <u>u</u>" },
        { label: "C", text: "C $$" },
        { label: "D", text: "D" },
      ],
    },
    {
      key: "physics",
      contentFormat: "RICH_V1",
      text:
        "A ball is dropped from height $h$. Using $v^2 = u^2 + 2as$ and the lens formula $\\frac{1}{f} = \\frac{1}{v} - \\frac{1}{u}$, " +
        "with $g = 9.8\\ \\mathrm{m\\,s^{-2}}$, $\\alpha$, $\\beta$, $\\Delta x$, $\\omega_0$ and $\\vec{F} = m\\vec{a}$ ($6.02 \\times 10^{23}$ particles), find the speed.\n" +
        "$$E = \\frac{1}{2}mv^2$$",
      explanation: `Energy conservation: $mgh = \\frac{1}{2}mv^2$, so $$v = \\sqrt{2gh}$$ The de Broglie relation $\\lambda = \\frac{h}{p}$ is not needed. ${SENTINEL}-${suffix}-physics`,
      options: opts(["$\\sqrt{2gh}$", "$\\lambda = \\frac{h}{p}$", "$E = \\frac{1}{2}mv^2$", "$2gh$ m s$^{-1}$"]),
    },
    {
      key: "chemistry",
      contentFormat: "RICH_V1",
      text:
        "In the reaction $\\ce{2H2 + O2 -> 2H2O}$, sulphuric acid $\\ce{H2SO4}$ and the equilibrium \\ce{N2 + 3H2 <=> 2NH3}, which ion is formed? " +
        "Consider $\\ce{Fe^3+}$, $\\ce{SO4^2-}$ and \\ce{[Cu(NH3)4]^2+}. Rate in \\pu{mol L-1 s-1}.",
      explanation: `$\\ce{H2SO4 -> 2H+ + SO4^2-}$ in water. ${SENTINEL}-${suffix}-chemistry`,
      options: opts(["$\\ce{SO4^2-}$", "$\\ce{Fe^3+}$", "$\\ce{NH4+}$", "$\\ce{OH-}$"]),
    },
    {
      key: "long",
      contentFormat: "RICH_V1",
      text:
        "Long display equation:\n$$F = G\\frac{m_1 m_2}{r^2} + \\frac{1}{4\\pi\\varepsilon_0}\\frac{q_1 q_2}{r^2} + \\frac{\\mu_0 I_1 I_2 L}{2\\pi d} + k\\,x + \\frac{1}{2}\\rho v^2 A C_d + m g \\sin\\theta + \\mu m g \\cos\\theta$$\n" +
        "and a long inline one $a_1 + a_2 + a_3 + a_4 + a_5 + a_6 + a_7 + a_8 + a_9 + a_{10} + a_{11} + a_{12} + a_{13} + a_{14} + a_{15} + a_{16} + a_{17} + a_{18} + a_{19} + a_{20}$.",
      options: opts(["$1$", "$2$", "$3$", "$4$"], "B"),
    },
    {
      key: "malformed",
      contentFormat: "RICH_V1",
      text: "Broken: $\\frac{1}{$ then $\\notacommand{x}$ then $\\ce{->(}$ then \\ce{H2O and an unclosed $x + 1 and $$ y",
      options: opts(["$\\sqrt{$", "\\ce{", "$}$", "ok"], "D"),
    },
    {
      key: "security",
      contentFormat: "RICH_V1",
      text:
        "<script>window.__xss=1</script> <img src=x onerror=\"window.__xss=2\"> $\\href{javascript:window.__xss=3}{click}$ " +
        "$\\url{javascript:window.__xss=4}$ $\\htmlClass{evil}{y}$ $\\includegraphics{https://example.com/x.png}$ $\\text{<b>x</b>}$",
      explanation: `<script>window.__xss=5</script> ${SENTINEL}-${suffix}-security`,
      options: opts(["<b>A</b>", "$\\href{https://example.com}{B}$", "C", "D"]),
    },
    {
      // Example 2 — Organic Chemistry: text + reaction diagram + A–D structure images.
      key: "organic",
      contentFormat: "RICH_V1",
      text: "Identify the major product of the reaction shown. $\\ce{CH3CH2OH ->[H2SO4][443 K] ?}$",
      explanation: `Dehydration gives ethene, $\\ce{CH2=CH2}$. ${SENTINEL}-${suffix}-organic`,
      options: opts(["", "", "", ""]),
      assets: [
        asset("QUESTION", 0, 1, "Reaction scheme: ethanol heated with concentrated sulphuric acid"),
        asset("OPTION", 0, 2, "Structure A: ethene", "A", 240, 160),
        asset("OPTION", 0, 3, "Structure B: ethanal", "B", 240, 160),
        asset("OPTION", 0, 4, "Structure C: diethyl ether", "C", 240, 160),
        asset("OPTION", 0, 5, "Structure D: ethanoic acid", "D", 240, 160),
      ],
    },
    {
      // Example 1 — Physics: text + formula + circuit diagram.
      key: "circuit",
      contentFormat: "RICH_V1",
      text: "In the circuit shown, find the current through $R_2$ if $V = IR$ and $R_{eq} = R_1 + \\frac{R_2 R_3}{R_2 + R_3}$.",
      explanation: `Combine $R_2 \\parallel R_3$ first. ${SENTINEL}-${suffix}-circuit`,
      options: opts(["$1\\ \\mathrm{A}$", "$2\\ \\mathrm{A}$", "$0.5\\ \\mathrm{A}$", "$4\\ \\mathrm{A}$"], "C"),
      assets: [asset("QUESTION", 0, 6, "Circuit: a 12 V cell with R1 in series and R2, R3 in parallel")],
    },
    {
      // Example 3 — Biology: text + labelled diagram (two figures, ordered).
      key: "biology",
      contentFormat: "RICH_V1",
      text: "Identify the part labelled X in the diagram of the human heart.",
      options: opts(["Left atrium", "Right ventricle", "Aorta", "Pulmonary vein"], "C"),
      assets: [
        asset("QUESTION", 1, 8, "Detail of the aortic arch"),
        asset("QUESTION", 0, 7, "Labelled longitudinal section of the human heart, part X marked", null, 800, 900),
      ],
    },
    {
      // Example 4 — Explanation: text + equation + two explanation diagrams.
      key: "explained",
      contentFormat: "RICH_V1",
      text: "A ray passes from glass ($n = 1.5$) to air. Find the critical angle.",
      explanation: `Using Snell's law $n_1 \\sin\\theta_1 = n_2 \\sin\\theta_2$: $$\\sin C = \\frac{1}{n} = \\frac{2}{3}$$ ${SENTINEL}-${suffix}-explained`,
      options: opts(["$\\sin^{-1}(2/3)$", "$\\sin^{-1}(1/3)$", "$45^\\circ$", "$90^\\circ$"]),
      assets: [asset("EXPLANATION", 0, 9, "Ray diagram at the critical angle"), asset("EXPLANATION", 1, 10, "Total internal reflection beyond C")],
    },
    {
      // PLAIN question that carries an explanation: snapshot v2, text NOT parsed.
      key: "plain-explained",
      contentFormat: "PLAIN",
      text: "Plain question with $x$ that must stay literal.",
      explanation: `Plain explanation $y$ stays literal. ${SENTINEL}-${suffix}-plainexpl`,
      options: opts(["$a$", "b", "c", "d"]),
    },
  ];
}

/** 180 RICH_V1 questions (mixed physics / chemistry / plain-text-in-rich) for the performance scenario. */
export function perfQuestions(suffix: string): FixtureQuestion[] {
  const base = fixtureQuestions(suffix).filter((q) => ["physics", "chemistry", "long", "explained", "circuit"].includes(q.key));
  return Array.from({ length: 180 }, (_, i) => {
    const b = base[i % base.length];
    // Shift every digit so no two questions carry identical formulas (honest compression numbers).
    const vary = (t: string) => t.replace(/\d/g, (d) => String((Number(d) + i) % 10));
    return {
      ...b,
      key: `perf-${i}`,
      text: `Q${i + 1}. ${vary(b.text)}`,
      options: b.options.map((o) => ({ ...o, text: vary(o.text) })),
      explanation: b.explanation ? `${vary(b.explanation)}-${i}` : null,
    };
  });
}
