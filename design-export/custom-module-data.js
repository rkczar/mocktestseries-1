/* MockTestSeries.in — Custom Module (prototype layer, rebuilt).
   Root cause of the "only two subjects" bug: the old version stored a hand-typed
   catalog of 3 hardcoded practice-set rows, unrelated to the Question Bank — only
   the 2 rows an admin had manually published ever showed, and Start Test opened
   Test-Player with its own unrelated hardcoded questions (module selection was
   ignored entirely).

   This version has no catalog of its own. It reads subjects/counts LIVE from
   window.MTS.QuestionBank for the selected exam every time — a new bulk-imported
   subject appears with zero code changes. Admin only controls per-subject
   AVAILABILITY (enable/disable) for Custom Module; the Question Bank itself is
   never touched or duplicated. Student picks exam + subject(s) + optional filters
   + question count; the server (here: this module) computes the eligible pool,
   caps requested-vs-available, freezes the exact question set into an attempt,
   and that attempt is what Test-Player actually loads and later submits back. */
(function () {
  var KEY_CONFIG = "mts.customModule.subjectConfig.v1";   // { [examId]: { [subject]: boolean } }
  var KEY_ATTEMPTS = "mts.customModule.attempts.v1";       // { [attemptId]: attempt }
  var KEY_PENDING = "mts.customModule.pendingAttempt";
  var EVT = "mts:custommodules";

  function read(key, fallback) { try { var r = window.localStorage.getItem(key); return r ? JSON.parse(r) : fallback; } catch (e) { return fallback; } }
  function write(key, val) { try { window.localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function notify() { try { window.dispatchEvent(new CustomEvent(EVT)); } catch (e) {} }
  function QB() { return window.MTS && window.MTS.QuestionBank; }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  var CustomModules = {
    // ---------- Admin: per-exam subject availability, sourced live from the Question Bank ----------
    getSubjectRows: function (examId) {
      var qb = QB();
      var bankSubjects = qb ? qb.getSubjects(examId) : []; // [{subject, count}] — dynamic, never hardcoded
      var cfg = (read(KEY_CONFIG, {})[examId]) || {};
      return bankSubjects.map(function (s) {
        return { subject: s.subject, count: s.count, enabled: cfg[s.subject] !== false };
      });
    },
    setSubjectEnabled: function (examId, subject, enabled) {
      var all = read(KEY_CONFIG, {});
      all[examId] = Object.assign({}, all[examId]);
      all[examId][subject] = enabled;
      write(KEY_CONFIG, all); notify();
    },

    // ---------- Student: eligible subjects/filters, always exam-scoped ----------
    getAvailableSubjects: function (examId) {
      return this.getSubjectRows(examId).filter(function (s) { return s.enabled; });
    },
    getYears: function (examId, subjects) {
      var qb = QB(); if (!qb) return [];
      var pool = qb.getByExam(examId).filter(function (q) { return !subjects || !subjects.length || subjects.indexOf(q.subject) > -1; });
      var seen = {}; pool.forEach(function (q) { if (q.paperYear) seen[q.paperYear] = true; });
      return Object.keys(seen).sort();
    },
    getTopics: function (examId, subjects) {
      var qb = QB(); if (!qb) return [];
      var pool = qb.getByExam(examId).filter(function (q) { return subjects && subjects.indexOf(q.subject) > -1; });
      var seen = {}; pool.forEach(function (q) { seen[q.topic] = (seen[q.topic] || 0) + 1; });
      return Object.keys(seen).map(function (t) { return { topic: t, count: seen[t] }; });
    },

    // Every eligibility check funnels through here — admin-disabled subjects are
    // never eligible even if a caller passes their name in `subjects`.
    getEligibleQuestions: function (examId, filters) {
      var qb = QB(); if (!qb) return [];
      filters = filters || {};
      var enabled = {};
      this.getAvailableSubjects(examId).forEach(function (s) { enabled[s.subject] = true; });
      var wantSubjects = (filters.subjects || []).filter(function (s) { return enabled[s]; });
      return qb.getByExam(examId).filter(function (q) {
        if (!enabled[q.subject]) return false;
        if (wantSubjects.length && wantSubjects.indexOf(q.subject) === -1) return false;
        if (filters.year && filters.year !== "All" && String(q.paperYear) !== String(filters.year)) return false;
        if (filters.topic && filters.topic !== "All" && q.topic !== filters.topic) return false;
        if (filters.difficulty && filters.difficulty !== "All" && q.difficulty !== filters.difficulty) return false;
        if (q.status && q.status !== "Published") return false;
        return true;
      });
    },
    countAvailable: function (examId, filters) { return this.getEligibleQuestions(examId, filters).length; },

    // ---------- Old Test Series: previous-year papers, grouped from the real Question Bank ----------
    // One paper per year (all eligible questions with that paperYear, across every enabled subject) —
    // there is no separate "paper number" field in the bulk-import schema, so a year IS the paper.
    getPapersByYear: function (examId) {
      var self = this;
      var years = this.getYears(examId, []);
      return years.map(function (y) { return { year: y, count: self.countAvailable(examId, { year: y, subjects: [] }) }; })
        .filter(function (r) { return r.count > 0; })
        .sort(function (a, b) { return String(b.year).localeCompare(String(a.year)); });
    },
    getSubjectsForYear: function (examId, year) {
      var qb = QB(); if (!qb) return [];
      var enabled = {}; this.getAvailableSubjects(examId).forEach(function (s) { enabled[s.subject] = true; });
      var seen = {};
      qb.getByExam(examId).filter(function (q) {
        return String(q.paperYear) === String(year) && enabled[q.subject] && (!q.status || q.status === "Published");
      }).forEach(function (q) { seen[q.subject] = true; });
      return Object.keys(seen);
    },

    // ---------- Attempt lifecycle (Custom Module → frozen Test Attempt → Test Engine) ----------
    createAttempt: function (opts) {
      var pool = this.getEligibleQuestions(opts.examId, { subjects: opts.subjects, year: opts.year, topic: opts.topic, difficulty: opts.difficulty });
      var shuffled = shuffle(pool.slice());
      var actual = Math.min(opts.requested, shuffled.length);
      var chosen = shuffled.slice(0, actual);
      var attempt = {
        id: "cma-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
        studentId: opts.studentId, studentName: opts.studentName,
        examId: opts.examId, examName: opts.examName,
        subjects: opts.subjects || [], year: opts.year || "All", topic: opts.topic || "All", difficulty: opts.difficulty || "All",
        requested: opts.requested, available: pool.length, actual: actual, limited: opts.requested > pool.length,
        questionIds: chosen.map(function (q) { return q.id; }),
        questions: chosen, // frozen snapshot — never regenerated once the attempt exists
        // Timed/Untimed is the student's own choice at creation time, not the exam's default
        // duration. Timed always means 1 minute per selected question — set once, frozen here.
        timed: opts.timed !== false,
        durationMinutes: opts.timed !== false ? actual : null,
        label: opts.label || null,
        status: "in_progress",
        startedAt: new Date().toISOString(), submittedAt: null, result: null, perQuestion: null
      };
      var all = read(KEY_ATTEMPTS, {});
      all[attempt.id] = attempt;
      write(KEY_ATTEMPTS, all); notify();
      return attempt;
    },
    getAttempt: function (id) { return read(KEY_ATTEMPTS, {})[id] || null; },
    submitAttempt: function (id, perQuestion) {
      var all = read(KEY_ATTEMPTS, {});
      var a = all[id];
      if (!a || a.status === "submitted") return a;
      var correct = 0, incorrect = 0, skipped = 0;
      (perQuestion || []).forEach(function (p) { if (!p.studentAnswer) skipped++; else if (p.isCorrect) correct++; else incorrect++; });
      a.status = "submitted";
      a.submittedAt = new Date().toISOString();
      a.perQuestion = perQuestion || [];
      a.result = { correct: correct, incorrect: incorrect, skipped: skipped, total: (perQuestion || []).length, scorePct: (perQuestion || []).length ? Math.round(correct / perQuestion.length * 100) : 0 };
      all[id] = a; write(KEY_ATTEMPTS, all); notify();
      return a;
    },
    setPendingAttempt: function (id) { try { window.localStorage.setItem(KEY_PENDING, id); } catch (e) {} },
    getPendingAttempt: function () { try { return window.localStorage.getItem(KEY_PENDING); } catch (e) { return null; } },
    clearPendingAttempt: function () { try { window.localStorage.removeItem(KEY_PENDING); } catch (e) {} },

    // ---------- Admin analytics — real attempts only, no fabricated numbers ----------
    getAllAttempts: function () { var a = read(KEY_ATTEMPTS, {}); return Object.keys(a).map(function (k) { return a[k]; }); },
    getExamAnalytics: function (examId) {
      var list = this.getAllAttempts().filter(function (a) { return a.examId === examId; });
      var submitted = list.filter(function (a) { return a.status === "submitted"; });
      var students = {}; list.forEach(function (a) { if (a.studentId) students[a.studentId] = true; });
      var avgScore = submitted.length ? Math.round(submitted.reduce(function (s, a) { return s + a.result.scorePct; }, 0) / submitted.length) : 0;
      var sorted = list.slice().sort(function (a, b) { return (b.submittedAt || b.startedAt) < (a.submittedAt || a.startedAt) ? -1 : 1; });
      return {
        totalAttempts: list.length, uniqueStudents: Object.keys(students).length,
        completedAttempts: submitted.length, averageScore: avgScore,
        lastAttempt: sorted[0] ? (sorted[0].submittedAt || sorted[0].startedAt) : null,
        recent: sorted.slice(0, 10)
      };
    },

    subscribe: function (fn) {
      window.addEventListener(EVT, fn);
      window.addEventListener("storage", fn);
      return function () { window.removeEventListener(EVT, fn); window.removeEventListener("storage", fn); };
    }
  };

  window.MTS = window.MTS || {};
  window.MTS.CustomModules = CustomModules;
})();
