/* MockTestSeries.in — single-source student profile & statistics store (prototype layer).
   Mirrors the intended production shape: one StudentProfile row + a Statistics
   aggregate, updated only by real activity (question attempts, test completions).
   Mockup persistence: localStorage. Production: Postgres/Prisma, updated in a
   transaction when a test is submitted (see design_handoff.../prisma/schema.prisma). */
(function () {
  var KEY = "mts.studentProfile.v1";
  var EVT = "mts:studentprofile";

  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

  var DEFAULTS = {
    id: "student_001",
    basicDetails: {
      name: "Dr. Student",
      initials: "DS",
      candidateId: "MTS-2026-00184",
      email: "student@example.com",
      phone: "+91 98xxxxxx21",
      profilePhoto: "",
      createdAt: "2026-06-12T00:00:00.000Z",
      lastLoginAt: "2026-09-08T19:12:00.000Z",
      accountStatus: "active"
    },
    statistics: {
      questionsAttemptedTotal: 2148,
      questionsAttemptedToday: 86,
      testsCompletedTotal: 23,
      testsCompletedToday: 2,
      studyStreak: 18,
      longestStudyStreak: 31,
      lastStudyDate: todayStr(),
      lastTestDate: todayStr(),
      totalCorrect: 1460,
      totalIncorrect: 620,
      totalSkipped: 68,
      totalTimeSpentSeconds: 187200,
      averageScore: 68,
      accuracy: 68,
      savedQuestionsCount: 37,
      mistakeQuestionsCount: 64,
      aiQuestionsAsked: 96
    },
    testHistory: [
      { id: "seed-1", name: "Full Mock Test 10", exam: "RUHS Medical Officer 2026", date: "2026-09-08", total: 100, attempted: 93, correct: 71, incorrect: 22, skipped: 7, score: 71, accuracy: 76, timeTaken: 6480 },
      { id: "seed-2", name: "PYQ 2024", exam: "RUHS Medical Officer 2026", date: "2026-09-06", total: 100, attempted: 96, correct: 64, incorrect: 32, skipped: 4, score: 64, accuracy: 67, timeTaken: 6720 },
      { id: "seed-3", name: "Anatomy Subject Test 03", exam: "RUHS Medical Officer 2026", date: "2026-09-04", total: 40, attempted: 40, correct: 28, incorrect: 12, skipped: 0, score: 28, accuracy: 70, timeTaken: 2460 },
      { id: "seed-4", name: "Full Mock Test 09", exam: "RUHS Medical Officer 2026", date: "2026-09-01", total: 100, attempted: 95, correct: 58, incorrect: 37, skipped: 5, score: 58, accuracy: 61, timeTaken: 7140 },
      { id: "seed-5", name: "Pharmacology Practice", exam: "RUHS Medical Officer 2026", date: "2026-08-30", total: 25, attempted: 25, correct: 18, incorrect: 7, skipped: 0, score: 18, accuracy: 72, timeTaken: 1320 }
    ],
    completedTestIds: ["seed-1", "seed-2", "seed-3", "seed-4", "seed-5"],
    lastStatsDate: todayStr()
  };

  function read() {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return clone(DEFAULTS);
      var p = JSON.parse(raw);
      return p && p.statistics ? p : clone(DEFAULTS);
    } catch (e) { return clone(DEFAULTS); }
  }

  function write(p) {
    try { window.localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* private mode */ }
  }

  function notify() {
    try { window.dispatchEvent(new CustomEvent(EVT)); } catch (e) { /* noop */ }
  }

  function rollDay(p) {
    var t = todayStr();
    if (p.lastStatsDate !== t) {
      p.statistics.questionsAttemptedToday = 0;
      p.statistics.testsCompletedToday = 0;
      p.lastStatsDate = t;
    }
    return p;
  }

  function touchStudyDay(p) {
    var t = todayStr();
    var s = p.statistics;
    if (s.lastStudyDate === t) return;
    var gap = s.lastStudyDate ? daysBetween(s.lastStudyDate, t) : null;
    s.studyStreak = gap === 1 ? s.studyStreak + 1 : 1;
    if (s.studyStreak > s.longestStudyStreak) s.longestStudyStreak = s.studyStreak;
    s.lastStudyDate = t;
  }

  function recomputeAccuracy(p) {
    var s = p.statistics;
    var attempted = s.totalCorrect + s.totalIncorrect;
    s.accuracy = attempted > 0 ? Math.round((s.totalCorrect / attempted) * 100) : 0;
  }

  var StudentData = {
    defaults: function () { return clone(DEFAULTS); },

    getProfile: function () {
      var p = rollDay(read());
      write(p);
      return p;
    },

    getStatistics: function () { return this.getProfile().statistics; },
    getTestHistory: function () { return this.getProfile().testHistory.slice().sort(function (a, b) { return b.date < a.date ? -1 : 1; }); },
    getTestById: function (id) { return this.getProfile().testHistory.find(function (t) { return t.id === id; }) || null; },

    /* Question attempted outside a full test (practice mode). */
    recordQuestionAttempt: function (n) {
      n = n || 1;
      var p = this.getProfile();
      p.statistics.questionsAttemptedTotal += n;
      p.statistics.questionsAttemptedToday += n;
      touchStudyDay(p);
      write(p); notify();
      return p.statistics;
    },

    /* Idempotent: a given testId can only affect aggregates once. */
    recordTestCompletion: function (rec) {
      var p = this.getProfile();
      if (p.completedTestIds.indexOf(rec.id) !== -1) return p.statistics;
      p.completedTestIds.push(rec.id);
      p.testHistory.unshift(rec);

      var s = p.statistics;
      var attempted = rec.correct + rec.incorrect;
      s.testsCompletedTotal += 1;
      s.testsCompletedToday += 1;
      s.questionsAttemptedTotal += attempted;
      s.questionsAttemptedToday += attempted;
      s.totalCorrect += rec.correct;
      s.totalIncorrect += rec.incorrect;
      s.totalSkipped += rec.skipped;
      s.totalTimeSpentSeconds += rec.timeTaken || 0;
      s.lastTestDate = rec.date || todayStr();
      recomputeAccuracy(p);
      s.averageScore = Math.round(((s.averageScore * (s.testsCompletedTotal - 1)) + rec.score) / s.testsCompletedTotal);
      touchStudyDay(p);

      write(p); notify();
      return p.statistics;
    },

    setSavedQuestionsCount: function (n) {
      var p = this.getProfile();
      p.statistics.savedQuestionsCount = Math.max(0, n);
      write(p); notify();
      return p.statistics;
    },
    setMistakeQuestionsCount: function (n) {
      var p = this.getProfile();
      p.statistics.mistakeQuestionsCount = Math.max(0, n);
      write(p); notify();
      return p.statistics;
    },

    /* Safe rebuild of aggregates from the completed-test history — the
       recovery path if an aggregate is ever suspected inconsistent. */
    recalculateStudentStatistics: function () {
      var p = this.getProfile();
      var history = p.testHistory;
      var s = p.statistics;
      s.testsCompletedTotal = history.length;
      s.questionsAttemptedTotal = history.reduce(function (sum, t) { return sum + t.attempted; }, 0);
      s.totalCorrect = history.reduce(function (sum, t) { return sum + t.correct; }, 0);
      s.totalIncorrect = history.reduce(function (sum, t) { return sum + t.incorrect; }, 0);
      s.totalSkipped = history.reduce(function (sum, t) { return sum + t.skipped; }, 0);
      s.totalTimeSpentSeconds = history.reduce(function (sum, t) { return sum + (t.timeTaken || 0); }, 0);
      s.averageScore = history.length ? Math.round(history.reduce(function (sum, t) { return sum + t.score; }, 0) / history.length) : 0;
      recomputeAccuracy(p);
      write(p); notify();
      return s;
    },

    subscribe: function (fn) {
      window.addEventListener(EVT, fn);
      window.addEventListener("storage", fn);
      return function () {
        window.removeEventListener(EVT, fn);
        window.removeEventListener("storage", fn);
      };
    }
  };

  window.MTS = window.MTS || {};
  window.MTS.StudentData = StudentData;
})();
