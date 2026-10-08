import type { HomepageSectionKey } from "@prisma/client";

export type SectionFieldType =
  | "text"
  | "url"
  | "textarea"
  | "list"
  | "pairlist"
  | "statistics"
  | "boolean"
  | "upcomingExamsConfig"
  | "analyticsPanel"
  | "examSingle"
  | "examMulti"
  | "paperMulti"
  | "seriesMulti"
  | "mockTestMulti"
  | "select";

export interface SectionFieldDef {
  key: string;
  label: string;
  type: SectionFieldType;
  placeholder?: string;
  help?: string;
  /** Fixed choice list for `select` fields. */
  options?: string[];
}

export interface SectionMeta {
  key: HomepageSectionKey;
  label: string;
  description: string;
  fields: SectionFieldDef[];
  defaultContent: Record<string, unknown>;
}

/**
 * The four default Platform Stats cards — all LIVE, backed by
 * lib/homepage-statistics.ts. Shared by new drafts, the no-homepage
 * fallback and the admin editor's "Restore default cards".
 */
export const DEFAULT_STAT_METRICS = [
  { id: "students-joined", label: "Total Students", icon: "users", enabled: true, mode: "LIVE", dynamicKey: "registeredStudents", format: "EXACT", suffix: "+" },
  { id: "tests-attempted", label: "Tests Attempted", icon: "checkCircle", enabled: true, mode: "LIVE", dynamicKey: "testsStarted", format: "EXACT", suffix: "+" },
  { id: "questions-attempted", label: "Questions Attempted", icon: "helpCircle", enabled: true, mode: "LIVE", dynamicKey: "questionsAnswered", format: "EXACT", suffix: "+" },
  { id: "questions-available", label: "Questions Available", icon: "bookOpen", enabled: true, mode: "LIVE", dynamicKey: "questionsAvailable", format: "EXACT", suffix: "+" },
  { id: "ai-explanations-used", label: "AI Explanations Used", icon: "sparkles", enabled: true, mode: "LIVE", dynamicKey: "aiExplanationUses", format: "EXACT", suffix: "+" },
] as const;

/**
 * Default order for new drafts. Free value comes before price: Hero → proof
 * → what is free → the exam → practice material → how it works → AI →
 * platform benefits → Complete Access (price) → exam guide → FAQ → CTA.
 */
export const SECTION_ORDER: HomepageSectionKey[] = [
  "HEADER",
  "HERO",
  "STATISTICS",
  "FREE_START",
  "FEATURED_EXAM",
  "PREVIOUS_YEAR_PAPERS",
  "HOW_IT_WORKS",
  "AI_USP",
  "BENEFITS",
  "MOCK_TEST_PROMOTION",
  "TEST_SERIES",
  "UPCOMING_EXAMS",
  "EXAM_GUIDE",
  "FAQ",
  "CTA",
  "FOOTER",
  "CONTACT_INFO",
];

/**
 * Defaults are authored to be *truthful on an empty database*: no hard-coded
 * exam names, no invented marketing counts ("Full-Length Mock Tests", never
 * "50 Full-Length Mock Tests"), and no fake analytics values (the HERO
 * analytics preview panel ships DISABLED — an admin opts into DEMO or LIVE).
 * Any number that should reflect reality must come from the database.
 */
export const SECTION_META: Record<HomepageSectionKey, SectionMeta> = {
  HEADER: {
    key: "HEADER",
    label: "Header",
    description: "Navigation, login button — Admin → Website → Homepage → Header. The site logo is fixed (see components/brand/BrandLogo.tsx) and is not editable here.",
    fields: [
      { key: "navItems", label: "Navigation items (one per line: Label | /route)", type: "pairlist" },
      { key: "loginHref", label: "Student login link", type: "url" },
      { key: "loginButtonText", label: "Login button text", type: "text" },
      { key: "loginButtonVisible", label: "Show login button", type: "boolean" },
    ],
    defaultContent: {
      navItems: [["Exams", "/#featured-exam"], ["Test Series", "/#test-series"]],
      loginHref: "/login",
      loginButtonText: "Login",
      loginButtonVisible: true,
    },
  },
  HERO: {
    key: "HERO",
    label: "Hero",
    description: "Main value proposition (the page's only H1) + featured exam card — Admin → Website → Homepage → Hero. Leave a CTA link blank to use the free sign-up route.",
    fields: [
      { key: "eyebrow", label: "Eyebrow text", type: "text" },
      { key: "heading", label: "Main heading", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "primaryCtaText", label: "Primary CTA text", type: "text" },
      { key: "primaryCtaHref", label: "Primary CTA link", type: "url" },
      { key: "secondaryCtaText", label: "Secondary CTA text", type: "text" },
      { key: "secondaryCtaHref", label: "Secondary CTA link", type: "url" },
      { key: "trustLine", label: "Trust line under the buttons (optional)", type: "text" },
      {
        key: "showExamCard",
        label: "Show the featured exam card beside the headline (exam date and real counts from the Featured Exam section's exam)",
        type: "boolean",
      },
      { key: "panel", label: "Analytics preview panel (shown only when the exam card is off)", type: "analyticsPanel" },
    ],
    defaultContent: {
      eyebrow: "",
      heading: "Master your target exam with realistic mock tests",
      description:
        "Full-length mock tests, previous year papers, and AI-powered explanations — everything you need in one platform.",
      primaryCtaText: "Start a Mock Test",
      primaryCtaHref: "/login",
      secondaryCtaText: "Explore Previous Year Papers",
      secondaryCtaHref: "/login",
      trustLine: "",
      showExamCard: true,
      panel: { enabled: false, mode: "HIDDEN", showBadge: true, badgeLabel: "Preview" },
    },
  },
  FEATURED_EXAM: {
    key: "FEATURED_EXAM",
    label: "Featured Exam",
    description: "Highlight one exam from Exam Management — Admin → Website → Homepage → Featured Exam",
    fields: [
      { key: "title", label: "Title (used only when no exam is selected)", type: "text" },
      { key: "heading", label: "Display heading (blank = the exam's name)", type: "text" },
      { key: "description", label: "Description (blank = the exam's short description)", type: "textarea" },
      { key: "showDeepLinks", label: "Show links to the exam's public pages (mock series, PYQs, syllabus, pattern, question bank)", type: "boolean" },
      { key: "ctaText", label: "Primary CTA text", type: "text" },
      { key: "ctaHref", label: "Primary CTA link (blank = use the real exam page)", type: "url" },
      { key: "secondaryCtaText", label: "Secondary CTA text", type: "text" },
      { key: "secondaryCtaHref", label: "Secondary CTA link", type: "url" },
      { key: "aiExplanationEnabled", label: "Show \"AI Explanations Available\" badge", type: "boolean" },
      { key: "examId", label: "Featured exam", type: "examSingle" },
    ],
    defaultContent: {
      title: "Featured Exam",
      description: "",
      ctaText: "Take Mock Test",
      ctaHref: "",
      secondaryCtaText: "Previous Year Papers",
      secondaryCtaHref: "",
      aiExplanationEnabled: true,
      heading: "",
      showDeepLinks: true,
    },
  },
  MOCK_TEST_PROMOTION: {
    key: "MOCK_TEST_PROMOTION",
    label: "Complete Access / Pricing",
    description:
      "The paid Complete Test Series offer. Price, MRP, sale and access period always come from the canonical Product (Admin → Payments → Products); the CTA adapts to the visitor (sign in to buy / buy / open, never \"buy again\" for owned access) — Admin → Website → Homepage → Complete Access",
    fields: [
      { key: "badge", label: "Badge", type: "text" },
      { key: "eyebrow", label: "Eyebrow (small text above the heading)", type: "text" },
      { key: "numberMode", label: "Number source (used only when no Test Series is published)", type: "select", options: ["LIVE", "MANUAL"] },
      { key: "manualNumber", label: "Manual number (when source = MANUAL)", type: "text" },
      { key: "heading", label: "Heading", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "ctaText", label: "CTA text (blank = automatic per visitor)", type: "text" },
      { key: "ctaHref", label: "CTA link (used only when no Test Series is published)", type: "url" },
      { key: "compareText", label: "Comparison link text (blank = hidden)", type: "text" },
    ],
    defaultContent: {
      eyebrow: "",
      compareText: "Compare Free vs Complete",
      badge: "Most Popular",
      numberMode: "LIVE",
      manualNumber: "50",
      heading: "Full-Length Mock Tests",
      description: "Exam-pattern mock tests covering every subject and topic.",
      ctaText: "Browse Mock Tests",
      ctaHref: "/login",
    },
  },
  PREVIOUS_YEAR_PAPERS: {
    key: "PREVIOUS_YEAR_PAPERS",
    label: "Previous Year Papers",
    description: "Real papers from the database — Admin → Website → Homepage → Previous Year Papers",
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "ctaText", label: "CTA text", type: "text" },
      { key: "ctaHref", label: "CTA link", type: "url" },
      { key: "examId", label: "Auto-list papers for an exam (if no papers below)", type: "examSingle" },
      { key: "maxCards", label: "Maximum year cards to show", type: "text" },
      { key: "paperIds", label: "Specific papers to feature", type: "paperMulti" },
    ],
    defaultContent: {
      heading: "Previous Year Papers",
      description: "Practice with real exam papers in live-test format.",
      ctaText: "View Previous Year Papers",
      ctaHref: "/login",
      maxCards: "",
    },
  },
  AI_USP: {
    key: "AI_USP",
    label: "AI Features",
    description: "AI-powered explanations positioning — Admin → Website → Homepage → AI Features",
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "features", label: "Feature cards (one per line: Title | Description)", type: "pairlist" },
      { key: "ctaText", label: "CTA text", type: "text" },
      { key: "ctaHref", label: "CTA link", type: "url" },
    ],
    defaultContent: {
      heading: "Learn faster with AI",
      description:
        "Every question comes with AI-generated explanations, memory tricks, and question variants.",
      features: [
        ["AI Explanations", "Understand why an answer is correct — and why the others aren't."],
        ["AI Question Variants", "Practice the same concept asked in different ways."],
      ],
      ctaText: "",
      ctaHref: "",
    },
  },
  BENEFITS: {
    key: "BENEFITS",
    label: "Benefits",
    description: "Feature highlights / \"Why Mock Test Series\" — Admin → Website → Homepage → Benefits",
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "features", label: "Benefit cards (one per line: Title | Description)", type: "pairlist" },
    ],
    defaultContent: {
      heading: "Everything you need to crack the exam",
      description: "A single platform for preparation, practice, and analysis.",
      features: [
        ["Exam-Focused Mock Tests", "Built to match the real exam pattern."],
        ["Question-wise Analysis", "See exactly where you're losing marks."],
        ["Weak Topic Identification", "Know what to study next."],
      ],
    },
  },
  HOW_IT_WORKS: {
    key: "HOW_IT_WORKS",
    label: "How It Works",
    description: "Step-by-step flow — Admin → Website → Homepage → How It Works",
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "steps", label: "Steps (one per line: Title | Description)", type: "pairlist" },
    ],
    defaultContent: {
      heading: "How it works",
      steps: [
        ["Choose Exam", "Pick the exam you are preparing for."],
        ["Choose Test", "Select a mock test or previous year paper."],
        ["Attempt Test", "Take the test under real exam conditions."],
        ["View Result", "See your score, percentile, and analysis."],
        ["Use AI Explanation", "Understand every answer with AI."],
        ["Practice Again", "Improve where it matters."],
      ],
    },
  },
  UPCOMING_EXAMS: {
    key: "UPCOMING_EXAMS",
    label: "Upcoming Exams",
    description: "Exams marked upcoming in Exam Management — Admin → Website → Homepage → Upcoming Exams",
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "ctaText", label: "Default CTA text", type: "text" },
      { key: "exams", label: "Exams to show", type: "upcomingExamsConfig" },
    ],
    defaultContent: { heading: "Upcoming Exams", ctaText: "Learn More", exams: [] },
  },
  TEST_SERIES: {
    key: "TEST_SERIES",
    label: "Test Series",
    description: "Test series and featured tests from the database — Admin → Website → Homepage → Test Series",
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "ctaText", label: "Card CTA text", type: "text" },
      { key: "showLiveTests", label: "Show live published tests (backed by database)", type: "boolean" },
      { key: "maxTests", label: "Maximum tests to show", type: "text" },
      { key: "testSeriesIds", label: "Test series to show", type: "seriesMulti" },
      { key: "featuredTestIds", label: "Featured tests (blank = auto up to limit)", type: "mockTestMulti" },
    ],
    defaultContent: {
      heading: "Test Series",
      description: "",
      ctaText: "Start Now",
      showLiveTests: true,
      maxTests: "",
    },
  },
  STATISTICS: {
    key: "STATISTICS",
    label: "Platform Stats / Social Proof",
    description:
      "Live platform numbers (questions, students, tests and questions attempted). Turn the whole section on/off with the section switch; per card choose LIVE or a CUSTOM display value. CUSTOM changes only what the homepage shows — the database and Admin Analytics keep the real numbers — Admin → Website → Homepage → Platform Stats",
    fields: [
      { key: "heading", label: "Heading (optional)", type: "text" },
      { key: "subheading", label: "Subheading (optional)", type: "textarea" },
      {
        key: "background",
        label: "Background",
        type: "select",
        options: ["DEFAULT", "SURFACE"],
        help: "DEFAULT = page background. SURFACE = the theme's surface band, as used by other homepage sections. Colors follow Admin → Website → Appearance and the visitor's theme.",
      },
      { key: "showModeBadge", label: "Publicly show a Live/Custom tag on each card", type: "boolean" },
      { key: "hideZeroLive", label: "Hide live cards while their value is zero", type: "boolean" },
      { key: "metrics", label: "Cards", type: "statistics" },
    ],
    defaultContent: {
      heading: "",
      subheading: "",
      background: "DEFAULT",
      showModeBadge: false,
      hideZeroLive: true,
      metrics: DEFAULT_STAT_METRICS,
    },
  },
  CTA: {
    key: "CTA",
    label: "Call To Action",
    description: "Final conversion prompt — Admin → Website → Homepage → CTA",
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "buttonText", label: "Primary button text", type: "text" },
      { key: "buttonHref", label: "Primary button link", type: "url" },
      { key: "secondaryButtonText", label: "Secondary button text", type: "text" },
      { key: "secondaryButtonHref", label: "Secondary button link", type: "url" },
    ],
    defaultContent: {
      heading: "Start Your Preparation Today",
      description: "Create a free account and take your first mock test today.",
      buttonText: "Start a Mock Test",
      buttonHref: "/login",
      secondaryButtonText: "",
      secondaryButtonHref: "",
    },
  },
  FOOTER: {
    key: "FOOTER",
    label: "Footer",
    description: "Contact and legal links — Admin → Website → Homepage → Footer",
    fields: [
      { key: "email", label: "Contact email", type: "text" },
      { key: "location", label: "Location", type: "text" },
      { key: "instagramUrl", label: "Instagram URL", type: "url" },
      { key: "links", label: "Footer links (one per line: Label | /route)", type: "pairlist" },
      { key: "copyrightOverride", label: "Copyright line (blank = © <year> <logo text>)", type: "text" },
    ],
    defaultContent: {
      email: "",
      location: "",
      instagramUrl: "",
      links: [
        ["Student Login", "/login"],
        ["Privacy Policy", "/privacy"],
        ["Terms and Conditions", "/terms"],
        ["Refund & Cancellation Policy", "/refund-policy"],
        ["Contact Us", "/contact"],
      ],
      copyrightOverride: "",
    },
  },
  FREE_START: {
    key: "FREE_START",
    label: "Start for Free",
    description:
      "What a visitor can use without paying. Every card is derived from the real access rules (free mocks, PYQs, subject practice, AI quota, OMR) — a paid-only resource is never shown as free — Admin → Website → Homepage → Start for Free",
    fields: [
      { key: "showFreeBadge", label: "Show the FREE badge above the heading", type: "boolean" },
      { key: "heading", label: "Heading", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "ctaText", label: "Button text", type: "text" },
      { key: "ctaHref", label: "Button link (blank = free sign-up, or the dashboard for signed-in students)", type: "url" },
      { key: "note", label: "Small note under the button", type: "text" },
      { key: "examId", label: "Exam (blank = the Featured Exam)", type: "examSingle" },
    ],
    defaultContent: {
      showFreeBadge: true,
      heading: "Start for free",
      description: "Create a free account and start practicing straight away.",
      ctaText: "Start Free Practice",
      ctaHref: "",
      note: "No payment required to start.",
    },
  },
  EXAM_GUIDE: {
    key: "EXAM_GUIDE",
    label: "Exam Preparation Guide",
    description:
      "Long-form, visible preparation content for the main exam (helps students and search engines understand the page). Paragraph blocks are plain text — Admin → Website → Homepage → Exam Guide",
    fields: [
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "heading", label: "Heading", type: "text" },
      { key: "intro", label: "Introduction", type: "textarea" },
      { key: "blocks", label: "Content blocks (one per line: Sub-heading | Paragraph)", type: "pairlist" },
      { key: "disclaimer", label: "Disclaimer (shown small at the end)", type: "textarea" },
      { key: "examId", label: "Exam for the page links (blank = the Featured Exam)", type: "examSingle" },
    ],
    defaultContent: {
      eyebrow: "",
      heading: "How to prepare with online mock tests",
      intro: "",
      blocks: [],
      disclaimer: "",
    },
  },
  FAQ: {
    key: "FAQ",
    label: "FAQ",
    description:
      "Frequently asked questions, shown as an accessible accordion. Answer only what the platform really does — Admin → Website → Homepage → FAQ",
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "items", label: "Questions (one per line: Question | Answer)", type: "pairlist" },
      { key: "structuredData", label: "Add FAQPage structured data (schema.org) for the visible questions", type: "boolean" },
    ],
    defaultContent: {
      heading: "Frequently asked questions",
      items: [],
      structuredData: true,
    },
  },
  CONTACT_INFO: {
    key: "CONTACT_INFO",
    label: "Contact / About / Legal",
    description:
      "About Us, Privacy Policy, Terms & Conditions and Refund & Cancellation Policy content shown on /contact, /privacy, /terms, /refund-policy — Admin → Website → Homepage → Contact / About / Legal. Contact email and location live in the Footer section above (one canonical source for both the footer and the Contact page).",
    fields: [
      { key: "aboutHeading", label: "About heading", type: "text" },
      { key: "aboutBody", label: "About body", type: "textarea" },
      {
        key: "privacyBody",
        label: "Privacy Policy body (start a line with \"## \" for a heading)",
        type: "textarea",
      },
      { key: "privacyLastUpdated", label: "Privacy Policy last updated (YYYY-MM-DD)", type: "text" },
      {
        key: "termsBody",
        label: "Terms & Conditions body (start a line with \"## \" for a heading)",
        type: "textarea",
      },
      { key: "termsLastUpdated", label: "Terms & Conditions last updated (YYYY-MM-DD)", type: "text" },
      {
        key: "refundBody",
        label: "Refund & Cancellation Policy body (start a line with \"## \" for a heading)",
        type: "textarea",
      },
      { key: "refundLastUpdated", label: "Refund & Cancellation Policy last updated (YYYY-MM-DD)", type: "text" },
      { key: "contactFormEnabled", label: "Show the Message Us form on /contact", type: "boolean" },
      { key: "growWithUsEnabled", label: "Show \"Grow with Us\" in the header/footer", type: "boolean" },
    ],
    defaultContent: {
      aboutHeading: "About MockTestSeries.in",
      aboutBody: "",
      privacyBody: "",
      privacyLastUpdated: "",
      termsBody: "",
      termsLastUpdated: "",
      refundBody: "",
      refundLastUpdated: "",
      contactFormEnabled: true,
      growWithUsEnabled: true,
    },
  },
};