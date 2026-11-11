/**
 * JSON Schemas of the importer's model answers, sent as `response_format: json_schema` when a provider route of the
 * model supports structured outputs (importer-reliability-2). They describe the SAME shapes the prompts ask for and
 * the tolerant parsers in lib/ai-import/prompts.ts accept (non-strict: a route that cannot enforce them still answers
 * in plain JSON, which is parsed and validated exactly as before). Nothing here relaxes validation.
 *
 * 2026-11-11: Anthropic refuses a schema with more than 16 union-typed parameters (type arrays / anyOf); the extract
 * schema had 20 (31 counted per occurrence). Optional fields are now plain types and simply left out when there is
 * nothing to say (the parser treats a missing field, "" and null alike); only the question / key NUMBER keeps a union
 * (printed numbers can be "12a"). Same fields as before: nothing the importer reads was dropped.
 */

const str = { type: "string" };
const strList = { type: "array", items: { type: "string" } };
const box = { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } }, required: ["x", "y", "w", "h"] };

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
          rich: { type: "boolean" },
          options: { type: "array", items: { type: "object", properties: { label: str, text: { type: "string" } }, required: ["label", "text"] } },
          list_i: { type: "array", items: { type: "object", properties: { key: str, text: { type: "string" } }, required: ["key", "text"] } },
          list_ii: { type: "array", items: { type: "object", properties: { key: str, text: { type: "string" } }, required: ["key", "text"] } },
          printed_answer: strList,
          explanation: str,
          figures: { type: "array", items: { type: "object", properties: { box, owner: { type: "string" }, option_label: str, shared_with: { type: "array", items: { type: "string" } }, description: str, caption: str }, required: ["owner"] } },
          region: box,
          unreadable: strList,
          confidence: { type: "number" },
          continues_on_next_page: { type: "boolean" },
          continued_from_previous_page: { type: "boolean" },
          // Bilingual papers only (optional; English-only readings leave it out).
          hi: { type: "object", properties: { stem: { type: "string" }, options: { type: "array", items: { type: "object", properties: { label: str, text: { type: "string" } }, required: ["label", "text"] } }, confidence: { type: "number" }, unreadable: strList, same_option_order: { type: "boolean" }, figures_differ: { type: "boolean" } }, required: ["stem", "options"] },
        },
        required: ["number", "stem", "options", "printed_answer", "confidence"],
      },
    },
    answer_key: { type: "array", items: { type: "object", properties: { number: { type: ["integer", "string"] }, answer: { type: "string" } }, required: ["number", "answer"] } },
    paper_header: { type: "object", properties: { paper: str, series: str, set: str, total_questions: { type: "string" }, exam: str } },
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
        properties: { q: { type: "string" }, subject: str, topic: str, subtopic: str, confidence: { type: "number" }, about: { type: "array", items: { type: "string" } }, reason: str },
        required: ["q", "subject", "topic", "confidence"],
      },
    },
  },
  required: ["results"],
};

export const OUTPUT_SCHEMAS = { extract, classify } as const;
export type OutputSchemaName = keyof typeof OUTPUT_SCHEMAS;
