/* MockTestSeries.in — Cache Manager + Backup & Restore (prototype layer).
   No server exists in this environment: "clearing cache" here clears this
   app's own localStorage-mock caches (safe, non-destructive to exam/question/
   student data, which live under separate keys and are never touched), and
   "backup" produces a metadata record + a real downloadable JSON snapshot of
   the mock data stores — not a database engine snapshot. Clearly a stand-in
   for the real server-side jobs a production deployment would run. */
(function () {
  var KEY_CACHE = "mts.systemCache.v1";
  var KEY_BACKUPS = "mts.backups.v1";
  var KEY_LOG = "mts.systemLogs.v1";
  var EVT = "mts:systemops";

  // Keys that are safe to clear: app-shell/derived caches only.
  var SAFE_CACHE_KEYS = ["mts.themeMode", "mts.frontendAppearance.v1"];
  // Never touched by any clear operation:
  var PROTECTED_PREFIXES = ["mts.studentProfile", "mts.customModules", "mts.customModuleAttempts",
    "mts.admin", "mts.exams", "mts.messages", "mts.pagesRegistry", "mts.siteConfig", "mts.apiConfig"];

  function read(key, fallback) { try { var r = window.localStorage.getItem(key); return r ? JSON.parse(r) : fallback; } catch (e) { return fallback; } }
  function write(key, val) { try { window.localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function notify() { try { window.dispatchEvent(new CustomEvent(EVT)); } catch (e) {} }

  function addLog(action, status, detail) {
    var log = read(KEY_LOG, []);
    log.unshift({ id: "log-" + Date.now(), action, status, detail: detail || "", admin: "Master Admin", timestamp: new Date().toISOString() });
    write(KEY_LOG, log.slice(0, 100));
  }

  var CacheOps = {
    getStatus: function () { return read(KEY_CACHE, { lastClearType: null, lastClearAt: null }); },
    clear: function (type) {
      // Only ever removes the explicit safe cache keys above — application/exam/student data is untouched.
      SAFE_CACHE_KEYS.forEach(function (k) { try { if (type === "hard") window.localStorage.removeItem(k); } catch (e) {} });
      var status = { lastClearType: type, lastClearAt: new Date().toISOString() };
      write(KEY_CACHE, status);
      addLog(type === "hard" ? "Hard Cache Clear" : "Clear Application Cache", "Success");
      notify();
      return status;
    },
    getLogs: function () { return read(KEY_LOG, []); }
  };

  var BACKUP_SOURCES = {
    database: ["mts.exams.current.v1", "mts.exams.upcoming.v1", "mts.customModules.v1", "mts.messages", "mts.siteConfig.published.v3"],
    complete: ["mts.exams.current.v1", "mts.exams.upcoming.v1", "mts.customModules.v1", "mts.messages", "mts.siteConfig.published.v3",
      "mts.pagesRegistry.v1", "mts.apiConfig.v1", "mts.frontendAppearance.v1", "mts.themeMode"]
  };

  var BackupOps = {
    getHistory: function () { return read(KEY_BACKUPS, []); },
    create: function (type) {
      var id = "BK-" + Date.now();
      var list = this.getHistory();
      var rec = { id, type, createdAt: new Date().toISOString(), createdBy: "Master Admin", status: "In Progress", size: null };
      list.unshift(rec);
      write(KEY_BACKUPS, list);
      notify();
      // Simulate the async job; snapshot the mock data stores into the record itself.
      var self = this;
      setTimeout(function () {
        try {
          var keys = BACKUP_SOURCES[type] || [];
          var snapshot = {};
          keys.forEach(function (k) { var v = window.localStorage.getItem(k); if (v != null) snapshot[k] = v; });
          var payload = JSON.stringify(snapshot);
          var list2 = self.getHistory().map(function (b) {
            return b.id === id ? Object.assign({}, b, { status: "Completed", size: payload.length + " bytes", snapshot: payload }) : b;
          });
          write(KEY_BACKUPS, list2);
          addLog(type === "database" ? "Create Database Backup" : "Create Complete Site Backup", "Success", id);
        } catch (e) {
          var list3 = self.getHistory().map(function (b) { return b.id === id ? Object.assign({}, b, { status: "Failed" }) : b; });
          write(KEY_BACKUPS, list3);
          addLog(type === "database" ? "Create Database Backup" : "Create Complete Site Backup", "Failed", String(e));
        }
        notify();
      }, 900);
      return rec;
    },
    restore: function (id) {
      var list = this.getHistory();
      var rec = list.find(function (b) { return b.id === id; });
      if (!rec || rec.status !== "Completed" || !rec.snapshot) {
        addLog("Restore Backup", "Failed", "Backup not available or incomplete: " + id);
        notify();
        return false;
      }
      try {
        var snapshot = JSON.parse(rec.snapshot);
        Object.keys(snapshot).forEach(function (k) { window.localStorage.setItem(k, snapshot[k]); });
        addLog("Restore Backup", "Success", id);
        notify();
        return true;
      } catch (e) {
        addLog("Restore Backup", "Failed", String(e));
        notify();
        return false;
      }
    },
    getLogs: function () { return read(KEY_LOG, []); }
  };

  var SystemOps = {
    subscribe: function (fn) {
      window.addEventListener(EVT, fn);
      window.addEventListener("storage", fn);
      return function () { window.removeEventListener(EVT, fn); window.removeEventListener("storage", fn); };
    },
    getLogs: function () { return read(KEY_LOG, []); }
  };

  window.MTS = window.MTS || {};
  window.MTS.CacheOps = CacheOps;
  window.MTS.BackupOps = BackupOps;
  window.MTS.SystemOps = SystemOps;
})();
