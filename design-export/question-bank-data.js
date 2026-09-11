/* MockTestSeries.in — Question Bank (prototype layer, but the parsing/validation/
   storage here is REAL and runs entirely client-side): CSV parsing, per-row
   validation, exam-scoped storage, duplicate detection by question code, and a
   downloadable CSV template. No server/database exists in this environment, so
   "database" = this browser's localStorage — but every step (parse → validate →
   store → filter by exam) genuinely executes, nothing is faked. */
(function () {
  var KEY = "mts.questionBank.v1";
  var KEY_IMPORTS = "mts.questionImports.v1";
  var EVT = "mts:questionbank";

  // ExamYear is a REQUIRED per-row field: it is the actual Paper/Year mapping key (this
  // architecture has no separate Paper entity — a paperYear value IS the paper, same as the
  // Old Test Series year grouping in custom-module-data.js). It is resolved per row, not once
  // per file, so a single import file can legitimately span several years/papers.
  var REQUIRED = ["ExamYear", "Subject", "Topic", "Question", "OptionA", "OptionB", "OptionC", "OptionD", "CorrectAnswer"];
  var TEMPLATE_HEADERS = ["QuestionNumber", "QuestionCode", "ExamYear", "Subject", "Topic", "SubTopic", "Question", "OptionA", "OptionB", "OptionC", "OptionD", "CorrectAnswer", "Explanation", "Source", "Difficulty", "Status"];
  var EXAMPLE_VALUES = { QuestionNumber: "1", QuestionCode: "", ExamYear: "2024", Subject: "Anatomy", Topic: "Upper Limb", SubTopic: "Brachial Plexus", Question: "Which nerve is injured in a Saturday night palsy?", OptionA: "Median", OptionB: "Radial", OptionC: "Ulnar", OptionD: "Axillary", CorrectAnswer: "B", Explanation: "Radial nerve compressed in the spiral groove.", Source: "Custom", Difficulty: "Easy", Status: "Published" };
  var KEY_TEMPLATE_CFG = "mts.questionBank.templateCols.v1";

  function readTemplateCols() {
    try { var saved = JSON.parse(localStorage.getItem(KEY_TEMPLATE_CFG) || "null"); if (saved && saved.length) return saved.filter(function (c) { return TEMPLATE_HEADERS.indexOf(c) > -1 || REQUIRED.indexOf(c) === -1; }); } catch (e) {}
    return TEMPLATE_HEADERS.slice();
  }
  function isValidYear(y) { return /^\d{4}$/.test(y) && +y >= 1990 && +y <= 2035; }

  var SEED = [
    { id: "q1", code: "RUHS-MO-2024-Q0014", examId: "ruhs-mo", examName: "RUHS Medical Officer 2026", subject: "Pharmacology", topic: "CNS Drugs", subtopic: "Anticonvulsants", question: "Drug of choice for status epilepticus?", optionA: "Phenytoin", optionB: "Lorazepam", optionC: "Valproate", optionD: "Levetiracetam", correctAnswer: "B", explanation: "Benzodiazepines are first-line for acute status epilepticus.", source: "PYQ 2024", difficulty: "Moderate", status: "Published", createdBy: "Master Admin", createdAt: "2026-08-10" },
    { id: "q2", code: "RUHS-MO-2024-Q0201", examId: "ruhs-mo", examName: "RUHS Medical Officer 2026", subject: "Anatomy", topic: "Upper Limb", subtopic: "Brachial Plexus", question: "Which nerve is most commonly injured in a mid-shaft humerus fracture?", optionA: "Axillary", optionB: "Radial", optionC: "Median", optionD: "Ulnar", correctAnswer: "B", explanation: "The radial nerve runs in the spiral groove of the humerus.", source: "PYQ 2024", difficulty: "Easy", status: "Published", createdBy: "Master Admin", createdAt: "2026-08-10" }
  ];

  function read(key, fallback) { try { var r = window.localStorage.getItem(key); return r ? JSON.parse(r) : fallback; } catch (e) { return fallback; } }
  function write(key, val) { try { window.localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function notify() { try { window.dispatchEvent(new CustomEvent(EVT)); } catch (e) {} }

  var HEADER_ALIASES = {
    questionnumber: "QuestionNumber", "questionno": "QuestionNumber", "qno": "QuestionNumber", "q.no": "QuestionNumber", "q no": "QuestionNumber", "sno": "QuestionNumber", "s.no": "QuestionNumber",
    questioncode: "QuestionCode", "qcode": "QuestionCode", "code": "QuestionCode",
    subject: "Subject", topic: "Topic", subtopic: "SubTopic", "sub-topic": "SubTopic", "sub topic": "SubTopic",
    question: "Question", questiontext: "Question",
    optiona: "OptionA", "option a": "OptionA", "opt a": "OptionA", a: "OptionA",
    optionb: "OptionB", "option b": "OptionB", "opt b": "OptionB", b: "OptionB",
    optionc: "OptionC", "option c": "OptionC", "opt c": "OptionC", c: "OptionC",
    optiond: "OptionD", "option d": "OptionD", "opt d": "OptionD", d: "OptionD",
    correctanswer: "CorrectAnswer", "correct answer": "CorrectAnswer", answer: "CorrectAnswer", correctoption: "CorrectAnswer",
    explanation: "Explanation", source: "Source", difficulty: "Difficulty", status: "Status"
  };
  function normalizeHeader(h) {
    var key = String(h || "").trim().toLowerCase().replace(/[_]/g, " ").replace(/\s+/g, " ");
    return HEADER_ALIASES[key] || HEADER_ALIASES[key.replace(/\s/g, "")] || String(h || "").trim();
  }

  function rowsFromMatrix(matrix) {
    matrix = (matrix || []).filter(function (r) { return r && r.some(function (c) { return String(c || "").trim() !== ""; }); });
    if (!matrix.length) return [];
    var headers = matrix[0].map(normalizeHeader);
    return matrix.slice(1).map(function (r) {
      var obj = {};
      headers.forEach(function (h, idx) { obj[h] = String(r[idx] == null ? "" : r[idx]).trim(); });
      return obj;
    });
  }

  // Minimal RFC4180-ish CSV parser: handles quoted fields with embedded commas/quotes.
  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    text = text.replace(/\r\n/g, "\n");
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { row.push(field); field = ""; }
        else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ""; }
        else field += ch;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rowsFromMatrix(rows);
  }

  // Parses an .xls/.xlsx ArrayBuffer via the SheetJS library (loaded in the page's
  // helmet). Picks a worksheet named like "Questions" if present, else the first one.
  function parseWorkbook(arrayBuffer) {
    if (!window.XLSX) throw new Error("Excel parser (SheetJS) not loaded yet — try again in a moment.");
    var wb = window.XLSX.read(arrayBuffer, { type: "array" });
    var sheetName = wb.SheetNames.find(function (n) { return /question/i.test(n); }) || wb.SheetNames[0];
    var ws = wb.Sheets[sheetName];
    var matrix = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
    return { rows: rowsFromMatrix(matrix), sheetName, allSheets: wb.SheetNames };
  }

  function shortCode(examName) {
    return (examName || "EXAM").split(/\s+/).map(function (w) { return w[0]; }).join("").toUpperCase().slice(0, 6) || "EXAM";
  }

  var QuestionBank = {
    parseCSV: parseCSV,
    parseWorkbook: parseWorkbook,
    getAll: function () { return read(KEY, SEED); },
    delete: function (id) {
      var list = this.getAll().filter(function (q) { return q.id !== id; });
      write(KEY, list); notify();
    },
    bulkDelete: function (ids) {
      var idSet = {}; ids.forEach(function (i) { idSet[i] = true; });
      var list = this.getAll().filter(function (q) { return !idSet[q.id]; });
      write(KEY, list); notify();
      return ids.length;
    },
    update: function (id, patch) {
      var list = this.getAll().map(function (q) { return q.id === id ? Object.assign({}, q, patch) : q; });
      write(KEY, list); notify();
    },
    publish: function (id) { this.update(id, { status: "Published" }); },
    bulkPublish: function (ids) {
      var idSet = {}; ids.forEach(function (i) { idSet[i] = true; });
      var list = this.getAll().map(function (q) { return idSet[q.id] ? Object.assign({}, q, { status: "Published" }) : q; });
      write(KEY, list); notify();
      return ids.length;
    },
    duplicate: function (id) {
      var list = this.getAll();
      var src = list.find(function (q) { return q.id === id; });
      if (!src) return null;
      var sameYear = list.filter(function (q) { return q.examId === src.examId && String(q.paperYear) === String(src.paperYear); });
      var nextNum = Math.max(0, ...sameYear.map(function (q) { return q.questionNumber || 0; })) + 1;
      var prefix = (src.code || "").split("-").slice(0, -1).join("-") || "Q";
      var copy = Object.assign({}, src, {
        id: "q-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        questionNumber: nextNum,
        code: prefix + "-" + String(nextNum).padStart(4, "0"),
        createdAt: new Date().toISOString().slice(0, 10)
      });
      write(KEY, list.concat([copy]));
      notify();
      return copy;
    },
    fileHash: function (rows) {
      var s = JSON.stringify(rows.slice(0, 3)) + "|" + rows.length + "|" + JSON.stringify(rows[rows.length - 1] || {});
      var h = 0;
      for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
      return "H" + Math.abs(h);
    },
    checkAlreadyImported: function (examId, paperYear, hash) {
      return this.getImportHistory().find(function (h) { return h.examId === examId && String(h.paperYear) === String(paperYear) && h.fileHash === hash; }) || null;
    },
    getByExam: function (examId) { return this.getAll().filter(function (q) { return q.examId === examId; }); },
    getSubjects: function (examId) {
      var seen = {};
      this.getByExam(examId).forEach(function (q) { seen[q.subject] = (seen[q.subject] || 0) + 1; });
      return Object.keys(seen).map(function (s) { return { subject: s, count: seen[s] }; });
    },
    getTopics: function (examId, subject) {
      var seen = {};
      this.getByExam(examId).filter(function (q) { return q.subject === subject; }).forEach(function (q) { seen[q.topic] = (seen[q.topic] || 0) + 1; });
      return Object.keys(seen).map(function (t) { return { topic: t, count: seen[t] }; });
    },

    // Template columns are admin-configurable and persisted (KEY_TEMPLATE_CFG). CSV and
    // XLSX are generated from the exact same enabled/ordered column list, so they can never
    // drift out of sync with each other or with what the Template Columns panel shows.
    getTemplateColumns: function () { return readTemplateCols(); },
    getAllTemplateHeaders: function () { return TEMPLATE_HEADERS.slice(); },
    getRequiredHeaders: function () { return REQUIRED.slice(); },
    saveTemplateColumns: function (cols) {
      var ordered = TEMPLATE_HEADERS.filter(function (h) { return cols.indexOf(h) > -1; });
      REQUIRED.forEach(function (r) { if (ordered.indexOf(r) === -1) ordered.push(r); }); // required cols can never be excluded
      localStorage.setItem(KEY_TEMPLATE_CFG, JSON.stringify(ordered));
      notify();
      return ordered;
    },
    downloadTemplate: function (format) {
      var cols = readTemplateCols();
      var example = cols.map(function (h) { return EXAMPLE_VALUES[h] || ""; });
      if (format === "xlsx" && window.XLSX) {
        var ws = window.XLSX.utils.aoa_to_sheet([cols, example]);
        var wb = window.XLSX.utils.book_new();
        window.XLSX.utils.book_append_sheet(wb, ws, "Questions");
        window.XLSX.writeFile(wb, "question-import-template.xlsx");
        return;
      }
      var csv = cols.join(",") + "\n" + example.map(function (v) { return v.indexOf(",") > -1 ? '"' + v + '"' : v; }).join(",") + "\n";
      var blob = new Blob([csv], { type: "text/csv" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = "question-import-template." + format;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    },

    // Validates rows against REQUIRED fields, correct-answer domain, per-row Exam Year, and
    // duplicate identity — Exam + resolved Exam Year + Question Number (or explicit Question
    // Code) must be unique, both within the file and against what's already stored. A row's
    // ExamYear column is the real, authoritative paper mapping (falls back to the file-level
    // paperYear picker only for old templates that predate this column — never silently to
    // "no year"). Also detects duplicate rows repeated within the same uploaded file.
    validate: function (rows, examId, paperYear) {
      var byYear = {}; // existingCodes/Nums cached per resolved year, since one file may span years
      var self = this;
      function existingFor(year) {
        if (byYear[year]) return byYear[year];
        var existing = self.getByExam(examId).filter(function (q) { return String(q.paperYear) === String(year); });
        var nums = {}, codes = {};
        existing.forEach(function (q) { if (q.questionNumber) nums[q.questionNumber] = q.id; codes[q.code] = q.id; });
        return (byYear[year] = { nums, codes });
      }
      var seenNumsInFile = {}, seenCodesInFile = {};
      var valid = [], invalid = [], duplicates = [];

      rows.forEach(function (row, i) {
        var rowNum = i + 2; // header is row 1
        var missing = REQUIRED.filter(function (f) { return f !== "ExamYear" && (!row[f] || !row[f].trim()); });
        if (missing.length) { invalid.push({ rowNum, reason: "Missing required field(s): " + missing.join(", "), row }); return; }

        var yearRaw = (row.ExamYear || "").trim() || String(paperYear || "").trim();
        if (!yearRaw) { invalid.push({ rowNum, reason: "Exam Year is required.", row }); return; }
        if (!isValidYear(yearRaw)) { invalid.push({ rowNum, reason: "Invalid Exam Year: \"" + yearRaw + "\" (must be a 4-digit year between 1990 and 2035).", row }); return; }
        row._paperYear = yearRaw;

        var ca = (row.CorrectAnswer || "").trim().toUpperCase();
        if (["A", "B", "C", "D"].indexOf(ca) === -1) { invalid.push({ rowNum, reason: "Invalid Correct Answer: \"" + row.CorrectAnswer + "\" (must be A, B, C or D)", row }); return; }

        var yearKey = yearRaw;
        var scope = existingFor(yearKey);
        var code = (row.QuestionCode || "").trim();
        if (code) {
          if (scope.codes[code]) { duplicates.push({ rowNum, reason: "Duplicate Question Code: " + code + " (Exam Year " + yearKey + ")", row, existingId: scope.codes[code] }); return; }
          if (seenCodesInFile[yearKey + "|" + code]) { duplicates.push({ rowNum, reason: "Duplicate Question Code repeated within this file: " + code, row }); return; }
          seenCodesInFile[yearKey + "|" + code] = true;
        }

        var qnRaw = (row.QuestionNumber || "").trim();
        if (qnRaw) {
          if (!/^\d+$/.test(qnRaw)) { invalid.push({ rowNum, reason: "Question Number \"" + qnRaw + "\" is not numeric", row }); return; }
          var qn = String(parseInt(qnRaw, 10));
          if (scope.nums[qn]) { duplicates.push({ rowNum, reason: "Duplicate Question Number " + qn + " for this Exam + Exam Year " + yearKey, row, existingId: scope.nums[qn] }); return; }
          if (seenNumsInFile[yearKey + "|" + qn]) { duplicates.push({ rowNum, reason: "Question Number " + qn + " repeated within this file for Exam Year " + yearKey, row }); return; }
          seenNumsInFile[yearKey + "|" + qn] = true;
          row._questionNumber = qn;
        }

        valid.push(row);
      });

      return { total: rows.length, valid, invalid, duplicates };
    },

    // paperYear is now only the LEGACY fallback for files without a per-row ExamYear column
    // (validate() already resolved that onto row._paperYear for every row) — numbering, codes
    // and stored records all key off each row's own resolved year, so one file can span years.
    import: function (validRows, examId, examName, adminName, paperYear, shortCodeOverride, duplicateRows, duplicatePolicy, fileName, fileHashVal) {
      var list = this.getAll();
      var prefix = (shortCodeOverride || shortCode(examName)).toUpperCase();
      var seqByYear = {}, usedNumsByYear = {};
      function ensureYear(y) {
        if (usedNumsByYear[y]) return;
        var existingForYear = list.filter(function (q) { return q.examId === examId && String(q.paperYear) === String(y); });
        var used = {}; existingForYear.forEach(function (q) { if (q.questionNumber) used[q.questionNumber] = true; });
        usedNumsByYear[y] = used;
        seqByYear[y] = existingForYear.length + 1;
      }
      function nextAvailable(y) {
        ensureYear(y);
        while (usedNumsByYear[y][String(seqByYear[y])]) seqByYear[y]++;
        usedNumsByYear[y][String(seqByYear[y])] = true;
        return seqByYear[y]++;
      }

      function buildRecord(row, qNum, code, year) {
        return {
          id: "q-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
          code, examId, examName, paperYear: year, questionNumber: qNum,
          subject: row.Subject.trim(), topic: row.Topic.trim(), subtopic: (row.SubTopic || "").trim(),
          question: row.Question.trim(), optionA: row.OptionA.trim(), optionB: row.OptionB.trim(), optionC: row.OptionC.trim(), optionD: row.OptionD.trim(),
          correctAnswer: row.CorrectAnswer.trim().toUpperCase(), explanation: (row.Explanation || "").trim(),
          source: (row.Source || "Bulk Import").trim(), difficulty: (row.Difficulty || "Moderate").trim(),
          status: (row.Status || "Published").trim(), createdBy: adminName || "Master Admin", createdAt: new Date().toISOString().slice(0, 10)
        };
      }

      var yearsUsed = {};
      var imported = validRows.map(function (row) {
        var year = row._paperYear || paperYear || new Date().getFullYear();
        yearsUsed[year] = true;
        var qNum = row._questionNumber ? parseInt(row._questionNumber, 10) : nextAvailable(year);
        ensureYear(year); usedNumsByYear[year][String(qNum)] = true;
        var code = (row.QuestionCode || "").trim() || (prefix + "-" + year + "-" + String(qNum).padStart(4, "0"));
        return buildRecord(row, qNum, code, year);
      });

      var replacedCount = 0, addedAnywayCount = 0;
      var byId = {}; list.forEach(function (q) { byId[q.id] = q; });
      if (duplicatePolicy === "replace" && duplicateRows && duplicateRows.length) {
        duplicateRows.forEach(function (d) {
          if (!d.existingId || !byId[d.existingId]) return;
          var old = byId[d.existingId];
          var year = d.row._paperYear || old.paperYear;
          yearsUsed[year] = true;
          var qNum = d.row._questionNumber ? parseInt(d.row._questionNumber, 10) : old.questionNumber;
          var rec = buildRecord(d.row, qNum, old.code, year); // keep the existing stable code
          rec.id = old.id; // same identity — historical references stay valid
          byId[d.existingId] = rec;
          replacedCount++;
        });
        list = Object.keys(byId).map(function (k) { return byId[k]; });
      } else if (duplicatePolicy === "addAnyway" && duplicateRows && duplicateRows.length) {
        duplicateRows.forEach(function (d) {
          var year = d.row._paperYear || paperYear || new Date().getFullYear();
          yearsUsed[year] = true;
          var qNum = d.row._questionNumber ? parseInt(d.row._questionNumber, 10) : nextAvailable(year);
          var code = prefix + "-" + year + "-" + String(qNum).padStart(4, "0") + "-DUP" + (addedAnywayCount + 1);
          imported.push(buildRecord(d.row, qNum, code, year));
          addedAnywayCount++;
        });
      }

      var next = list.concat(imported);
      write(KEY, next);

      var imports = read(KEY_IMPORTS, []);
      var yearsList = Object.keys(yearsUsed);
      imports.unshift({ id: "IMP-" + Date.now(), examId, examName, paperYear: yearsList.length === 1 ? yearsList[0] : yearsList.join("+"), count: imported.length, replaced: replacedCount, addedAnyway: addedAnywayCount, admin: adminName || "Master Admin", at: new Date().toISOString(), fileName: fileName || "", fileHash: fileHashVal || "" });
      write(KEY_IMPORTS, imports.slice(0, 50));
      notify();
      return { imported, replacedCount, addedAnywayCount };
    },
    getImportHistory: function () { return read(KEY_IMPORTS, []); },
    subscribe: function (fn) {
      window.addEventListener(EVT, fn);
      window.addEventListener("storage", fn);
      return function () { window.removeEventListener(EVT, fn); window.removeEventListener("storage", fn); };
    }
  };

  window.MTS = window.MTS || {};
  window.MTS.QuestionBank = QuestionBank;
})();
