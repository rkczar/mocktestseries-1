/* MockTestSeries.in — centralized FRONTEND appearance.
   Controls colors, fonts and buttons for public/student-facing pages only.
   The Admin Panel has its own independent styling and never reads these values.

   Mockup persistence: localStorage("mts.frontend.appearance").
   Production: these values come from the AppearanceSetting table and are
   rendered server-side into a <style>:root{...}</style> block, so they survive
   refresh, logout and app restarts without depending on the browser. */
(function () {
  var KEY = "mts.frontend.appearance.v2";
  var LEGACY_KEYS = ["mts.frontend.appearance"];

  var DEFAULTS = {
    colors: {
      primary: "#0F4C81",
      primaryHover: "#0B3A63",
      secondary: "#41505E",
      accent: "#F57C00",
      accentHover: "#DC6F00",
      accentText: "#A85400",
      accentTint: "#FFF6EC",
      accentBorder: "#F8DDBE",
      background: "#F6F9FC",
      surface: "#FFFFFF",
      text: "#212529",
      heading: "#0F2B45",
      muted: "#41505E",
      faint: "#5C6B7A",
      placeholder: "#69788A",
      border: "#E3EAF2",
      borderStrong: "#CFDCE9",
      borderSubtle: "#EDF2F7",
      tint: "#EEF4FA",
      tintBorder: "#DCE7F2",
      success: "#2E7D32",
      successText: "#1E5620",
      successTint: "#EEF7EE",
      successBorder: "#CFE3D0",
      error: "#C62828",
      errorText: "#8A2020",
      errorTint: "#FDEDED",
      errorBorder: "#F6D5D5",
      warning: "#9A5000",
      warningTint: "#FFF6EC",
      warningBorder: "#F8DDBE",
      warningText: "#5B4526",
      info: "#0F4C81",
      /* text drawn ON a brand/semantic fill (primary, success, error chips) */
      onBrand: "#FFFFFF",
      /* a ground that stays dark with light text in ALL three modes:
         announcement bar, final CTA panel, AI panel header, tooltips */
      inverseSurface: "#0B3A63",
      inverseText: "#FFFFFF",
      inverseMuted: "#D7E5F1",
      inverseFaint: "#A9C4DA",
      inverseBorder: "#4A7BA5",
      inverseAccent: "#F9A94A"
    },
    fonts: {
      heading: "'Source Serif 4', Georgia, serif",
      body: "Manrope, system-ui, sans-serif",
      mono: "'IBM Plex Mono', monospace",
      bodyWeight: "400",
      bodyLineHeight: "1.6",
      baseSize: "16px"
    },
    buttons: {
      radius: "10px",
      primaryBg: "#0F4C81",
      primaryText: "#FFFFFF",
      secondaryBg: "#A85400",
      secondaryText: "#FFFFFF",
      outlineBg: "#FFFFFF",
      outlineText: "#0F4C81",
      outlineBorder: "#CFDCE9",
      successBg: "#2E7D32",
      dangerBg: "#C62828",
      ghostText: "#FFFFFF"
    }
  };

  var GOOGLE_FONTS = {
    "Manrope, system-ui, sans-serif": "Manrope:wght@400;500;600;700;800",
    "'Source Serif 4', Georgia, serif": "Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700",
    "'IBM Plex Mono', monospace": "IBM+Plex+Mono:wght@400;500;600",
    "'Libre Franklin', system-ui, sans-serif": "Libre+Franklin:wght@400;500;600;700;800",
    "'Public Sans', system-ui, sans-serif": "Public+Sans:wght@400;500;600;700;800",
    "'Newsreader', Georgia, serif": "Newsreader:opsz,wght@6..72,400;6..72,600;6..72,700",
    "'Bitter', Georgia, serif": "Bitter:wght@400;600;700",
    "'Space Mono', monospace": "Space+Mono:wght@400;700"
  };

  function merge(base, over) {
    var out = {};
    Object.keys(base).forEach(function (group) {
      out[group] = {};
      Object.keys(base[group]).forEach(function (k) { out[group][k] = base[group][k]; });
      if (over && over[group]) {
        Object.keys(over[group]).forEach(function (k) {
          if (over[group][k]) out[group][k] = over[group][k];
        });
      }
    });
    return out;
  }

  function read() {
    try {
      LEGACY_KEYS.forEach(function (k) { window.localStorage.removeItem(k); });
      var raw = window.localStorage.getItem(KEY);
      return raw ? merge(DEFAULTS, JSON.parse(raw)) : merge(DEFAULTS, null);
    } catch (e) { return merge(DEFAULTS, null); }
  }

  function kebab(s) { return s.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); }); }

  function loadFonts(fonts) {
    var families = [fonts.heading, fonts.body, fonts.mono]
      .map(function (f) { return GOOGLE_FONTS[f]; })
      .filter(Boolean);
    if (!families.length) return;
    var href = "https://fonts.googleapis.com/css2?family=" + families.join("&family=") + "&display=swap";
    var link = document.getElementById("frontend-appearance-fonts");
    if (!link) {
      link = document.createElement("link");
      link.id = "frontend-appearance-fonts";
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }
    if (link.href !== href) link.href = href;
  }

  function apply(settings) {
    var s = settings || read();
    var root = document.documentElement;
    Object.keys(s.colors).forEach(function (k) {
      root.style.setProperty("--frontend-" + kebab(k), s.colors[k]);
    });
    root.style.setProperty("--frontend-font-heading", s.fonts.heading);
    root.style.setProperty("--frontend-font-body", s.fonts.body);
    root.style.setProperty("--frontend-font-mono", s.fonts.mono);
    root.style.setProperty("--frontend-font-weight", s.fonts.bodyWeight);
    root.style.setProperty("--frontend-line-height", s.fonts.bodyLineHeight);
    root.style.setProperty("--frontend-font-size", s.fonts.baseSize);
    Object.keys(s.buttons).forEach(function (k) {
      root.style.setProperty("--frontend-btn-" + kebab(k), s.buttons[k]);
    });
    loadFonts(s.fonts);
    return s;
  }

  function save(settings) {
    try { window.localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) {}
    return apply(settings);
  }

  window.FrontendAppearance = { KEY: KEY, DEFAULTS: DEFAULTS, read: read, apply: apply, save: save, fontOptions: Object.keys(GOOGLE_FONTS) };

  apply();
  window.addEventListener("storage", function (e) { if (e.key === KEY) apply(); });
})();
