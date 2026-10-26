/**
 * JSON Schemas of the importer's model answers, sent as `response_format: json_schema` when a provider route of the
 * model supports structured outputs (importer-reliability-2). They describe the SAME shapes the prompts ask for and
 * the tolerant parsers in lib/ai-import/prompts.ts accept (non-strict: a route that cannot enforce them still answers
 * in plain JSON, which is parsed and validated exactly as before). Nothing here relaxes validation.
 */

const str = { type: ["string", "null"] };
const strList = { type: "array", items: { type: "string" } };
const box = { type: ["object", "null"], properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } }, required: ["x", "y", "w", "h"] };

const extract = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          number: { type: ["integer", "string", "null"] },
          section: str,
          type: str,
          instructions: str,
          passage: str,
          stem: { type: "string" },
          rich: { type: ["boolean", "null"] },
          options: { type: "array", items: { type: "object", properties: { label: str, text: { type: "string" } }, required: ["label", "text"] } },
          list_i: { type: "array", items: { type: "object", properties: { key: str, text: { type: "string" } }, required: ["key", "text"] } },
          list_ii: { type: "array", items: { type: "object", properties: { key: str, text: { type: "string" } }, required: ["key", "text"] } },
          printed_answer: strList,
          explanation: str,
          figures: { type: "array", items: { type: "object", properties: { box, owner: { type: "string" }, option_label: str, shared_with: { type: "array", items: { type: ["integer", "string"] } }, description: str, caption: str }, required: ["owner"] } },
          region: box,
          unreadable: strList,
          confidence: { type: "number" },
          continues_on_next_page: { type: ["boolean", "null"] },
          continued_from_previous_page: { type: ["boolean", "null"] },
        },
        required: ["number", "stem", "options", "printed_answer", "confidence"],
      },
    },
    answer_key: { type: ["array", "null"], items: { type: "object", properties: { number: { type: ["integer", "string"] }, answer: { type: "string" } }, required: ["number", "answer"] } },
    paper_header: { type: ["object", "null"], properties: { paper: str, series: str, set: str, total_questions: { type: ["integer", "string", "null"] }, exam: str } },
    page_notes: str,
  },
  required: ["questions"],
};

const classify = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: { q: { type: "string" }, subject: str, topic: str, subtopic: str, confidence: { type: "number" }, about: { type: ["array", "string", "null"], items: { type: "string" } }, reason: str },
        required: ["q", "subject", "topic", "confidence"],
      },
    },
  },
  required: ["results"],
};

export const OUTPUT_SCHEMAS = { extract, classify } as const;
export type OutputSchemaName = keyof typeof OUTPUT_SCHEMAS;
