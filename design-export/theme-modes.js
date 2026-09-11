/* MockTestSeries.in — global 3-mode theme system.
   Modes: day → night → eye (pure black & white) → day
   Layered ON TOP of the admin-controlled frontend appearance (frontend-appearance.js):
   day uses the admin's saved colors verbatim; night and eye derive from them.

   Persistence: localStorage("mts.theme.mode"). Applied to <html> as
   data-mts-mode + inline --frontend-* / --admin-* custom properties, so no
   page needs its own theme code and future pages inherit it automatically.
   Changes nothing structural — colors, fonts and buttons only. */
(function () {
  var KEY = "mts.theme.mode";
  var MODES = ["day", "night", "eye"];
  var LABELS = { day: "Day Mode", night: "Night Mode", eye: "Eye Protection Mode" };

  var NIGHT = {
    background: "#0B1622", surface: "#111F2E", text: "#E7EEF5", heading: "#F2F7FB",
    muted: "#B4C4D4", faint: "#8497A9", placeholder: "#7B8CA0",
    border: "#22364A", borderStrong: "#2C4560", borderSubtle: "#1B2C3D",
    tint: "#16293C", tintBorder: "#254059",
    primary: "#5FA3DA", primaryHover: "#8FBEE6", secondary: "#B4C4D4",
    accent: "#F2B872", accentHover: "#FFD199", accentText: "#F2B872",
    accentTint: "#2B1F10", accentBorder: "#5A3D18",
    success: "#8FD79E", successText: "#A6E3B3", successTint: "#142A1B", successBorder: "#2C5335",
    error: "#FF9EA0", errorText: "#FFB6B8", errorTint: "#2C1618", errorBorder: "#5A2A2C",
    warning: "#F2B872", warningTint: "#2B1F10", warningBorder: "#5A3D18", warningText: "#F2D2A6",
    info: "#5FA3DA", onBrand: "#08131E",
    inverseSurface: "#08131E", inverseText: "#F2F7FB", inverseMuted: "#C8D8E6",
    inverseFaint: "#9FB4C7", inverseBorder: "#2C4560", inverseAccent: "#F2B872"
  };

  var EYE = {
    background: "#000000", surface: "#000000", text: "#FFFFFF", heading: "#FFFFFF",
    muted: "#F2F2F2", faint: "#C9C9C9", placeholder: "#A8A8A8",
    border: "#3A3A3A", borderStrong: "#6E6E6E", borderSubtle: "#242424",
    tint: "#0A0A0A", tintBorder: "#4A4A4A",
    primary: "#FFFFFF", primaryHover: "#E0E0E0", secondary: "#F2F2F2",
    accent: "#FFFFFF", accentHover: "#E0E0E0", accentText: "#FFFFFF",
    accentTint: "#0A0A0A", accentBorder: "#B0B0B0",
    /* semantics kept legible in pure B/W: distinguished by border brightness, not hue */
    success: "#FFFFFF", successText: "#FFFFFF", successTint: "#101010", successBorder: "#FFFFFF",
    error: "#FFFFFF", errorText: "#FFFFFF", errorTint: "#000000", errorBorder: "#7A7A7A",
    warning: "#FFFFFF", warningTint: "#0A0A0A", warningBorder: "#B0B0B0", warningText: "#FFFFFF",
    info: "#FFFFFF", onBrand: "#000000",
    inverseSurface: "#000000", inverseText: "#FFFFFF", inverseMuted: "#F2F2F2",
    inverseFaint: "#C9C9C9", inverseBorder: "#FFFFFF", inverseAccent: "#FFFFFF"
  };

  var BTN_NIGHT = {
    primaryBg: "#1D5C91", primaryText: "#FFFFFF",
    secondaryBg: "#8A5620", secondaryText: "#FFFFFF",
    outlineBg: "#111F2E", outlineText: "#8FBEE6", outlineBorder: "#2C4560",
    successBg: "#2C5335", dangerBg: "#8E3033", ghostText: "#E7EEF5"
  };
  var BTN_EYE = {
    primaryBg: "#FFFFFF", primaryText: "#000000",
    secondaryBg: "#FFFFFF", secondaryText: "#000000",
    outlineBg: "#000000", outlineText: "#FFFFFF", outlineBorder: "#FFFFFF",
    successBg: "#FFFFFF", dangerBg: "#FFFFFF", ghostText: "#FFFFFF"
  };

  /* Admin panel keeps its own variable namespace (--bg/--surface/--text…).
     It does NOT consume frontend appearance colors, but it does follow the mode. */
  var ADMIN = {
    day: { bg: "#F6F9FC", surface: "#FFFFFF", text: "#212529", heading: "#0F2B45", muted: "#41505E",
      faint: "#5C6B7A", onBrand: "#FFFFFF", accentText: "#A85400", border: "#E3EAF2", borderSubtle: "#EDF2F7", track: "#F1F5F9",
      tint: "#EEF4FA", tintBorder: "#DCE7F2", primaryText: "#0F4C81",
      successTint: "#EEF7EE", successBorder: "#CFE3D0", errorTint: "#FDEDED", errorBorder: "#F6D5D5",
      accentTint: "#FFF6EC", accentBorder: "#F8DDBE", success: "#2E7D32", error: "#C62828" },
    night: { bg: "#0B1622", surface: "#111F2E", text: "#E7EEF5", heading: "#F2F7FB", muted: "#B4C4D4",
      faint: "#9CB0C2", onBrand: "#08131E", accentText: "#F2B872", border: "#22364A", borderSubtle: "#1B2C3D", track: "#1B2C3D",
      tint: "#16293C", tintBorder: "#254059", primaryText: "#8FBEE6",
      successTint: "#142A1B", successBorder: "#2C5335", errorTint: "#2C1618", errorBorder: "#5A2A2C",
      accentTint: "#2B1F10", accentBorder: "#5A3D18", success: "#8FD79E", error: "#FF9EA0" },
    eye: { bg: "#000000", surface: "#000000", text: "#FFFFFF", heading: "#FFFFFF", muted: "#F2F2F2",
      faint: "#C9C9C9", onBrand: "#000000", accentText: "#FFFFFF", border: "#3A3A3A", borderSubtle: "#242424", track: "#141414",
      tint: "#0A0A0A", tintBorder: "#4A4A4A", primaryText: "#FFFFFF",
      successTint: "#101010", successBorder: "#FFFFFF", errorTint: "#000000", errorBorder: "#7A7A7A",
      accentTint: "#0A0A0A", accentBorder: "#B0B0B0", success: "#FFFFFF", error: "#FFFFFF" }
  };

  function kebab(s) { return s.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); }); }

  function readMode() {
    try { var m = window.localStorage.getItem(KEY); return MODES.indexOf(m) > -1 ? m : "day"; }
    catch (e) { return "day"; }
  }

  function apply(mode) {
    var root = document.documentElement;
    root.setAttribute("data-mts-mode", mode);

    /* 1. base layer: admin-saved frontend appearance (day truth) */
    var fa = window.FrontendAppearance;
    var base = fa ? fa.apply() : null;

    /* 2. mode layer on top */
    var colors = mode === "night" ? NIGHT : mode === "eye" ? EYE : null;
    if (colors) {
      Object.keys(colors).forEach(function (k) {
        root.style.setProperty("--frontend-" + kebab(k), colors[k]);
      });
      var btns = mode === "night" ? BTN_NIGHT : BTN_EYE;
      Object.keys(btns).forEach(function (k) {
        root.style.setProperty("--frontend-btn-" + kebab(k), btns[k]);
      });
    } else if (base) {
      /* day: nothing to override — appearance values already applied */
    }

    /* 3. admin namespace follows the mode, independent of frontend colors */
    var adm = ADMIN[mode] || ADMIN.day;
    Object.keys(adm).forEach(function (k) {
      root.style.setProperty("--admin-" + kebab(k), adm[k]);
      root.style.setProperty("--" + k, adm[k]);
    });
    root.style.setProperty("--primary", mode === "eye" ? "#FFFFFF" : mode === "night" ? "#4A93CC" : "#0F4C81");
    root.style.setProperty("--accent", mode === "eye" ? "#FFFFFF" : mode === "night" ? "#F2B872" : "#F57C00");
    root.style.colorScheme = mode === "day" ? "light" : "dark";
    document.body && (document.body.style.background = "var(--frontend-background, " + (adm.bg) + ")");

    updateButtons(mode);
    window.dispatchEvent(new CustomEvent("mts:mode", { detail: { mode: mode } }));
    return mode;
  }

  function setMode(mode) {
    if (MODES.indexOf(mode) < 0) mode = "day";
    try { window.localStorage.setItem(KEY, mode); } catch (e) {}
    return apply(mode);
  }

  function cycle() {
    var i = MODES.indexOf(readMode());
    return setMode(MODES[(i + 1) % MODES.length]);
  }

  var ICONS = {
    day: '<circle cx="12" cy="12" r="4.4"></circle><path d="M12 2.2v2.6M12 19.2v2.6M2.2 12h2.6M19.2 12h2.6M5.1 5.1l1.9 1.9M17 17l1.9 1.9M18.9 5.1L17 7M7 17l-1.9 1.9"></path>',
    night: '<path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a7.1 7.1 0 1 0 11.1 11.1z"></path>',
    eye: '<circle cx="12" cy="12" r="8.6"></circle><path d="M12 3.4a8.6 8.6 0 0 0 0 17.2z" fill="currentColor" stroke="none"></path>'
  };

  function ensureStyles() {
    if (document.getElementById("mts-theme-styles")) return;
    var st = document.createElement("style");
    st.id = "mts-theme-styles";
    st.textContent =
      '.mts-theme-btn{width:38px;height:38px;flex:0 0 auto;border-radius:999px;display:inline-flex;' +
      'align-items:center;justify-content:center;cursor:pointer;position:relative;padding:0;' +
      'background:var(--frontend-surface,#FFFFFF);border:1px solid var(--frontend-border-strong,#CFDCE9);' +
      'color:var(--frontend-primary,#0F4C81);box-shadow:0 1px 2px rgba(15,43,69,.06);' +
      'transition:background .18s ease,border-color .18s ease,color .18s ease,box-shadow .18s ease,transform .18s ease}' +
      '.mts-theme-btn:hover{background:var(--frontend-tint,#EEF4FA);border-color:var(--frontend-primary,#0F4C81);box-shadow:0 3px 10px rgba(15,43,69,.14)}' +
      '.mts-theme-btn:active{transform:scale(.94)}' +
      '.mts-theme-btn:focus-visible{outline:2px solid var(--frontend-primary,#0F4C81);outline-offset:2px}' +
      '.mts-theme-btn svg{display:block;transition:transform .35s cubic-bezier(.34,1.4,.64,1),opacity .2s ease}' +
      '.mts-theme-btn[data-spin="1"] svg{transform:rotate(180deg);opacity:.55}' +
      '.mts-theme-btn .mts-tip{position:absolute;top:calc(100% + 8px);right:0;white-space:nowrap;' +
      'font:600 11.5px/1 Manrope,system-ui,sans-serif;letter-spacing:.02em;padding:6px 9px;border-radius:7px;' +
      'background:var(--frontend-inverse-surface,#0B3A63);color:var(--frontend-inverse-text,#FFFFFF);opacity:0;pointer-events:none;' +
      'transform:translateY(-3px);transition:opacity .16s ease,transform .16s ease;z-index:60}' +
      '@media (hover:hover){.mts-theme-btn:hover .mts-tip{opacity:1;transform:translateY(0)}}' +
      '@media (max-width:520px){.mts-theme-btn{width:40px;height:40px}.mts-theme-btn .mts-tip{display:none}}' +
      '[data-mts-mode="eye"] .mts-theme-btn{background:#000;border-color:#FFF;color:#FFF}' +
      '[data-mts-mode="eye"] .mts-theme-btn .mts-tip{background:#FFF;color:#000}';
    document.head.appendChild(st);
  }

  function updateButtons(mode) {
    var btns = document.querySelectorAll(".mts-theme-btn");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.setAttribute("aria-label", LABELS[mode] + " — click to switch");
      b.setAttribute("title", "");
      var svg = b.querySelector("svg");
      if (svg) svg.innerHTML = ICONS[mode];
      var tip = b.querySelector(".mts-tip");
      if (tip) tip.textContent = LABELS[mode];
    }
  }

  function makeButton() {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "mts-theme-btn";
    b.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></svg>' +
      '<span class="mts-tip"></span>';
    b.addEventListener("click", function () {
      b.setAttribute("data-spin", "1");
      cycle();
      window.setTimeout(function () { b.removeAttribute("data-spin"); }, 340);
    });
    return b;
  }

  /* Inject into the shared header of whatever page is loaded, without changing
     header height or layout: the button joins the existing right-hand flex row. */
  function mount() {
    ensureStyles();
    var headers = document.querySelectorAll("header");
    for (var i = 0; i < headers.length; i++) {
      var h = headers[i];
      if (h.querySelector(".mts-theme-btn")) continue;
      var row = h.querySelector("[data-theme-slot]");
      if (!row) {
        /* the last flex row in the header holds the account/CTA cluster */
        var candidates = h.querySelectorAll("div");
        for (var j = candidates.length - 1; j >= 0; j--) {
          var cs = window.getComputedStyle(candidates[j]);
          if (cs.display === "flex" && candidates[j].children.length && candidates[j].children.length < 6) { row = candidates[j]; break; }
        }
      }
      var btn = makeButton();
      if (row) row.insertBefore(btn, row.firstChild);
      else h.appendChild(btn);
    }
    updateButtons(readMode());
  }

  window.MTSTheme = { KEY: KEY, MODES: MODES, LABELS: LABELS, read: readMode, set: setMode, cycle: cycle, apply: apply, mount: mount };

  apply(readMode());
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
  /* DC pages stream in — re-mount as the header appears, then stop watching */
  var tries = 0;
  var iv = window.setInterval(function () { mount(); if (++tries > 40) window.clearInterval(iv); }, 250);
  window.addEventListener("storage", function (e) { if (e.key === KEY) apply(readMode()); });
})();
