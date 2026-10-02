// k6 scenarios for MockTestSeries.in, run ONLY against an isolated instance
// on a disposable "loadtest" database (see ops/load-test/README.md).
//
//   k6 run -e BASE=http://127.0.0.1:3100 -e FIXTURE=/path/fixture.json \
//          -e SCENARIO=save -e RATE=10 -e DURATION=30s ops/load-test/k6/scenarios.js
//
// SCENARIO: browse | runpage | save | heartbeat | start | submit | result | mixed
// RATE: requests (iterations) per second, open model (constant arrival rate).
import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import { Trend, Counter } from "k6/metrics";

const BASE = __ENV.BASE || "http://127.0.0.1:3100";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw new Error("load tests only target a local isolated instance");
const F = JSON.parse(open(__ENV.FIXTURE));
const SCENARIO = __ENV.SCENARIO || "browse";
const RATE = Number(__ENV.RATE || 5);
const DURATION = __ENV.DURATION || "30s";

const lat = {
  page: new Trend("lat_page", true),
  save: new Trend("lat_save", true),
  heartbeat: new Trend("lat_heartbeat", true),
  start: new Trend("lat_start", true),
  submit: new Trend("lat_submit", true),
};
const appErrors = new Counter("app_errors");

export const options = {
  discardResponseBodies: false,
  scenarios: {
    main: { executor: "constant-arrival-rate", rate: RATE, timeUnit: "1s", duration: DURATION, preAllocatedVUs: Math.max(10, RATE * 3), maxVUs: Math.max(50, RATE * 20) },
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
};

const cookie = (token) => ({ Cookie: `student-session-token=${token}` });
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function action(path, id, args, token, trend) {
  const r = http.post(`${BASE}${path}`, JSON.stringify(args), {
    headers: { ...cookie(token), "Next-Action": id, Accept: "text/x-component", "Content-Type": "text/plain;charset=UTF-8", Origin: BASE },
    redirects: 0,
    tags: { name: trend },
  });
  lat[trend].add(r.timings.duration);
  // Engine actions answer {"ok":false,"code":...} on refusal; redirects (303) are normal for start/submit.
  const ok = (r.status === 200 && !/"ok":false/.test(r.body || "")) || r.status === 303;
  if (!ok) appErrors.add(1, { op: trend, status: String(r.status) });
  check(r, { [`${trend} ok`]: () => ok });
  return r;
}

function page(path, token) {
  const r = http.get(`${BASE}${path}`, { headers: cookie(token), redirects: 0, tags: { name: path.replace(/c[a-z0-9]{24}/g, ":id") } });
  lat.page.add(r.timings.duration);
  const ok = r.status === 200;
  if (!ok) appErrors.add(1, { op: "page", status: String(r.status) });
  check(r, { "page 200": () => ok });
}

let seq = Date.now() % 1e9;
const ops = {
  browse() {
    const s = pick(F.students);
    page(pick(["/student/dashboard", "/student/test-series", `/student/test-series/${pick(F.mocks)}`, "/student/exams"]), s.token);
  },
  runpage() {
    const a = pick(F.inProgress);
    page(`/student/attempt/${a.attemptId}/run`, a.token);
  },
  save() {
    const a = pick(F.inProgress);
    const q = pick(F.questionIdsByMock[a.mockTestId]);
    action(`/student/attempt/${a.attemptId}/run`, F.actions.saveAnswerAction, [a.attemptId, q, pick(["A", "B", "C", "D"]), Math.random() < 0.1, ++seq], a.token, "save");
  },
  heartbeat() {
    const a = pick(F.inProgress);
    action(`/student/attempt/${a.attemptId}/run`, F.actions.attemptHeartbeatAction, [a.attemptId], a.token, "heartbeat");
  },
  start() {
    // Each iteration starts a fresh attempt for a distinct student (no double-start).
    const s = F.students[exec.scenario.iterationInTest % F.students.length];
    action(`/student/test-series/${F.mocks[0]}`, F.actions.startMockTestFromDetailsAction, [F.mocks[0]], s.token, "start");
  },
  submit() {
    const a = F.inProgress[exec.scenario.iterationInTest % F.inProgress.length];
    action(`/student/attempt/${a.attemptId}/run`, F.actions.submitAttemptAction, [a.attemptId], a.token, "submit");
  },
  result() {
    const a = pick(F.submitted);
    page(`/student/attempt/${a.attemptId}/${Math.random() < 0.5 ? "result" : "review"}`, a.token);
  },
  // Live-exam mix per active student-minute (see report): mostly saves + heartbeats.
  mixed() {
    const r = Math.random();
    if (r < 0.7) ops.save();
    else if (r < 0.8) ops.heartbeat();
    else if (r < 0.9) ops.browse();
    else if (r < 0.97) ops.runpage();
    else ops.result();
  },
};

export default function () {
  ops[SCENARIO]();
}
