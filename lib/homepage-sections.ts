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
  | "examSingle"
  | "examMulti"
  | "paperMulti"
  | "seriesMulti";

export interface SectionFieldDef {
  key: string;
  label: string;
  type: SectionFieldType;
  placeholder?: string;
  help?: string;
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
];

export const SECTION_META: Record<HomepageSectionKey, SectionMeta> = {
  HEADER: {
    key: "HEADER",
    label: "Header",
    description: "Logo, navigation, and login access — Admin → Website → Homepage → Header",
    fields: [
      { key: "logoText", label: "Logo text", type: "text" },
      { key: "navItems", label: "Navigation items (one per line: Label | /route)", type: "pairlist" },
      { key: "loginHref", label: "Student login link", type: "url" },
    ],
    defaultContent: {
      logoText: "Mock Test Series.in",
      navItems: [["Exams", "/#featured-exam"], ["Test Series", "/#test-series"]],
      loginHref: "/login",
    },
  },
  HERO: {
    key: "HERO",
    label: "Hero",
    description: "Main value proposition — Admin → Website → Homepage → Hero",
    fields: [
      { key: "eyebrow", label: "Eyebrow text", type: "text" },
      { key: "heading", label: "Main heading", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "primaryCtaText", label: "Primary CTA text", type: "text" },
      { key: "primaryCtaHref", label: "Primary CTA link", type: "url" },
      { key: "secondaryCtaText", label: "Secondary CTA text", type: "text" },
      { key: "secondaryCtaHref", label: "Secondary CTA link", type: "url" },
    ],
    defaultContent: {
      eyebrow: "RUHS Rajasthan Medical Officer Exam 2026",
      heading: "Prepare with confidence for the RUHS Medical Officer Exam",
      description:
        "Full-length mock tests, 10 years of previous year papers, and AI-powered explanations — everything you need in one platform.",
      primaryCtaText: "Start a Mock Test",
      primaryCtaHref: "/#test-series",
      secondaryCtaText: "Explore Previous Year Papers",
      secondaryCtaHref: "/#previous-year-papers",
    },
  },
  FEATURED_EXAM: {
    key: "FEATURED_EXAM",
    label: "Featured Exam",
    description: "Highlight one exam from Exam Management — Admin → Website → Homepage → Featured Exam",
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "ctaText", label: "Primary CTA text", type: "text" },
      { key: "secondaryCtaText", label: "Secondary CTA text", type: "text" },
      { key: "secondaryCtaHref", label: "Secondary CTA link", type: "url" },
      { key: "aiExplanationEnabled", label: "Show \"AI Explanations Available\" badge", type: "boolean" },
      { key: "examId", label: "Featured exam", type: "examSingle" },
    ],
    defaultContent: {
      title: "Featured Exam",
      description: "",
      ctaText: "Take Mock Test",
      secondaryCtaText: "Previous Year Papers",
      secondaryCtaHref: "#previous-year-papers",
      aiExplanationEnabled: true,
    },
  },
  MOCK_TEST_PROMOTION: {
    key: "MOCK_TEST_PROMOTION",
    label: "Mock Test Promotion",
    description: "Promote the core mock test product — Admin → Website → Homepage → Mock Test Promotion",
    fields: [
      { key: "badge", label: "Badge", type: "text" },
      { key: "numberDisplayed", label: "Number displayed (e.g. 50)", type: "text" },
      { key: "heading", label: "Heading", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "ctaText", label: "CTA text", type: "text" },
      { key: "ctaHref", label: "CTA link", type: "url" },
    ],
    defaultContent: {
      badge: "Most Popular",
      numberDisplayed: "50",
      heading: "50 Full-Length Mock Tests",
      description: "Exam-pattern mock tests covering every subject and topic.",
      ctaText: "Browse Mock Tests",
      ctaHref: "/#test-series",
    },
  },
  PREVIOUS_YEAR_PAPERS: {
    key: "PREVIOUS_YEAR_PAPERS",
    label: "Previous Year Papers",
    description: "Promote previous year papers — Admin → Website → Homepage → Previous Year Papers",
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "ctaText", label: "CTA text", type: "text" },
      { key: "ctaHref", label: "CTA link", type: "url" },
      { key: "paperIds", label: "Papers to feature", type: "paperMulti" },
    ],
    defaultContent: {
      heading: "10 Years of Previous Year Papers",
      description: "Practice with real exam papers from the last 10 years, in live-test format.",
      ctaText: "View Previous Year Papers",
      ctaHref: "/#previous-year-papers",
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
    ],
    defaultContent: {
      heading: "Learn faster with AI",
      description: "Every question comes with AI-generated explanations, memory tricks, and question variants.",
      features: [
        ["AI Explanations", "Understand why an answer is correct — and why the others aren't."],
        ["AI Question Variants", "Practice the same concept asked in different ways."],
      ],
    },
  },
  BENEFITS: {
    key: "BENEFITS",
    label: "Benefits",
    description: "Feature highlights — Admin → Website → Homepage → Benefits",
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "features", label: "Benefit cards (one per line: Title | Description)", type: "pairlist" },
    ],
    defaultContent: {
      heading: "Everything you need to crack the exam",
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
      { key: "steps", label: "Steps (one per line)", type: "list" },
    ],
    defaultContent: {
      heading: "How it works",
      steps: [
        "Choose Exam",
        "Choose Test",
        "Attempt Test",
        "View Result",
        "Analyze Performance",
        "Use AI Explanation",
        "Practice Again",
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
    description: "Test series from Exam Management — Admin → Website → Homepage → Test Series",
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "ctaText", label: "CTA text", type: "text" },
      { key: "testSeriesIds", label: "Test series to show", type: "seriesMulti" },
    ],
    defaultContent: { heading: "Test Series", description: "", ctaText: "Start Now" },
  },
  STATISTICS: {
    key: "STATISTICS",
    label: "Platform Statistics",
    description: "Trust-building numbers — Admin → Website → Homepage → Platform Statistics",
    fields: [
      { key: "heading", label: "Heading", type: "text" },
      { key: "showModeBadge", label: "Publicly show a Live/Demo/Manual tag on each card", type: "boolean" },
      { key: "metrics", label: "Cards", type: "statistics" },
    ],
    defaultContent: {
      heading: "Trusted by aspirants across Rajasthan",
      showModeBadge: false,
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
      { key: "buttonText", label: "Button text", type: "text" },
      { key: "buttonHref", label: "Button link", type: "url" },
    ],
    defaultContent: {
      heading: "Start Your Preparation Today",
      description: "Join Mock Test Series.in and take your first mock test now.",
      buttonText: "Start a Mock Test",
      buttonHref: "/#test-series",
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
    ],
    defaultContent: {
      email: "support@mocktestseries.in",
      location: "Rajasthan, India",
      instagramUrl: "",
      links: [
        ["Student Login", "/login"],
        ["Privacy Policy", "/privacy"],
        ["Terms and Conditions", "/terms"],
        ["Contact Us", "/contact"],
      ],
    },
  },
};
