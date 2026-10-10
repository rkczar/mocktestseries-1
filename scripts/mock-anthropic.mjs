/**
 * Mock of api.anthropic.com for the AI Gateway / Claude provider / AI Studio
 * tests. Never talks to Anthropic. Bound to 127.0.0.1 only; the app accepts it
 * only through ANTHROPIC_TEST_BASE_URL=http://127.0.0.1:<port>.
 *
 *   node scripts/mock-anthropic.mjs 3189
 *
 * The scenario is chosen by the (fake) key's suffix:
 *   sk-ant-mock…-valid      everything works
 *   …-bad                   401 authentication_error
 *   …-perm                  403 permission_error
 *   …-billing               400 "Your credit balance is too low"
 *   …-overload              529 overloaded_error on messages
 *   …-ratelimit             429 rate_limit_error on messages
 *   …-slow                  messages answer after 3 s
 *   …-refuse                stop_reason "refusal"
 *   …-wrongsolve            the blind re-solve of a trap disagrees
 *   …-trendlies             trend analysis cites evidence ids that don't exist
 * /v1/models lists claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5.
 *
 * Messages answer by recognising the app's prompts (carousel content, diagram,
 * trap, blind solve, captions, trends, competitors, student explanation).
 * GET /__mock/stats → calls seen (keys only as their last 6 characters).
 */
import http from "node:http";

export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

export function mockKey(scenario) {
  const rand = Array.from({ length: 40 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
  return `sk-ant-mock${rand}-${scenario}`;
}

const scenarioOf = (key) => (key ?? "").split("-").pop();

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "request-id": "req_mock" });
  res.end(JSON.stringify(body));
}

function err(res, status, type, message) {
  json(res, status, { type: "error", error: { type, message } });
}

function answerFor(prompt, scenario) {
  const key = /Correct answer \(from the official key\): ([A-F, ]+)/.exec(prompt)?.[1]?.trim() ?? /Correct answer \(official key\): ([A-F, ]+)/.exec(prompt)?.[1]?.trim() ?? "B";
  if (prompt.includes("Reply with the single word OK")) return "OK";
  if (prompt.includes("Answer this medical multiple-choice question")) {
    return JSON.stringify({ answer: scenario === "wrongsolve" ? "C" : "B", ambiguous: false, reason: "Valproate covers both seizure types." });
  }
  if (prompt.includes("examiner-style variant MCQ")) {
    return JSON.stringify({
      text: "A 9-year-old has absence seizures and generalized tonic-clonic seizures. Which single drug controls both?",
      options: [
        { label: "A", text: "Ethosuximide", isCorrect: false },
        { label: "B", text: "Sodium valproate", isCorrect: true },
        { label: "C", text: "Carbamazepine", isCorrect: false },
        { label: "D", text: "Phenytoin", isCorrect: false },
      ],
      tempting: "A",
      trapExplanation: "Ethosuximide is the classic absence drug, so students pick it — but it does not control tonic-clonic seizures.",
      avoidTip: "Read every seizure type in the stem; mixed generalized epilepsy needs a broad-spectrum drug.",
      confidence: "high",
      concerns: [],
    });
  }
  if (prompt.includes("plan ONE medical concept diagram")) {
    if (prompt.includes('"comparison"') && !prompt.includes("Choose the diagram type")) {
      return JSON.stringify({
        kind: "comparison",
        title: "Absence vs focal impaired-awareness seizures",
        columns: ["Feature", "Absence", "Focal impaired awareness"],
        rows: [
          { label: "Aura", cells: ["None", "Often present"] },
          { label: "Duration", cells: ["Seconds", "1–2 minutes"] },
          { label: "Post-ictal state", cells: ["None", "Confusion"] },
        ],
        footnote: "Schematic comparison",
        confidence: "high",
        concerns: [],
      });
    }
    return JSON.stringify({
      kind: "mechanism",
      title: "How ethosuximide stops absence seizures",
      nodes: [
        { id: "n1", label: "Thalamic relay neurons", note: "T-type calcium channels" },
        { id: "n2", label: "Rhythmic burst firing" },
        { id: "n3", label: "3 Hz spike-and-wave on EEG" },
        { id: "n4", label: "Ethosuximide blocks T-type channels", note: "bursts stop" },
      ],
      footnote: "",
      confidence: "high",
      concerns: [],
    });
  }
  if (prompt.includes("THREE editable caption versions")) {
    const tags = ["#MedicalOfficer", "#MOExam", "#Pharmacology", "#PYQ", "#MedicalMCQ", "#MBBS", "#Antiepileptics", "#NEETUG", "#ExamPrep"];
    return JSON.stringify({
      versions: [
        { style: "professional", caption: "Absence seizures: which drug is first choice?\n\nEthosuximide blocks T-type calcium channels in the thalamus.\n\nComment your answer below.\nSave this for revision and share it with a friend.\nPractise more at mocktestseries.in", hashtags: tags },
        { style: "hook", caption: "A 7-year-old keeps staring blankly for seconds. What do you start?\n\nComment A, B, C or D.\nSave and share.\nPractise more at mocktestseries.in", hashtags: tags },
        { style: "search", caption: "Antiepileptics MCQ for Medical Officer exam — absence seizure drug of choice (PYQ).\n\nWhat is your answer?\nSave this post.\nMore MO exam practice at mocktestseries.in", hashtags: tags },
      ],
      keywords: ["absence seizure drug of choice", "antiepileptics MCQ", "NEET UG biology", "Medical Officer exam PYQ"],
      evidenceUsed: [],
    });
  }
  if (prompt.includes("analyse Instagram content opportunities")) {
    const ids = [...prompt.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]);
    const ev = scenario === "trendlies" ? ["made-up:1"] : ids.slice(0, 1);
    return JSON.stringify({
      evidenceBacked: [{ topic: "Antiepileptics", why: "Most-missed on the platform this week.", evidence: ev }],
      emerging: [{ topic: "Invented hot topic", why: "No evidence.", evidence: [] }],
      evergreen: ids.length > 1 ? [{ topic: "Pharmacology PYQs", why: "Many stored PYQs.", evidence: [ids[1]] }] : [],
      examSeason: [],
      note: "Limited evidence.",
    });
  }
  if (prompt.includes("analyse competitor/reference Instagram content")) {
    const ids = [...prompt.matchAll(/^\[(ref:[^\]]+)\]/gm)].map((m) => m[1]);
    return JSON.stringify({
      patterns: [{ observation: "Carousels with a question hook dominate.", evidence: ids.slice(0, 2) }],
      contentGaps: [{ idea: "Few examiner-trap posts.", evidence: ids.slice(0, 1) }, { idea: "Uncited idea", evidence: ["ref:nope"] }],
      captionStyles: [{ style: "Question first, 3 facts, CTA", evidence: ids.slice(0, 1) }],
      note: "Manual references only.",
    });
  }
  if (prompt.includes("You write Instagram carousel content")) {
    const want = (k) => prompt.includes(`"${k}":`);
    const out = { answerLabel: key, confidence: "high", concerns: [] };
    if (want("hooks")) out.hooks = [
      { style: "curiosity", text: "Can You Solve This MO PYQ?" },
      { style: "challenge", text: "Only Sharp Aspirants Get This Right" },
      { style: "memory", text: "Remember This Drug in 10 Seconds" },
    ];
    if (want("explanation")) out.explanation = "Ethosuximide blocks thalamic T-type calcium channels that drive the 3 Hz spike-and-wave rhythm of absence seizures.";
    if (want("memoryTrick")) out.memoryTrick = "ETHOsuximide = Empty THOughts (blank stare).";
    if (want("clinicalPearl")) out.clinicalPearl = "Valproate is preferred when absence and tonic-clonic seizures coexist.";
    if (want("quickRevision")) out.quickRevision = ["T-type calcium channel blocker", "EEG: 3 Hz spike-and-wave"];
    if (want("pearls")) out.pearls = ["Brief staring spells without post-ictal confusion", "Hyperventilation provokes absence in clinic", "Valproate covers mixed generalized epilepsy"];
    if (want("mistakes")) out.mistakes = ["Choosing carbamazepine — it can worsen absence seizures", "Confusing absence with focal impaired-awareness seizures"];
    if (want("finalTrick")) out.finalTrick = "Absence = Ethosuximide.";
    if (want("caption")) out.caption = "Absence seizure drug of choice?\nComment your answer and save this post.";
    if (want("hashtags")) out.hashtags = ["#MedicalOfficer", "#Pharmacology", "#PYQ", "#MedicalMCQ", "#MBBS", "#MOExam", "#Antiepileptics", "#ExamPrep"];
    return JSON.stringify(out);
  }
  // Student AI explanation / variants (generic valid JSON).
  return JSON.stringify({
    concept: "Mock concept explanation.",
    optionAnalysis: { A: "Wrong.", B: "Right." },
    pointsToRemember: ["Point one"],
    memoryTrick: "Mock trick",
    examinerTraps: [],
    trapWords: [],
    examinerVariation: "",
  });
}

export function startMockAnthropic(port) {
  const stats = { messages: 0, models: 0, keys: [], prompts: [], modelsUsed: [] };
  const server = http.createServer(async (req, res) => {
    const key = req.headers["x-api-key"];
    const scenario = scenarioOf(typeof key === "string" ? key : "");
    if (req.url === "/__mock/stats") return json(res, 200, stats);
    if (typeof key !== "string" || !key.startsWith("sk-ant-")) return err(res, 401, "authentication_error", "invalid x-api-key");
    stats.keys.push(key.slice(-6));
    if (scenario === "bad") return err(res, 401, "authentication_error", "invalid x-api-key");
    if (scenario === "perm") return err(res, 403, "permission_error", "Your API key does not have permission to use the specified resource.");
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      stats.models++;
      return json(res, 200, { data: MODELS.map((id) => ({ type: "model", id, display_name: id.replace(/^claude-/, "Claude ").replace(/-/g, " "), created_at: "2026-01-01T00:00:00Z", capabilities: null, max_input_tokens: 1000000, max_tokens: 128000 })), has_more: false, first_id: MODELS[0], last_id: MODELS.at(-1) });
    }
    if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
      let raw = "";
      for await (const c of req) raw += c;
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        return err(res, 400, "invalid_request_error", "bad json");
      }
      stats.messages++;
      stats.modelsUsed.push(body.model);
      if (!MODELS.includes(body.model)) return err(res, 404, "not_found_error", `model: ${body.model}`);
      if (scenario === "billing") return err(res, 400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");
      if (scenario === "overload") return err(res, 529, "overloaded_error", "Overloaded");
      if (scenario === "ratelimit") return err(res, 429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit");
      if (scenario === "slow") await new Promise((r) => setTimeout(r, 3000));
      const prompt = String(body.messages?.[0]?.content ?? "");
      stats.prompts.push(prompt.slice(0, 80));
      if (scenario === "refuse") return json(res, 200, { id: "msg_mock", type: "message", role: "assistant", model: body.model, content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null }, usage: { input_tokens: 10, output_tokens: 0 } });
      const text = answerFor(prompt, scenario);
      return json(res, 200, {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1000 + Math.round(prompt.length / 4), output_tokens: 250 },
      });
    }
    return err(res, 404, "not_found_error", "not found");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, stats, base: `http://127.0.0.1:${port}` })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 3189);
  startMockAnthropic(port).then(({ base }) => console.log(`mock anthropic on ${base}`));
}
