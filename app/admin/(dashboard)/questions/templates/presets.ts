/**
 * Question Templates — column & preset definitions (Phase 7 Template Builder).
 *
 * Pure, code-defined configuration. Nothing here is persisted to the
 * database — there is no "saved presets" schema, and this module must not
 * gain one. It is shared by the client-side builder UI
 * (`template-builder.tsx`) and the server-side generation route
 * (`app/api/admin/questions/templates/generate/route.ts`), so it must stay
 * free of server-only / client-only imports.
 *
 * Column `header` strings are the literal text written into the generated
 * CSV/XLSX header row. They are chosen so that
 * `normalizeColumnName()` in `lib/bulk-import.ts` maps them back onto the
 * exact same internal keys the bulk importer already parses — a template
 * downloaded here must round-trip through Bulk Import without edits.
 *
 * A handful of columns (see `NOT_YET_IMPORTED_KEYS` below) describe fields
 * the product spec calls for (per-option image filenames, source PDF page,
 * review fields, question type, paper code/number) that do not have
 * `COLUMN_ALIASES` entries in `lib/bulk-import.ts` yet — another agent is
 * adding them in parallel. Generating them here is still safe: an
 * unrecognized header is simply left keyed by its literal (normalized) text
 * and ignored by `mapRowData`, so it never breaks today's import. None of
 * these columns are ever marked REQUIRED for that reason.
 */

export type ColumnGroupId =
  | "IDENTITY"
  | "TAXONOMY"
  | "QUESTION"
  | "OPTIONS"
  | "ANSWER"
  | "CLASSIFICATION"
  | "MEDIA"
  | "SOURCE_REVIEW";

export const COLUMN_GROUPS: { id: ColumnGroupId; title: string }[] = [
  { id: "IDENTITY", title: "Identity" },
  { id: "TAXONOMY", title: "Taxonomy" },
  { id: "QUESTION", title: "Question" },
  { id: "OPTIONS", title: "Options" },
  { id: "ANSWER", title: "Answer" },
  { id: "CLASSIFICATION", title: "Classification" },
  { id: "MEDIA", title: "Media" },
  { id: "SOURCE_REVIEW", title: "Source / Review" },
];

export type RequirementLevel = "REQUIRED" | "OPTIONAL" | "CONDITIONAL";

export interface ColumnDef {
  /** Internal key — matches (or, for new columns, is expected to match) the
   *  `COLUMN_ALIASES` key in `lib/bulk-import.ts`. */
  key: string;
  /** Literal header text written into the generated file. */
  header: string;
  /** Friendlier label shown in the builder UI (may differ from `header`). */
  label: string;
  group: ColumnGroupId;
  /** Plain-language guidance shown in the generated file's INSTRUCTIONS sheet. */
  instructions: string;
  /** Example value used to fill the EXAMPLE ROW sheet. */
  example: string;
}

export const COLUMN_DEFS: ColumnDef[] = [
  // IDENTITY
  {
    key: "questionCode",
    header: "Question Code",
    label: "Question Code",
    group: "IDENTITY",
    instructions:
      "Leave blank to let the system auto-assign a canonical code on import. Only set this if you are re-importing/updating an existing question.",
    example: "",
  },
  {
    key: "exam",
    header: "Exam",
    label: "Exam",
    group: "IDENTITY",
    instructions: "Exact Exam name as configured in Admin -> Exams -> Manage Exams (not the exam code).",
    example: "",
  },
  {
    key: "examYear",
    header: "Year",
    label: "Year",
    group: "IDENTITY",
    instructions: "4-digit exam year, e.g. 2024.",
    example: "",
  },
  {
    key: "paperCode",
    header: "Paper Code",
    label: "Paper / PYQ Code",
    group: "IDENTITY",
    instructions:
      "Optional free-text reference to the specific previous-year paper (e.g. its title/code in Admin -> Exams -> Previous Year Papers). Informational only today.",
    example: "",
  },
  {
    key: "questionNumber",
    header: "Question Number",
    label: "Question Number",
    group: "IDENTITY",
    instructions: "The question's number/position in the source paper or PDF, if applicable.",
    example: "",
  },

  // TAXONOMY
  {
    key: "subject",
    header: "Subject",
    label: "Subject",
    group: "TAXONOMY",
    instructions: "Exact Subject name, must already exist under the selected Exam.",
    example: "",
  },
  {
    key: "topic",
    header: "Topic",
    label: "Topic / Chapter",
    group: "TAXONOMY",
    instructions: "Exact Topic name, must already exist under the selected Subject.",
    example: "",
  },
  {
    key: "subTopic",
    header: "SubTopic",
    label: "SubTopic",
    group: "TAXONOMY",
    instructions: "Exact SubTopic name, must already exist under the selected Topic.",
    example: "",
  },

  // QUESTION
  {
    key: "questionType",
    header: "Question Type",
    label: "Question Type",
    group: "QUESTION",
    instructions:
      "Only single-answer MCQ is currently supported by the Question Bank. Leave as MCQ.",
    example: "MCQ",
  },
  {
    key: "questionText",
    header: "Question Text",
    label: "Question Text",
    group: "QUESTION",
    instructions: "The full question text shown to students.",
    example: "",
  },

  // OPTIONS
  {
    key: "optionA",
    header: "Option A",
    label: "Option A",
    group: "OPTIONS",
    instructions: "Text for option A.",
    example: "",
  },
  {
    key: "optionB",
    header: "Option B",
    label: "Option B",
    group: "OPTIONS",
    instructions: "Text for option B.",
    example: "",
  },
  {
    key: "optionC",
    header: "Option C",
    label: "Option C",
    group: "OPTIONS",
    instructions: "Text for option C.",
    example: "",
  },
  {
    key: "optionD",
    header: "Option D",
    label: "Option D",
    group: "OPTIONS",
    instructions: "Text for option D.",
    example: "",
  },

  // ANSWER
  {
    key: "correctAnswer",
    header: "Correct Answer",
    label: "Correct Answer",
    group: "ANSWER",
    instructions: "One of A, B, C, or D (case-insensitive).",
    example: "",
  },
  {
    key: "explanation",
    header: "Explanation",
    label: "Solution / Explanation",
    group: "ANSWER",
    instructions: "Optional explanation/solution shown to students after they answer.",
    example: "",
  },

  // CLASSIFICATION
  {
    key: "difficulty",
    header: "Difficulty",
    label: "Difficulty",
    group: "CLASSIFICATION",
    instructions: "One of EASY, MEDIUM, or HARD.",
    example: "",
  },
  {
    key: "source",
    header: "Source",
    label: "Source",
    group: "CLASSIFICATION",
    instructions:
      'Where the question comes from. Use "PYQ" for a previous-year question (matched to a Previous Year Paper by Exam + Year), or "Question Bank" for an originally authored question.',
    example: "",
  },
  {
    key: "status",
    header: "Status",
    label: "Status",
    group: "CLASSIFICATION",
    instructions: "One of DRAFT, PUBLISHED, or ARCHIVED. Leave blank to default to DRAFT.",
    example: "",
  },

  // MEDIA
  {
    key: "hasQuestionImage",
    header: "Has Question Image",
    label: "Has Question Image",
    group: "MEDIA",
    instructions: 'Set to "TRUE" if the question itself needs an image, otherwise leave blank/FALSE.',
    example: "",
  },
  {
    key: "questionImageFilename",
    header: "Question Image Filename",
    label: "Question Image Filename",
    group: "MEDIA",
    instructions:
      "Filename of the question image (uploaded separately via the Bulk Import image step), e.g. q001.png. Only needed when Has Question Image is TRUE.",
    example: "",
  },
  {
    key: "optionAImageFilename",
    header: "Option A Image Filename",
    label: "Option A Image Filename",
    group: "MEDIA",
    instructions: "Filename of Option A's image, if Option A is image-based.",
    example: "",
  },
  {
    key: "optionBImageFilename",
    header: "Option B Image Filename",
    label: "Option B Image Filename",
    group: "MEDIA",
    instructions: "Filename of Option B's image, if Option B is image-based.",
    example: "",
  },
  {
    key: "optionCImageFilename",
    header: "Option C Image Filename",
    label: "Option C Image Filename",
    group: "MEDIA",
    instructions: "Filename of Option C's image, if Option C is image-based.",
    example: "",
  },
  {
    key: "optionDImageFilename",
    header: "Option D Image Filename",
    label: "Option D Image Filename",
    group: "MEDIA",
    instructions: "Filename of Option D's image, if Option D is image-based.",
    example: "",
  },

  // SOURCE / REVIEW
  {
    key: "sourcePdfPage",
    header: "Source PDF Page",
    label: "Source PDF Page",
    group: "SOURCE_REVIEW",
    instructions: "Page number in the original source PDF this question was digitized from, if any.",
    example: "",
  },
  {
    key: "reviewRequired",
    header: "Review Required",
    label: "Review Required",
    group: "SOURCE_REVIEW",
    instructions: 'Set to "TRUE" to flag this question for manual admin review after import.',
    example: "",
  },
  {
    key: "reviewReason",
    header: "Review Reason",
    label: "Review Reason",
    group: "SOURCE_REVIEW",
    instructions: "Free-text reason the question needs review (e.g. \"uncertain taxonomy match\").",
    example: "",
  },
];

export const COLUMN_BY_KEY: Record<string, ColumnDef> = Object.fromEntries(
  COLUMN_DEFS.map((c) => [c.key, c])
);

/** Columns the real bulk importer already hard-requires on every row
 *  (see the `errors.push(...)` checks in `validateImportRows`,
 *  lib/bulk-import.ts) — missing any of these makes a row an ERROR that
 *  cannot become a Question at all. These are always REQUIRED and always
 *  selected, in every preset including CUSTOM. Topic/SubTopic/Source are
 *  deliberately NOT here: the validator only WARNs on those (Topic/SubTopic
 *  are optional on Question; Source defaults to Question Bank) — they're
 *  marked OPTIONAL below instead, matching the real import behavior. */
export const REQUIRED_CORE_KEYS = [
  "exam",
  "examYear",
  "subject",
  "questionText",
  "optionA",
  "optionB",
  "optionC",
  "optionD",
  "correctAnswer",
  "difficulty",
] as const;

/** Columns whose `lib/bulk-import.ts` COLUMN_ALIASES entry does not exist
 *  yet (another agent is adding it in parallel). Never mark these REQUIRED. */
export const NOT_YET_IMPORTED_KEYS = [
  "paperCode",
  "questionNumber",
  "questionType",
  "hasQuestionImage",
  "questionImageFilename",
  "optionAImageFilename",
  "optionBImageFilename",
  "optionCImageFilename",
  "optionDImageFilename",
  "sourcePdfPage",
  "reviewRequired",
  "reviewReason",
] as const;

export type PresetId =
  | "BASIC_MCQ"
  | "FULL_QUESTION_BANK"
  | "PYQ_TEMPLATE"
  | "IMAGE_QUESTION_TEMPLATE"
  | "CUSTOM";

export interface PresetConfig {
  id: PresetId;
  name: string;
  description: string;
  /** Requirement level for every non-required-core column this preset
   *  includes at all. Keys not present here are simply not part of the
   *  preset's default column set (still toggle-able, as OPTIONAL, from the
   *  builder UI — every preset can be fine-tuned). */
  requirements: Partial<Record<string, RequirementLevel>>;
  /** Which non-required-core columns start checked. */
  defaultChecked: string[];
}

const ALL_OPTIONAL_KEYS = COLUMN_DEFS.map((c) => c.key).filter(
  (k) => !(REQUIRED_CORE_KEYS as readonly string[]).includes(k)
);

/** Columns that are only ever meaningful alongside another column/value
 *  (e.g. an image filename is only needed when its "has image" flag is
 *  set, a paper code only matters for a PYQ). This is the fallback
 *  requirement label used whenever a preset doesn't explicitly override it
 *  — it keeps the CONDITIONAL badge consistent across every preset that
 *  includes the column, not just the preset built around it. */
const NATURAL_REQUIREMENT: Partial<Record<string, RequirementLevel>> = {
  paperCode: "CONDITIONAL",
  questionNumber: "CONDITIONAL",
  questionImageFilename: "CONDITIONAL",
  optionAImageFilename: "CONDITIONAL",
  optionBImageFilename: "CONDITIONAL",
  optionCImageFilename: "CONDITIONAL",
  optionDImageFilename: "CONDITIONAL",
  reviewReason: "CONDITIONAL",
};

function naturalRequirements(keys: string[]): Partial<Record<string, RequirementLevel>> {
  return Object.fromEntries(keys.map((k) => [k, NATURAL_REQUIREMENT[k] ?? "OPTIONAL"]));
}

export const PRESETS: Record<PresetId, PresetConfig> = {
  BASIC_MCQ: {
    id: "BASIC_MCQ",
    name: "Basic MCQ",
    description: "The minimum columns needed for a straightforward single-answer MCQ import.",
    requirements: {
      questionCode: "OPTIONAL",
      topic: "OPTIONAL",
      explanation: "OPTIONAL",
      status: "OPTIONAL",
    },
    defaultChecked: ["questionCode", "topic", "explanation", "status"],
  },
  FULL_QUESTION_BANK: {
    id: "FULL_QUESTION_BANK",
    name: "Full Question Bank",
    description: "Every supported column — identity, taxonomy, media, and source/review fields included.",
    requirements: naturalRequirements(ALL_OPTIONAL_KEYS),
    defaultChecked: ALL_OPTIONAL_KEYS,
  },
  PYQ_TEMPLATE: {
    id: "PYQ_TEMPLATE",
    name: "Previous Year Paper (PYQ)",
    description: "Adds paper/question-number identity fields for digitizing a previous-year paper.",
    requirements: {
      questionCode: "OPTIONAL",
      topic: "OPTIONAL",
      subTopic: "OPTIONAL",
      paperCode: "CONDITIONAL",
      questionNumber: "CONDITIONAL",
      explanation: "OPTIONAL",
      status: "OPTIONAL",
      sourcePdfPage: "OPTIONAL",
      reviewRequired: "OPTIONAL",
      reviewReason: "OPTIONAL",
    },
    defaultChecked: ["topic", "subTopic", "paperCode", "questionNumber", "explanation", "status", "sourcePdfPage"],
  },
  IMAGE_QUESTION_TEMPLATE: {
    id: "IMAGE_QUESTION_TEMPLATE",
    name: "Image-Based Question",
    description: "Adds the has-image flag and per-question/option image filename columns.",
    requirements: {
      topic: "OPTIONAL",
      subTopic: "OPTIONAL",
      hasQuestionImage: "CONDITIONAL",
      questionImageFilename: "CONDITIONAL",
      optionAImageFilename: "CONDITIONAL",
      optionBImageFilename: "CONDITIONAL",
      optionCImageFilename: "CONDITIONAL",
      optionDImageFilename: "CONDITIONAL",
      explanation: "OPTIONAL",
      status: "OPTIONAL",
      reviewRequired: "OPTIONAL",
      reviewReason: "OPTIONAL",
    },
    defaultChecked: [
      "topic",
      "subTopic",
      "hasQuestionImage",
      "questionImageFilename",
      "optionAImageFilename",
      "optionBImageFilename",
      "optionCImageFilename",
      "optionDImageFilename",
      "explanation",
      "status",
      "reviewRequired",
      "reviewReason",
    ],
  },
  CUSTOM: {
    id: "CUSTOM",
    name: "Custom",
    description: "Start from the required columns only and pick anything else you need.",
    requirements: naturalRequirements(ALL_OPTIONAL_KEYS),
    defaultChecked: [],
  },
};

/** Requirement level of `key` under `presetId` — required-core columns are
 *  always REQUIRED regardless of preset. */
export function getRequirement(presetId: PresetId, key: string): RequirementLevel {
  if ((REQUIRED_CORE_KEYS as readonly string[]).includes(key)) return "REQUIRED";
  return PRESETS[presetId].requirements[key] ?? "OPTIONAL";
}

/** True if `selectedKeys` would produce a template that can round-trip
 *  through the real bulk importer (i.e. contains every required-core
 *  column). Returns the missing required columns' labels when it can't. */
export function validateSelection(selectedKeys: string[]): { ok: boolean; missingLabels: string[] } {
  const selected = new Set(selectedKeys);
  const missing = REQUIRED_CORE_KEYS.filter((k) => !selected.has(k));
  return {
    ok: missing.length === 0,
    missingLabels: missing.map((k) => COLUMN_BY_KEY[k]?.label ?? k),
  };
}

export const FILE_FORMATS = [
  { id: "csv", label: "CSV" },
  { id: "xlsx", label: "XLSX" },
] as const;

export type FileFormat = (typeof FILE_FORMATS)[number]["id"];
