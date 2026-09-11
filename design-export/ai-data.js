/* MockTestSeries.in — AI Solution cache + usage log (prototype layer).
   Mirrors the intended production shape:
     aiSolutions/{questionId}            <- cached explanation, reused by every student
     aiSolutions/{questionId}/variants   <- AI-generated alternate questions, AI01-AI05 max, linked to parent
     aiUsage/{usageId}                   <- every Ask AI interaction (content vs usage kept separate), for Admin AI stats
   Gemini itself is never called from this static prototype (no secret can live safely
   in frontend code, no server exists to hold one) — generatorFn stands in for the real
   server-side call, and the cache/log/limit/linking behaviour around it is real. */
(function () {
  var KEY_SOL = "mts.ai.solutions.v1";
  var KEY_USAGE = "mts.ai.usage.v1";
  var KEY_SETTINGS = "mts.ai.settings.v1";
  var EVT = "mts:ai";
  var MAX_VARIANTS = 5;

  var DEFAULT_SETTINGS = {
    enabled: true,
    model: "gemini-1.5-flash",
    maxVariants: MAX_VARIANTS,
    cachingEnabled: true,
    temperature: 0.4,
    maxOutputTokens: 1024,
    retryCount: 2,
    timeoutSeconds: 20,
    provider: "Gemini (prototype — no live API in this environment)",
    explanationPrompt: "Explain the correct answer and why each distractor is wrong. Exam-oriented, concise.",
    similarPrompt: "Generate up to 5 meaningful variations of this question (wording, framing, difficulty)."
  };

  function read(key, fallback) {
    try { var r = window.localStorage.getItem(key); return r ? JSON.parse(r) : fallback; }
    catch (e) { return fallback; }
  }
  function write(key, val) { try { window.localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function notify() { try { window.dispatchEvent(new CustomEvent(EVT)); } catch (e) {} }
  function normText(t) { return String(t || "").trim().toLowerCase().replace(/\s+/g, " "); }

  var AI = {
    getSettings: function () { return Object.assign({}, DEFAULT_SETTINGS, read(KEY_SETTINGS, {})); },
    updateSettings: function (patch) {
      var next = Object.assign({}, this.getSettings(), patch);
      next.maxVariants = MAX_VARIANTS; // enforced, not admin-configurable higher than spec limit
      write(KEY_SETTINGS, next);
      notify();
      return next;
    },

    // AI service health — simulated based on settings, since there is no real API to ping here.
    getHealthStatus: function () {
      var s = this.getSettings();
      if (!s.enabled) return "NOT CONFIGURED";
      var log = read(KEY_USAGE, []).slice(0, 20);
      var recentFailures = log.filter(function (l) { return l.generationStatus === "failed"; }).length;
      if (recentFailures >= 10) return "ERROR";
      if (recentFailures >= 3) return "DEGRADED";
      return "CONNECTED";
    },

    getSolution: function (questionId) { return read(KEY_SOL, {})[questionId] || null; },

    /* Check cache -> else "call Gemini" via generatorFn -> store -> return.
       generatorFn(question) returns {explanation, optionAnalysis, memoryTrick} synchronously,
       standing in for the real server-side model call. usageCtx carries studentId/name/exam/subject/topic
       so AI CONTENT (reusable) and AI USAGE (per-student log) stay separate concepts. */
    getOrGenerateSolution: function (question, generatorFn, usageCtx) {
      var settings = this.getSettings();
      var all = read(KEY_SOL, {});
      var cached = all[question.id];
      var ctx = usageCtx || {};
      if (cached && settings.cachingEnabled) {
        this.logUsage(Object.assign({ questionId: question.id, actionType: "explanation", cacheHit: true, model: settings.model, generationStatus: "success" }, ctx));
        return cached;
      }
      if (!settings.enabled) {
        this.logUsage(Object.assign({ questionId: question.id, actionType: "explanation", cacheHit: false, model: settings.model, generationStatus: "disabled" }, ctx));
        return null;
      }
      var generated;
      try { generated = generatorFn(question); }
      catch (e) {
        this.logUsage(Object.assign({ questionId: question.id, actionType: "explanation", cacheHit: false, model: settings.model, generationStatus: "failed", errorMessage: "AI service is temporarily unavailable. Please try again later." }, ctx));
        return cached || null;
      }
      var record = Object.assign({
        questionId: question.id, questionCode: question.code || question.id,
        examId: question.examId, examName: question.examName,
        subject: question.subject, topic: question.topic,
        model: settings.model, promptVersion: "v1",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        generationStatus: "success", generatedVariants: (cached && cached.generatedVariants) || []
      }, generated);
      all[question.id] = record;
      write(KEY_SOL, all);
      this.logUsage(Object.assign({ questionId: question.id, actionType: "explanation", cacheHit: false, model: settings.model, generationStatus: "success" }, ctx));
      notify();
      return record;
    },

    // Alternate/AI-generated questions, permanently linked to the parent question as AI01..AI05,
    // sequence preserved explicitly (not insertion order), max 5 enforced here (not just UI),
    // and near-duplicate variants (by normalized question text) rejected rather than saved.
    getOrGenerateVariants: function (question, generatorFn, usageCtx) {
      var settings = this.getSettings();
      var all = read(KEY_SOL, {});
      var record = all[question.id] || {
        questionId: question.id, questionCode: question.code || question.id,
        examId: question.examId, examName: question.examName, subject: question.subject, topic: question.topic,
        model: settings.model, promptVersion: "v1", createdAt: new Date().toISOString(), generationStatus: "success", generatedVariants: []
      };
      var existing = record.generatedVariants || [];
      var ctx = usageCtx || {};

      if (existing.length >= MAX_VARIANTS) {
        this.logUsage(Object.assign({ questionId: question.id, actionType: "similar_questions", cacheHit: true, model: settings.model, generationStatus: "success", note: "limit reached, returned existing" }, ctx));
        return existing;
      }
      if (!settings.enabled) return existing;

      var candidates;
      try { candidates = generatorFn(question) || []; }
      catch (e) {
        this.logUsage(Object.assign({ questionId: question.id, actionType: "similar_questions", cacheHit: false, model: settings.model, generationStatus: "failed", errorMessage: "AI service is temporarily unavailable. Please try again later." }, ctx));
        return existing;
      }

      var seenText = {}; existing.forEach(function (v) { seenText[normText(v.question)] = true; });
      var added = [];
      var nextSeq = existing.length + 1;
      candidates.forEach(function (cand) {
        if (existing.length + added.length >= MAX_VARIANTS) return; // hard cap, backend-enforced
        var key = normText(cand.question);
        if (!key || seenText[key]) return; // duplicate protection — never silently overwrite
        seenText[key] = true;
        var seq = nextSeq++;
        added.push(Object.assign({}, cand, {
          id: question.id + "-ai" + seq,
          code: (question.code || question.id) + "-AI" + String(seq).padStart(2, "0"),
          sequence: seq,
          sourceQuestionId: question.id,
          model: settings.model,
          createdAt: new Date().toISOString(),
          generationStatus: "success"
        }));
      });

      record.generatedVariants = existing.concat(added).sort(function (a, b) { return a.sequence - b.sequence; });
      record.updatedAt = new Date().toISOString();
      all[question.id] = record;
      write(KEY_SOL, all);
      this.logUsage(Object.assign({ questionId: question.id, actionType: "similar_questions", cacheHit: false, model: settings.model, generationStatus: added.length ? "success" : "failed", variantCount: added.length }, ctx));
      notify();
      return record.generatedVariants;
    },

    getVariants: function (questionId) { return (read(KEY_SOL, {})[questionId] || {}).generatedVariants || []; },

    logUsage: function (entry) {
      var log = read(KEY_USAGE, []);
      log.unshift(Object.assign({ id: "usage-" + Date.now() + "-" + Math.floor(Math.random() * 1000), timestamp: new Date().toISOString() }, entry));
      write(KEY_USAGE, log.slice(0, 1000));
      notify();
    },

    getUsageLog: function () { return read(KEY_USAGE, []); },

    // AI CONTENT vs AI USAGE stay separate: this is the shared cache; getUsageLog above is per-student activity.
    getAllSolutions: function () { return read(KEY_SOL, {}); },

    getAdminStats: function () {
      var log = read(KEY_USAGE, []);
      var solutions = read(KEY_SOL, {});
      var today = new Date().toISOString().slice(0, 10);
      var monthKey = today.slice(0, 7);
      var cachedHits = log.filter(function (l) { return l.cacheHit; }).length;
      var totalVariants = Object.keys(solutions).reduce(function (sum, k) { return sum + ((solutions[k].generatedVariants || []).length); }, 0);
      var studentsUsingAI = {}; log.forEach(function (l) { if (l.studentId) studentsUsingAI[l.studentId] = true; });
      return {
        totalRequests: log.length,
        totalResponses: log.filter(function (l) { return l.generationStatus === "success"; }).length,
        totalApiCalls: log.filter(function (l) { return !l.cacheHit && l.generationStatus !== "disabled"; }).length,
        uniqueQuestions: Object.keys(solutions).length,
        cachedSolutions: Object.keys(solutions).length,
        cachedResponses: cachedHits,
        newGenerations: log.filter(function (l) { return !l.cacheHit && l.actionType === "explanation" && l.generationStatus === "success"; }).length,
        similarQuestionGenerations: log.filter(function (l) { return l.actionType === "similar_questions"; }).length,
        totalGeneratedVariants: totalVariants,
        requestsToday: log.filter(function (l) { return l.timestamp.slice(0, 10) === today; }).length,
        requestsThisMonth: log.filter(function (l) { return l.timestamp.slice(0, 7) === monthKey; }).length,
        failedRequests: log.filter(function (l) { return l.generationStatus === "failed"; }).length,
        pendingRequests: 0,
        successfulRequests: log.filter(function (l) { return l.generationStatus === "success"; }).length,
        studentsUsingAI: Object.keys(studentsUsingAI).length,
        cacheHitRate: log.length ? Math.round((cachedHits / log.length) * 100) : 0
      };
    },

    // Per-student breakdown for Admin AI Analytics.
    getStudentStats: function () {
      var log = read(KEY_USAGE, []);
      var byStudent = {};
      log.forEach(function (l) {
        if (!l.studentId) return;
        var s = byStudent[l.studentId] || { studentId: l.studentId, studentName: l.studentName || l.studentId, totalQueries: 0, cached: 0, generated: 0, questions: {}, lastActivity: l.timestamp };
        s.totalQueries++;
        if (l.cacheHit) s.cached++; else if (l.generationStatus === "success") s.generated++;
        s.questions[l.questionId] = true;
        if (l.timestamp > s.lastActivity) s.lastActivity = l.timestamp;
        byStudent[l.studentId] = s;
      });
      return Object.keys(byStudent).map(function (k) {
        var s = byStudent[k];
        return { studentId: s.studentId, studentName: s.studentName, totalQueries: s.totalQueries, uniqueQuestions: Object.keys(s.questions).length, cached: s.cached, generated: s.generated, lastActivity: s.lastActivity };
      }).sort(function (a, b) { return b.totalQueries - a.totalQueries; });
    },

    // Per-question breakdown for Admin AI Analytics.
    getQuestionStats: function () {
      var log = read(KEY_USAGE, []);
      var solutions = read(KEY_SOL, {});
      var byQ = {};
      log.forEach(function (l) {
        var q = byQ[l.questionId] || { questionId: l.questionId, questionCode: l.questionCode || l.questionId, students: {}, apiCalls: 0, cachedViews: 0 };
        if (l.studentId) q.students[l.studentId] = true;
        if (l.cacheHit) q.cachedViews++; else q.apiCalls++;
        byQ[l.questionId] = q;
      });
      return Object.keys(byQ).map(function (k) {
        var q = byQ[k];
        var sol = solutions[k];
        return {
          questionId: q.questionId, questionCode: (sol && sol.questionCode) || q.questionCode,
          examName: sol && sol.examName, subject: sol && sol.subject,
          uniqueStudents: Object.keys(q.students).length, apiCalls: q.apiCalls, cachedViews: q.cachedViews,
          alternateQuestions: (sol && sol.generatedVariants && sol.generatedVariants.length) || 0
        };
      }).sort(function (a, b) { return (b.uniqueStudents + b.apiCalls) - (a.uniqueStudents + a.apiCalls); });
    },

    getErrorLog: function () {
      return read(KEY_USAGE, []).filter(function (l) { return l.generationStatus === "failed"; });
    },

    subscribe: function (fn) {
      window.addEventListener(EVT, fn);
      window.addEventListener("storage", fn);
      return function () { window.removeEventListener(EVT, fn); window.removeEventListener("storage", fn); };
    }
  };

  window.MTS = window.MTS || {};
  window.MTS.AI = AI;
})();
