// Live CBT load model (ops/load-test/run-live-cbt.sh). One VU = one candidate
// of an enrollment-enabled Fixed Window mock (ops/load-test/live-cbt-setup.ts):
//
//   1. at the fixed start time (+0–JITTER_S s, everyone clicking Start together):
//      open the test page, press Start Live Test (the real server action),
//      load the player (question payload)
//   2. answer: one autosave every SAVE_S s (±40 %), heartbeat every 60 s
//   3. at the window end: submit (the player auto-submits at its deadline;
//      SUBMIT_JITTER_S spreads the arrival like real clock skew), then open
//      the result page (released at the window end). Every 10th candidate
//      instead finishes EARLY (mid-window) and its result must be held.
//
// Only targets a local isolated instance on a disposable loadtest database.
//   k6 run -e BASE=http://127.0.0.1:8088 -e FIXTURE=lt.json -e MOCK=<id> -e START_MS=… -e END_MS=… \
//          -e CANDIDATES=100 ops/load-test/k6/live-cbt.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";

const BASE = __ENV.BASE || "http://127.0.0.1:8088";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw new Error("load tests only target a local isolated instance");
const F = JSON.parse(open(__ENV.FIXTURE));
const MOCK = __ENV.MOCK;
const START = Number(__ENV.START_MS);
const END = Number(__ENV.END_MS);
const N = Number(__ENV.CANDIDATES || 50);
const JITTER_S = Number(__ENV.JITTER_S || 5);
const SAVE_S = Number(__ENV.SAVE_S || 15);
const SUBMIT_JITTER_S = Number(__ENV.SUBMIT_JITTER_S || 1);

const lat = {
  page: new Trend("lat_page", true),
  start: new Trend("lat_start", true),
  run: new Trend("lat_run", true),
  save: new Trend("lat_save", true),
  heartbeat: new Trend("lat_heartbeat", true),
  submit: new Trend("lat_submit", true),
  result: new Trend("lat_result", true),
};
const submitDoneAfterEnd = new Trend("submit_done_after_end_ms");
const errors = new Counter("app_errors");
const started = new Counter("candidates_started");
const submitted = new Counter("candidates_submitted");
const held = new Counter("results_held_ok");

export const options = {
  discardResponseBodies: false,
  scenarios: { live: { executor: "per-vu-iterations", vus: N, iterations: 1, maxDuration: `${Math.ceil((END - Date.now()) / 1000) + 240}s` } },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
};

let student;
const hdr = (extra = {}) => ({ Cookie: `student-session-token=${student.token}`, ...extra });
const fail = (op, r) => {
  errors.add(1, { op, status: String(r ? r.status : 0) });
  return false;
};

function serverAction(path, id, args, trend, timeout = "120s") {
  const r = http.post(`${BASE}${path}`, JSON.stringify(args), {
    headers: hdr({ "Next-Action": id, Accept: "text/x-component", "Content-Type": "text/plain;charset=UTF-8", Origin: BASE }),
    redirects: 0,
    timeout,
    tags: { name: trend },
  });
  lat[trend].add(r.timings.duration);
  const ok = (r.status === 200 && !/"ok":false/.test(r.body || "")) || r.status === 303;
  if (!ok) fail(trend, r);
  check(r, { [`${trend} ok`]: () => ok });
  return { r, ok };
}

function formAction(path, id, fields, trend) {
  const boundary = "----mtsk6" + Math.random().toString(36).slice(2);
  const part = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = Object.entries(fields).map(([k, v]) => part(`_1_${k}`, v)).join("") + part("0", '[{},"$K1"]') + `--${boundary}--\r\n`;
  const r = http.post(`${BASE}${path}`, body, {
    headers: hdr({ "Next-Action": id, Accept: "text/x-component", "Content-Type": `multipart/form-data; boundary=${boundary}`, Origin: BASE }),
    redirects: 0,
    timeout: "120s",
    tags: { name: trend },
  });
  lat[trend].add(r.timings.duration);
  return r;
}

function get(path, trend) {
  const r = http.get(`${BASE}${path}`, { headers: hdr(), redirects: 0, timeout: "120s", tags: { name: trend } });
  lat[trend].add(r.timings.duration);
  if (r.status !== 200) fail(trend, r);
  return r;
}

const waitUntil = (ms) => {
  const s = (ms - Date.now()) / 1000;
  if (s > 0) sleep(s);
};

export default function () {
  student = F.students[__VU - 1];
  const qs = F.questionIdsByMock[MOCK];

  // 1. start together
  waitUntil(START + Math.random() * JITTER_S * 1000);
  get(`/student/test-series/${MOCK}`, "page");
  const sr = formAction(`/student/test-series/${MOCK}`, F.actions.startMockTestFromDetailsAction, { mockTestId: MOCK }, "start");
  const where = (sr.headers["X-Action-Redirect"] || sr.headers["Location"] || "") + "";
  const m = where.match(/\/student\/attempt\/([^/;?]+)\/run/);
  if (!m) {
    fail("start", sr);
    return;
  }
  started.add(1);
  const attemptId = m[1];
  const run = get(`/student/attempt/${attemptId}/run`, "run");
  check(run, { "player loaded": (r) => r.status === 200 });

  // 2. answer until the window closes
  let seq = Date.now();
  let nextBeat = Date.now() + 60_000;
  const early = __VU % 10 === 0;
  const stopAt = early ? START + (END - START) / 2 : END - SAVE_S * 1000;
  while (Date.now() < stopAt) {
    sleep(SAVE_S * (0.6 + Math.random() * 0.8));
    if (Date.now() >= END - 1500) break;
    const q = qs[Math.floor(Math.random() * qs.length)];
    serverAction(`/student/attempt/${attemptId}/run`, F.actions.saveAnswerAction, [attemptId, q, ["A", "B", "C", "D"][Math.floor(Math.random() * 4)], false, ++seq], "save", "60s");
    if (Date.now() >= nextBeat) {
      serverAction(`/student/attempt/${attemptId}/run`, F.actions.attemptHeartbeatAction, [attemptId], "heartbeat", "60s");
      nextBeat += 60_000;
    }
  }

  // 3. early finisher (held result) or deadline auto-submit (released result)
  if (!early) waitUntil(END + Math.random() * SUBMIT_JITTER_S * 1000);
  const sub = serverAction(`/student/attempt/${attemptId}/run`, F.actions.submitAttemptAction, [attemptId], "submit");
  if (!early) submitDoneAfterEnd.add(Date.now() - END);
  if (sub.ok) submitted.add(1);
  const res = get(`/student/attempt/${attemptId}/result`, "result");
  if (early) {
    if (res.status === 200 && /Result Pending/i.test(res.body || "")) held.add(1);
    else fail("result-held", res);
  }
}
