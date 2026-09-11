/* MockTestSeries.in — API Management (PROTOTYPE-ONLY mock store).
   IMPORTANT: This is a static HTML prototype with no server. It cannot securely
   store secrets, encrypt anything, or call Google/SMS/Gemini/Razorpay. Nothing
   typed here should be a real credential — this only demos the admin UI/flow
   for a developer to later wire to a real backend (apiConfigurations table,
   server-side secret storage, actual provider calls). */
(function () {
  var KEY = "mts.admin.apiConfig.v1";
  var KEY_LOG = "mts.admin.apiLogs.v1";
  var KEY_AUDIT = "mts.admin.apiAudit.v1";
  var EVT = "mts:apiconfig";

  var DEFAULTS = {
    google: { name: "Google Sign-In", provider: "Google OAuth", enabled: false, status: "Not Configured", fields: { clientId: "", redirectUrl: "" }, hasSecret: false, lastTested: null, updatedAt: null },
    sms: { name: "Phone OTP / SMS", provider: "MSG91", enabled: false, status: "Not Configured", fields: { provider: "MSG91", widgetId: "", otpExpiry: 300 }, hasSecret: false, lastTested: null, updatedAt: null },
    gemini: { name: "Gemini AI", provider: "Google Gemini", enabled: false, status: "Not Configured", fields: { model: "gemini-1.5-flash" }, hasSecret: false, lastTested: null, updatedAt: null },
    razorpay: { name: "Razorpay Payment Gateway", provider: "Razorpay", enabled: false, status: "Not Configured", fields: { keyId: "", environment: "Test" }, hasSecret: false, lastTested: null, updatedAt: null }
  };

  function read(key, fallback) { try { var r = window.localStorage.getItem(key); return r ? JSON.parse(r) : fallback; } catch (e) { return fallback; } }
  function write(key, val) { try { window.localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function notify() { try { window.dispatchEvent(new CustomEvent(EVT)); } catch (e) {} }

  var API = {
    defaults: function () { return JSON.parse(JSON.stringify(DEFAULTS)); },
    getAll: function () { return read(KEY, this.defaults()); },

    /* fields never include secrets — a "hasSecret" flag stands in for "Configured ✓".
       Blank secret input on save means "keep existing", matching the real-world rule. */
    saveConfig: function (id, fields, secretProvided, adminName) {
      var all = this.getAll();
      var before = JSON.parse(JSON.stringify(all[id]));
      all[id].fields = Object.assign({}, all[id].fields, fields);
      if (secretProvided) all[id].hasSecret = true;
      all[id].status = all[id].hasSecret ? (all[id].enabled ? "Connected" : "Disabled") : "Not Configured";
      all[id].updatedAt = new Date().toISOString();
      write(KEY, all);
      this.addAudit(adminName || "Master Admin", "Updated " + all[id].name + " configuration", id, before, all[id]);
      notify();
      return all[id];
    },

    setEnabled: function (id, enabled, adminName) {
      var all = this.getAll();
      var before = JSON.parse(JSON.stringify(all[id]));
      all[id].enabled = enabled;
      all[id].status = !all[id].hasSecret ? "Not Configured" : (enabled ? "Connected" : "Disabled");
      write(KEY, all);
      this.addAudit(adminName || "Master Admin", (enabled ? "Enabled " : "Disabled ") + all[id].name, id, before, all[id]);
      notify();
      return all[id];
    },

    /* Simulated test — no real network call. */
    testConnection: function (id) {
      var all = this.getAll();
      var ok = all[id].hasSecret;
      all[id].lastTested = new Date().toISOString();
      if (ok && all[id].enabled) all[id].status = "Connected";
      write(KEY, all);
      this.addLog(id, "Test Connection", ok, ok ? null : "Not configured — add credentials first.");
      notify();
      return ok;
    },

    addLog: function (integrationId, action, success, errorCategory) {
      var log = read(KEY_LOG, []);
      log.unshift({ id: "log-" + Date.now(), integrationId, action, success: !!success, errorCategory: errorCategory || null, timestamp: new Date().toISOString(), source: "Master Admin" });
      write(KEY_LOG, log.slice(0, 200));
    },
    getLogs: function () { return read(KEY_LOG, []); },

    addAudit: function (adminName, action, integrationId, before, after) {
      var strip = function (o) { var c = Object.assign({}, o); delete c.hasSecret; return { enabled: c.enabled, status: c.status, fields: c.fields }; };
      var log = read(KEY_AUDIT, []);
      log.unshift({ id: "audit-" + Date.now(), adminName, action, integrationId, before: strip(before), after: strip(after), timestamp: new Date().toISOString() });
      write(KEY_AUDIT, log.slice(0, 200));
    },
    getAudit: function () { return read(KEY_AUDIT, []); },

    subscribe: function (fn) {
      window.addEventListener(EVT, fn);
      window.addEventListener("storage", fn);
      return function () { window.removeEventListener(EVT, fn); window.removeEventListener("storage", fn); };
    }
  };

  window.MTS = window.MTS || {};
  window.MTS.ApiConfig = API;
})();
