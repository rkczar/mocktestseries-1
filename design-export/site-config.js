/* MockTestSeries.in — site configuration store (prototype layer).
   Mirrors the intended Firestore shape:
     siteConfig/published   ← what public pages render
     siteConfig/draft       ← admin work-in-progress
     messages/{messageId}   ← Grow With Us + student messages
   In production these are Firestore documents guarded by security rules;
   here they are localStorage so the prototype behaves like one connected system. */
(function () {
  var KEY_PUB = "mts.siteConfig.published.v3";
  var KEY_DRAFT = "mts.siteConfig.draft.v3";
  var KEY_MSG = "mts.messages";
  var EVT = "mts:siteconfig";

  var DEFAULTS = {
    version: 1,
    updatedAt: null,
    updatedBy: null,
    announcement: {
      enabled: true,
      tag: "New",
      text: "RUHS Medical Officer 2026 test series is live — AI explanations on every question.",
      linkLabel: "View exam",
      linkRoute: "/exams/ruhs-mo"
    },
    header: {
      items: [
        { id: "home", label: "Home", route: "/", enabled: true },
        { id: "exams", label: "Exams", route: "/exams", enabled: true },
        { id: "series", label: "Test Series", route: "/test-series", enabled: true },
        { id: "about", label: "About", route: "/about", enabled: false },
        { id: "contact", label: "Contact Us", route: "/contact", enabled: true }
      ],
      showThemeToggle: true,
      loginLabel: "Login",
      loginRoute: "/student/login",
      ctaEnabled: false,
      ctaLabel: "Start Free",
      ctaRoute: "/student/register",
      growWithUs: true
    },
    footer: {
      tagline: "AI-powered mock tests and practice resources designed for serious aspirants.",
      sections: [
        {
          id: "quicklinks", title: "Quick Links", enabled: true, links: [
            { id: "f-home", label: "Home", route: "/", enabled: true },
            { id: "f-exams", label: "Exams", route: "/exams", enabled: true },
            { id: "f-series", label: "Test Series", route: "/test-series", enabled: true },
            { id: "f-contact", label: "Contact Us", route: "/contact", enabled: true }
          ]
        },
        {
          id: "legal", title: "Legal / Information", enabled: true, links: [
            { id: "f-about", label: "About Us", route: "/contact#about-us", enabled: true },
            { id: "f-privacy", label: "Privacy Policy", route: "/contact#privacy-policy", enabled: true },
            { id: "f-terms", label: "Terms & Conditions", route: "/contact#terms-and-conditions", enabled: true },
            { id: "f-contact2", label: "Contact Us", route: "/contact", enabled: true }
          ]
        }
      ],
      contact: {
        enabled: true,
        title: "Contact",
        email: "info@mocktestseries.com",
        phone: "",
        instagram: "Mock Test Series.in",
        instagramUrl: "https://instagram.com/mocktestseries.in",
        address: "Jaipur, Rajasthan, India"
      },
      growWithUs: true,
      madeInIndia: true,
      madeInIndiaText: "Made with love in India",
      copyright: "© 2026 MockTestSeries.in. All rights reserved."
    },
    legalContent: {
      aboutUs: {
        enabled: true,
        title: "About Mock Test Series.in",
        lastUpdated: "2026-09-01",
        content: "Mock Test Series.in is an exam-preparation platform built for students preparing for competitive and professional exams in India.\n\nWe provide full-length mock tests, subject-wise practice, and previous-year papers, each mapped to the actual exam pattern. Every question comes with an AI-assisted explanation covering why the correct answer is right and why the other options are not, so practice turns into understanding rather than just scoring.\n\n## Who it's for\nStudents preparing for medical officer recruitment exams and similar competitive tests who want structured, exam-accurate practice.\n\n## What we offer\n- Full mock tests with real exam timing and marking\n- Subject and topic-wise practice sets\n- Previous-year papers\n- AI-generated explanations on every question\n- Personal test history, saved questions and a mistake notebook\n- Performance analytics across subjects and topics\n\n## Our purpose\nWe aim to make focused, high-quality exam practice accessible and to help students understand concepts, not just memorize answers."
      },
      privacyPolicy: {
        enabled: true,
        title: "Privacy Policy",
        lastUpdated: "2026-09-01",
        content: "## 1. Introduction\nThis Privacy Policy explains how Mock Test Series.in collects, uses and protects your information when you use our platform.\n\n## 2. Information We Collect\nWe collect information you provide directly and information generated through your use of the platform.\n\n## 3. Account Information\nName, email address and phone number provided at registration.\n\n## 4. Google Login Information\nIf you sign in with Google, we receive your name, email address and profile photo as shared by Google.\n\n## 5. Phone Number / OTP Authentication\nYour phone number is stored only after successful OTP verification. OTP codes themselves are never stored in plain text and are not retained after verification.\n\n## 6. Profile Information\nDetails you add to your student profile, such as your target exam and study preferences.\n\n## 7. Test Attempts and Performance Data\nRecords of tests you take, including answers, scores, time taken and accuracy.\n\n## 8. Questions Attempted / Learning Activity\nWhich questions you have attempted, saved or marked as mistakes, used to power your dashboard and analytics.\n\n## 9. Payment and Transaction Information\nWhen a paid feature is purchased, payment is processed by our payment provider; we store transaction status and reference identifiers, not full card details.\n\n## 10. AI Feature Usage\nQuestions you ask our AI explanation feature and the responses generated, stored to avoid duplicate processing.\n\n## 11. Cookies and Similar Technologies\nWe use cookies/local storage to keep you signed in and remember preferences such as theme.\n\n## 12. How We Use Information\nTo operate the platform, personalize your dashboard, improve test content, and communicate important updates.\n\n## 13. Data Storage and Security\nWe apply reasonable technical and organizational measures to protect your data. No method of storage or transmission is completely secure.\n\n## 14. Data Sharing and Third Parties\nWe do not sell your personal information. Limited data is shared only with service providers necessary to operate the platform.\n\n## 15. Payment Service Providers\nPayments are handled by a third-party payment gateway that processes your payment details directly under its own security standards.\n\n## 16. Authentication Providers\nGoogle Sign-In and our SMS/OTP provider process the minimum data required to authenticate you.\n\n## 17. AI/API Service Providers\nQuestion text is shared with our AI provider solely to generate explanations.\n\n## 18. Data Retention\nWe retain account and activity data for as long as your account is active, or as required to provide the service.\n\n## 19. Account Deletion\nYou may request deletion of your account and associated data through Settings.\n\n## 20. Student Account Deletion Requests\nDeletion requests are reviewed by our team and processed after a short verification window.\n\n## 21. Children's/Minor Users\nThe platform is intended for exam aspirants; a parent or guardian should supervise use by minors.\n\n## 22. User Rights\nYou may request access to, correction of, or deletion of your personal data by contacting us.\n\n## 23. Changes to Privacy Policy\nWe may update this policy from time to time. Material changes will be reflected with an updated date above.\n\n## 24. Contact Information\nFor privacy-related questions, use the Contact Us section above."
      },
      termsAndConditions: {
        enabled: true,
        title: "Terms and Conditions",
        lastUpdated: "2026-09-01",
        content: "## 1. Introduction\nThese Terms and Conditions govern your use of Mock Test Series.in.\n\n## 2. Acceptance of Terms\nBy creating an account or using the platform, you agree to these Terms.\n\n## 3. Eligibility\nThe platform is intended for students preparing for the exams we cover.\n\n## 4. User Account\nYou are responsible for the accuracy of the information you provide when registering.\n\n## 5. Account Security\nKeep your login credentials confidential. You are responsible for activity under your account.\n\n## 6. Use of Mock Tests\nTests are provided for personal exam preparation only.\n\n## 7. Test Rules and Instructions\nFollow the timing, marking and navigation rules shown at the start of each test.\n\n## 8. Previous-Year Papers\nPrevious-year papers are provided for practice; official sources remain the authoritative reference.\n\n## 9. AI-Generated Questions and Explanations\nSome explanations and practice variants are generated using AI and are intended as study aids.\n\n## 10. Accuracy of Educational Content\nWe take reasonable care in preparing content but do not guarantee it is error-free or exhaustive; verify critical information against official exam material.\n\n## 11. User Responsibilities\nUse the platform honestly and only for its intended educational purpose.\n\n## 12. Prohibited Activities\nDo not attempt to copy, resell, scrape or misuse platform content, or interfere with its operation.\n\n## 13. Intellectual Property\nAll platform content, design and questions authored by us remain our property or that of our licensors.\n\n## 14. Copyright\nThird-party content is used with appropriate permission or under fair use for educational purposes where applicable.\n\n## 15. Payments and Purchases\nPaid features are billed as described at the time of purchase.\n\n## 16. Refund/Cancellation Policy Reference\nRefund and cancellation terms, where applicable, are described separately at the point of purchase.\n\n## 17. Service Availability\nWe aim for high availability but do not guarantee uninterrupted access.\n\n## 18. Changes to Platform\nFeatures may be added, changed or removed as the platform evolves.\n\n## 19. Account Suspension or Termination\nWe may suspend or terminate accounts that violate these Terms.\n\n## 20. User-Requested Account Deletion\nYou may request account deletion at any time through Settings; this follows the review process described in our Privacy Policy.\n\n## 21. Limitation of Liability\nTo the extent permitted by law, we are not liable for indirect or consequential loss arising from use of the platform.\n\n## 22. Third-Party Services\nThe platform integrates third-party services (such as authentication, payments and AI providers) that have their own terms.\n\n## 23. Changes to Terms\nWe may update these Terms from time to time; continued use after changes means you accept the updated Terms.\n\n## 24. Governing Law\nThese Terms are governed by the laws of India.\n\n## 25. Contact Information\nFor questions about these Terms, use the Contact Us section above."
      }
    }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function read(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      if (!raw) return clone(fallback);
      var parsed = JSON.parse(raw);
      return parsed && parsed.header ? parsed : clone(fallback);
    } catch (e) { return clone(fallback); }
  }

  function write(key, val) {
    try { window.localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
  }

  function notify() {
    try { window.dispatchEvent(new CustomEvent(EVT)); } catch (e) { /* noop */ }
  }

  var SiteConfig = {
    defaults: function () { return clone(DEFAULTS); },
    getPublished: function () { return read(KEY_PUB, DEFAULTS); },
    getDraft: function () { return read(KEY_DRAFT, this.getPublished()); },
    saveDraft: function (cfg) {
      cfg.updatedAt = new Date().toISOString();
      write(KEY_DRAFT, cfg);
      notify();
      return cfg;
    },
    publish: function (cfg, by) {
      var next = cfg ? clone(cfg) : this.getDraft();
      next.updatedAt = new Date().toISOString();
      next.updatedBy = by || "Master Admin";
      write(KEY_PUB, next);
      write(KEY_DRAFT, next);
      notify();
      return next;
    },
    discardDraft: function () {
      write(KEY_DRAFT, this.getPublished());
      notify();
    },
    resetAll: function () {
      write(KEY_PUB, clone(DEFAULTS));
      write(KEY_DRAFT, clone(DEFAULTS));
      notify();
    },
    isDirty: function () {
      return JSON.stringify(this.getDraft()) !== JSON.stringify(this.getPublished());
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

  var CATEGORIES = ["Grow With Us", "Contact Us", "Complaint", "Suggestion", "Technical Issue", "Question Issue", "Test Issue", "Other"];
  var STATUSES = ["New", "Read", "In Progress", "Resolved", "Closed"];

  var Messages = {
    categories: CATEGORIES,
    statuses: STATUSES,
    all: function () {
      try { return JSON.parse(window.localStorage.getItem(KEY_MSG) || "[]"); }
      catch (e) { return []; }
    },
    add: function (msg) {
      var list = this.all();
      var rec = Object.assign({
        id: "MSG-" + String(Date.now()).slice(-8),
        category: "Other",
        status: "New",
        name: "",
        email: "",
        phone: "",
        studentUid: null,
        examId: null,
        testId: null,
        questionId: null,
        interests: [],
        message: "",
        createdAt: new Date().toISOString()
      }, msg || {});
      list.unshift(rec);
      write(KEY_MSG, list);
      notify();
      return rec;
    },
    setStatus: function (id, status) {
      var list = this.all().map(function (m) {
        return m.id === id ? Object.assign({}, m, { status: status }) : m;
      });
      write(KEY_MSG, list);
      notify();
    },
    counts: function () {
      var list = this.all(), out = { total: list.length };
      STATUSES.forEach(function (s) { out[s] = 0; });
      list.forEach(function (m) { if (out[m.status] != null) out[m.status] += 1; });
      return out;
    }
  };

  var KEY_PAGES = "mts.pagesRegistry.v1";
  var PAGE_DEFAULTS = [
    { id: "home", name: "Home", route: "/", enabled: true },
    { id: "exams", name: "Exams", route: "/exams", enabled: true },
    { id: "series", name: "Test Series", route: "/test-series", enabled: true },
    { id: "studentLogin", name: "Student Login", route: "/student/login", enabled: true },
    { id: "contact", name: "Contact Us (incl. About / Privacy / Terms)", route: "/contact", enabled: true }
  ];

  var PagesRegistry = {
    getAll: function () { return read(KEY_PAGES, PAGE_DEFAULTS); },
    isEnabled: function (route) {
      var p = this.getAll().find(function (p) { return p.route === route; });
      return p ? p.enabled : true;
    },
    toggle: function (id) {
      var list = this.getAll().map(function (p) { return p.id === id ? Object.assign({}, p, { enabled: !p.enabled }) : p; });
      write(KEY_PAGES, list);
      notify();
    },
    subscribe: function (fn) {
      window.addEventListener(EVT, fn);
      window.addEventListener("storage", fn);
      return function () { window.removeEventListener(EVT, fn); window.removeEventListener("storage", fn); };
    }
  };

  var GrowWithUs = {
    OPEN_EVENT: "mts:growwithus:open",
    options: [
      "As a Teacher",
      "As a Question Bank Reviewer",
      "For Test Series",
      "For Content Contribution",
      "For Technical Support",
      "Other"
    ],
    open: function () {
      try { window.dispatchEvent(new CustomEvent(this.OPEN_EVENT)); } catch (e) { /* noop */ }
    }
  };

  window.MTS = window.MTS || {};
  window.MTS.SiteConfig = SiteConfig;
  window.MTS.Messages = Messages;
  window.MTS.GrowWithUs = GrowWithUs;
  window.MTS.PagesRegistry = PagesRegistry;
})();
