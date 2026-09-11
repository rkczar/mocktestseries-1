/* MockTestSeries.in — exam pricing + upcoming exams (single source of truth, prototype layer).
   Mirrors the intended Exam/UpcomingExam tables: Admin Panel writes here, every
   frontend section (homepage, header/footer, dashboard, upcoming-exams page) reads
   the same store instead of keeping its own copy. */
(function () {
  var KEY_CURRENT = "mts.exams.current.v1";
  var KEY_UPCOMING = "mts.exams.upcoming.v1";
  var EVT = "mts:examsdata";

  var CURRENT_DEFAULTS = [
    { id: "ruhs-mo", name: "RUHS Medical Officer 2026", price: 499, route: "RUHS-Medical-Officer.dc.html", shortCode: "RUHS" }
  ];

  var UPCOMING_DEFAULTS = [
    { id: "ruhs-nursing", name: "RUHS Nursing Officer 2026", expectedDate: "2026-11-15", description: "Full mock test series with AI explanations, launching alongside the official notification.", status: "enabled", price: 0, order: 1, detailRoute: "" },
    { id: "neet-pg", name: "NEET PG 2026", expectedDate: "2027-01-10", description: "Subject-wise and full-length mocks mapped to the latest exam pattern.", status: "enabled", price: 0, order: 2, detailRoute: "" },
    { id: "aiims-pg", name: "AIIMS PG 2026", expectedDate: "2027-02-20", description: "Previous year papers and AI-explained practice sets in preparation.", status: "disabled", price: 0, order: 3, detailRoute: "" }
  ];

  function read(key, fallback) { try { var r = window.localStorage.getItem(key); return r ? JSON.parse(r) : fallback; } catch (e) { return fallback; } }
  function write(key, val) { try { window.localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function notify() { try { window.dispatchEvent(new CustomEvent(EVT)); } catch (e) {} }

  var ExamsData = {
    getCurrentExams: function () { return read(KEY_CURRENT, CURRENT_DEFAULTS); },
    getCurrentExam: function (id) { return this.getCurrentExams().find(function (e) { return e.id === id; }) || null; },
    setCurrentPrice: function (id, price) {
      var list = this.getCurrentExams().map(function (e) { return e.id === id ? Object.assign({}, e, { price: price }) : e; });
      write(KEY_CURRENT, list);
      notify();
    },
    setShortCode: function (id, shortCode) {
      var clean = (shortCode || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);
      var list = this.getCurrentExams().map(function (e) { return e.id === id ? Object.assign({}, e, { shortCode: clean }) : e; });
      write(KEY_CURRENT, list);
      notify();
    },

    getUpcoming: function () { return read(KEY_UPCOMING, UPCOMING_DEFAULTS).slice().sort(function (a, b) { return a.order - b.order; }); },
    getVisibleUpcoming: function () { return this.getUpcoming().filter(function (e) { return e.status === "enabled"; }); },

    addUpcoming: function (exam) {
      var list = this.getUpcoming();
      var rec = Object.assign({ id: "up-" + Date.now(), status: "enabled", price: 0, order: list.length + 1, detailRoute: "" }, exam);
      list.push(rec);
      write(KEY_UPCOMING, list);
      notify();
      return rec;
    },
    updateUpcoming: function (id, fields) {
      var list = this.getUpcoming().map(function (e) { return e.id === id ? Object.assign({}, e, fields) : e; });
      write(KEY_UPCOMING, list);
      notify();
    },
    setUpcomingStatus: function (id, status) { this.updateUpcoming(id, { status: status }); },
    archiveUpcoming: function (id) { this.updateUpcoming(id, { status: "archived" }); },
    reorderUpcoming: function (id, delta) {
      var list = this.getUpcoming();
      var i = list.findIndex(function (e) { return e.id === id; });
      var j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return;
      var tmp = list[i].order; list[i].order = list[j].order; list[j].order = tmp;
      write(KEY_UPCOMING, list);
      notify();
    },

    subscribe: function (fn) {
      window.addEventListener(EVT, fn);
      window.addEventListener("storage", fn);
      return function () { window.removeEventListener(EVT, fn); window.removeEventListener("storage", fn); };
    }
  };

  window.MTS = window.MTS || {};
  window.MTS.ExamsData = ExamsData;
})();
