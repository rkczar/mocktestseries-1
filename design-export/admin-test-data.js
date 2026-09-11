/* MockTestSeries.in — Admin-controlled Full Mock Test list (prototype layer).
   Mirrors the intended Test/Exam tables: Admin Dashboard -> Test Management writes here,
   the Student Dashboard only ever reads the published+active subset. */
(function () {
  var KEY = "mts.admin.fullMockTests.v1";
  var EVT = "mts:admintests";

  var DEFAULTS = [
    { id: "fmt-10", name: "Full Mock Test 10", exam: "RUHS Medical Officer 2026", totalQuestions: 100, duration: 120, negativeMarking: 0.25, status: "active", published: true, instructions: "100 questions, 2 hours, printable OMR sheet.", resumable: true, progressNote: "paused at Q42" },
    { id: "fmt-11", name: "Full Mock Test 11", exam: "RUHS Medical Officer 2026", totalQuestions: 100, duration: 120, negativeMarking: 0.25, status: "active", published: true, instructions: "Fresh paper, exam-day difficulty mix.", resumable: false, progressNote: "" },
    { id: "fmt-12", name: "Full Mock Test 12", exam: "RUHS Medical Officer 2026", totalQuestions: 100, duration: 120, negativeMarking: 0.25, status: "draft", published: false, instructions: "Still being reviewed by admin.", resumable: false, progressNote: "" }
  ];

  function read() { try { var r = window.localStorage.getItem(KEY); return r ? JSON.parse(r) : DEFAULTS.slice(); } catch (e) { return DEFAULTS.slice(); } }
  function write(list) { try { window.localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {} }
  function notify() { try { window.dispatchEvent(new CustomEvent(EVT)); } catch (e) {} }

  var AdminTests = {
    defaults: function () { return DEFAULTS.slice(); },
    all: function () { return read(); },
    published: function () { return read().filter(function (t) { return t.published && t.status === "active"; }); },
    setPublished: function (id, val) { write(read().map(function (t) { return t.id === id ? Object.assign({}, t, { published: val }) : t; })); notify(); },
    setStatus: function (id, status) { write(read().map(function (t) { return t.id === id ? Object.assign({}, t, { status: status }) : t; })); notify(); },
    subscribe: function (fn) {
      window.addEventListener(EVT, fn);
      window.addEventListener("storage", fn);
      return function () { window.removeEventListener(EVT, fn); window.removeEventListener("storage", fn); };
    }
  };

  window.MTS = window.MTS || {};
  window.MTS.AdminTests = AdminTests;
})();
