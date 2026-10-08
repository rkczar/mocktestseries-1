import { JSON_IMPORT_SCHEMA } from "@/lib/json-import";

/**
 * Official JSON import examples (docs/JSON-IMPORT.md). Synthetic content.
 * docs/json-import-examples/*.json are written from this module by
 * `npx tsx scripts/write-json-import-examples.ts` (a test asserts they match).
 * Subjects are real names of the RUHS MO / NEET UG exams; `exam` is left out,
 * so the Exam selected on the import page applies.
 */
export const JSON_IMPORT_EXAMPLES = {
  "ruhs-mo": {
    title: "RUHS MO — plain single-correct (Standard or Rich mode)",
    doc: {
      schema: JSON_IMPORT_SCHEMA,
      defaults: { difficulty: "MEDIUM" },
      questions: [
        {
          code: "RUHS-JSON-001",
          subject: "Pharmacology",
          question: "Drug of choice for anaphylactic shock is:",
          options: ["Adrenaline", "Atropine", "Hydrocortisone", "Chlorpheniramine"],
          correct: "A",
          explanation: "Intramuscular adrenaline is the first-line treatment of anaphylaxis.",
        },
        {
          code: "RUHS-JSON-002",
          subject: "Physiology",
          question: "Normal adult resting heart rate (beats per minute) is:",
          options: { A: "40–50", B: "60–100", C: "100–120", D: "120–140" },
          correct: "B",
          explanation: "A resting rate of 60–100 per minute is normal in adults.",
          difficulty: "EASY",
        },
        {
          code: "RUHS-JSON-003",
          subject: "Anatomy",
          question: "The largest bone of the human body is:",
          options: [
            { label: "A", text: "Humerus" },
            { label: "B", text: "Tibia" },
            { label: "C", text: "Femur", correct: true },
            { label: "D", text: "Fibula" },
          ],
          explanation: "The femur is the longest and strongest bone.",
        },
      ],
    },
  },
  "neet-ug-rich": {
    title: "NEET UG — formulas (KaTeX) and chemistry (mhchem), Rich mode",
    doc: {
      schema: JSON_IMPORT_SCHEMA,
      defaults: { contentFormat: "RICH_V1", difficulty: "MEDIUM" },
      questions: [
        {
          code: "NEET-JSON-001",
          questionNumber: 1,
          subject: "PHYSICS",
          question: "A body starts from rest with acceleration $a$. Its speed after covering distance $s$ is:\n$$v^2 = u^2 + 2as$$",
          options: ["$\\sqrt{2as}$", "$2as$", "$\\frac{1}{2}as$", "$\\sqrt{as}$"],
          correct: "A",
          explanation: "With $u = 0$: $v = \\sqrt{2as}$.",
        },
        {
          code: "NEET-JSON-002",
          questionNumber: 2,
          subject: "Chemistry",
          question: "For \\ce{N2 + 3H2 <=> 2NH3}, increasing the pressure favours the formation of:",
          options: ["\\ce{NH3}", "\\ce{N2}", "\\ce{H2}", "No change"],
          correct: "A",
          explanation: "The forward reaction lowers the number of gas moles (4 → 2).",
          difficulty: "EASY",
        },
        {
          code: "NEET-JSON-003",
          questionNumber: 3,
          subject: "Botany",
          question: "The energy currency of the cell is:",
          options: ["DNA", "ATP", "RNA", "NADP"],
          correct: "B",
          explanation: "\\ce{ATP} stores and transfers energy within cells.",
          review: { required: true, reason: "Answer key to be confirmed by the subject expert" },
        },
      ],
    },
  },
  "with-images": {
    title: "Question, option and explanation images (Rich mode + ZIP)",
    doc: {
      schema: JSON_IMPORT_SCHEMA,
      defaults: { contentFormat: "RICH_V1", subject: "PHYSICS" },
      questions: [
        {
          code: "IMG-JSON-001",
          question: {
            text: "In the circuit shown, find $R_{eq}$.",
            images: [{ file: "SAMPLE-004-Q1.png", alt: "Battery with two 3 ohm resistors in series" }],
          },
          options: ["$6\\,\\Omega$", "$3\\,\\Omega$", "$2\\,\\Omega$", "$9\\,\\Omega$"],
          correct: "A",
          explanation: {
            text: "Series: $R = R_1 + R_2$.",
            images: [{ file: "SAMPLE-004-EXP1.png", alt: "R equals R1 plus R2" }],
          },
          difficulty: "MEDIUM",
        },
        {
          code: "IMG-JSON-002",
          question: "Which figure is a triangle?",
          options: [
            { label: "A", text: "", images: [{ file: "SAMPLE-005-A.png", alt: "A circle" }] },
            { label: "B", text: "", images: [{ file: "SAMPLE-005-B.png", alt: "A square" }] },
            { label: "C", text: "", images: [{ file: "SAMPLE-005-C.png", alt: "A triangle" }] },
            { label: "D", text: "", images: [{ file: "SAMPLE-005-D.png", alt: "A hexagon" }] },
          ],
          correct: "C",
          explanation: "A triangle has three sides.",
          difficulty: "EASY",
        },
        {
          code: "IMG-JSON-003",
          question: {
            text: "Figures 1 and 2 show the same circuit before and after a change. Which statement is true?",
            images: [
              { file: "SAMPLE-004-Q1.png", alt: "Circuit before" },
              { file: "SAMPLE-006-Q2.png", alt: "Circuit after" },
            ],
          },
          options: ["Current increases", "Current decreases", "No change", "Cannot say"],
          correct: "B",
          explanation: { text: "More resistance, less current.", images: [{ file: "SAMPLE-004-EXP1.png", decorative: true }] },
          difficulty: "HARD",
        },
      ],
    },
  },
  "multiple-correct": {
    title: "Multiple-correct (MSQ), Rich mode",
    doc: {
      schema: JSON_IMPORT_SCHEMA,
      defaults: { contentFormat: "RICH_V1", type: "MULTIPLE_CORRECT", subject: "Chemistry" },
      questions: [
        {
          code: "MSQ-JSON-001",
          question: "Which of the following are noble gases? (More than one option may be correct.)",
          options: ["\\ce{He}", "\\ce{Ne}", "\\ce{N2}", "\\ce{Ar}"],
          correct: ["A", "B", "D"],
          explanation: "He, Ne and Ar are group 18 elements; \\ce{N2} is not.",
          difficulty: "EASY",
        },
        {
          code: "MSQ-JSON-002",
          question: "Which quantities are vectors?",
          options: [
            { label: "A", text: "Velocity", correct: true },
            { label: "B", text: "Speed" },
            { label: "C", text: "Force", correct: true },
            { label: "D", text: "Work" },
          ],
          explanation: "Velocity and force have direction; speed and work are scalars.",
          difficulty: "MEDIUM",
        },
      ],
    },
  },
  "match-the-following": {
    title: "Match the Following, Rich mode",
    doc: {
      schema: JSON_IMPORT_SCHEMA,
      defaults: { contentFormat: "RICH_V1", type: "MATCH_THE_FOLLOWING", subject: "Chemistry" },
      questions: [
        {
          code: "MTF-JSON-001",
          question: "Match List I with List II.",
          matchLists: {
            listI: [
              { key: "A", text: "\\ce{CH4}" },
              { key: "B", text: "\\ce{C2H4}" },
              { key: "C", text: "\\ce{C2H2}" },
              { key: "D", text: "\\ce{C6H6}" },
            ],
            listII: [
              { key: "I", text: "Benzene" },
              { key: "II", text: "Methane" },
              { key: "III", text: "Ethene" },
              { key: "IV", text: "Ethyne" },
            ],
          },
          options: ["A-II, B-III, C-IV, D-I", "A-I, B-II, C-III, D-IV", "A-III, B-IV, C-I, D-II", "A-IV, B-I, C-II, D-III"],
          correct: "A",
          explanation: "Methane, ethene, ethyne, benzene.",
          difficulty: "MEDIUM",
        },
      ],
    },
  },
} as const;

export type JsonImportExampleId = keyof typeof JSON_IMPORT_EXAMPLES;

export function isJsonImportExampleId(v: string | null): v is JsonImportExampleId {
  return v !== null && Object.prototype.hasOwnProperty.call(JSON_IMPORT_EXAMPLES, v);
}

export function jsonImportExampleText(id: JsonImportExampleId): string {
  return `${JSON.stringify(JSON_IMPORT_EXAMPLES[id].doc, null, 2)}\n`;
}
