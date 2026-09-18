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

export const SECTION_ORDER: HomepageSectionKey[] = [
  "HEADER",
  "HERO",
  "FEATURED_EXAM",
  "MOCK_TEST_PROMOTION",
  "PREVIOUS_YEAR_PAPERS",
  "AI_USP",
  "BENEFITS",
  "HOW_IT_WORKS",
  "UPCOMING_EXAMS",
  "TEST_SERIES",
  "STATISTICS",
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
    description: "Main value proposition + analytics preview panel — Admin → Website → Homepage → Hero",
    fields: [
      { key: "eyebrow", label: "Eyebrow text", type: "text" },
      { key: "heading", label: "Main heading", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "primaryCtaText", label: "Primary CTA text", type: "text" },
      { key: "primaryCtaHref", label: "Primary CTA link", type: "url" },
      { key: "secondaryCtaText", label: "Secondary CTA text", type: "text" },
      { key: "secondaryCtaHref", label: "Secondary CTA link", type: "url" },
      { key: "panel", label: "Analytics preview panel", type: "analyticsPanel" },
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
      panel: { enabled: false, mode: "HIDDEN", showBadge: true, badgeLabel: "Preview" },
    },
  },
  FEATURED_EXAM: {
    key: "FEATURED_EXAM",
    label: "Featured Exam",
    description: "Highlight one exam from Exam Management — Admin → Website → Homepage → Featured Exam",
    fields: [
      { key: "title", label: "Title (used only when no exam is selected)", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
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
    },
  },
  MOCK_TEST_PROMOTION: {
    key: "MOCK_TEST_PROMOTION",
    label: "Mock Test Promotion",
    description: "Promote the mock test library using the real published-test count — Admin → Website → Homepage → Mock Test Promotion",
    fields: [
      { key: "badge", label: "Badge", type: "text" },
      { key: "numberMode", label: "Number source", type: "select", options: ["LIVE", "MANUAL"] },
      { key: "manualNumber", label: "Manual number (when source = MANUAL)", type: "text" },
      { key: "heading", label: "Heading", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "ctaText", label: "CTA text", type: "text" },
      { key: "ctaHref", label: "CTA link", type: "url" },
    ],
    defaultContent: {
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
    label: "Platform Statistics",
    description: "Trust-building numbers — live, demo, or manual — Admin → Website → Homepage → Platform Statistics",
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "showModeBadge", label: "Publicly show a Live/Demo/Manual tag on each card", type: "boolean" },
      { key: "hideZeroLive", label: "Hide live cards while their value is zero", type: "boolean" },
      { key: "metrics", label: "Cards", type: "statistics" },
    ],
    defaultContent: {
      heading: "Track your progress in numbers",
      showModeBadge: false,
      hideZeroLive: true,
      metrics: [
        { id: "questions-answered", label: "Questions Answered", icon: "helpCircle", description: "Total questions answered by students.", enabled: true, mode: "LIVE", dynamicKey: "questionsAnswered" },
        { id: "ai-explanations", label: "AI Explanations", icon: "sparkles", description: "AI-generated explanations available.", enabled: true, mode: "LIVE", dynamicKey: "aiExplanations" },
        { id: "exams", label: "Exams", icon: "graduationCap", description: "Active exams on the platform.", enabled: true, mode: "LIVE", dynamicKey: "examsActive" },
        { id: "test-series", label: "Test Series", icon: "clipboardList", description: "Published mock test series.", enabled: true, mode: "LIVE", dynamicKey: "testSeriesCount" },
        { id: "question-bank", label: "Question Bank", icon: "bookOpen", description: "Questions in the question bank.", enabled: true, mode: "LIVE", dynamicKey: "questionBank" },
        { id: "registered-students", label: "Registered Students", icon: "users", description: "Students registered on the platform.", enabled: true, mode: "LIVE", dynamicKey: "registeredStudents" },
        { id: "active-students", label: "Active Students", icon: "userCheck", description: "Currently active student accounts.", enabled: false, mode: "LIVE", dynamicKey: "activeStudents" },
        { id: "mock-tests-attempted", label: "Mock Tests Attempted", icon: "checkCircle", description: "Mock test attempts submitted.", enabled: true, mode: "LIVE", dynamicKey: "mockTestsAttempted" },
        { id: "pyq-papers", label: "Previous Year Papers", icon: "fileText", description: "Previous year papers available.", enabled: true, mode: "LIVE", dynamicKey: "previousYearPapers" },
      ],
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
      description: "Join Mock Test Series.in and take your first mock test now.",
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
        ["Contact Us", "/contact"],
      ],
      copyrightOverride: "",
    },
  },
  CONTACT_INFO: {
    key: "CONTACT_INFO",
    label: "Contact / About / Legal",
    description:
      "About Us, Privacy Policy, and Terms & Conditions content shown on /contact, /privacy, /terms — Admin → Website → Homepage → Contact / About / Legal. Contact email and location live in the Footer section above (one canonical source for both the footer and the Contact page).",
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
      contactFormEnabled: true,
      growWithUsEnabled: true,
    },
  },
};