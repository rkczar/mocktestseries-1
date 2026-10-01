/**
 * Content for the homepage SEO / free-first redesign — shared by
 * scripts/publish-homepage-seo-redesign.ts (writes it through the draft →
 * publish flow). Plain data: section content, order and on/off state.
 * Exam-specific URLs are built from the exam's real public slug.
 */
import { DEFAULT_STAT_METRICS } from "@/lib/homepage-sections";
import type { HomepageSectionKey } from "@prisma/client";

export const REDESIGN_EXAM_CODE = "RUHSMO";

export const SEO = {
  title: "Mock Test Series – Medical Officer Mock Tests & RUHS MO PYQs",
  metaDescription:
    "Online mock tests for RUHS Medical Officer 2026 (Rajasthan MO): free mocks, previous year papers, subject-wise practice and AI explanations. Start free.",
};

export type Plan = { enabled: boolean; content?: Record<string, unknown>; references?: Record<string, unknown> };

export function plan(examId: string, slug: string): Record<HomepageSectionKey, Plan> {
  const hub = `/exams/${slug}`;
  return {
    HEADER: {
      enabled: true,
      content: {
        navItems: [
          ["Mock Tests", `${hub}/mock-test-series`],
          ["Previous Year Papers", `${hub}/previous-year-papers`],
          ["Try AI", "/#try-ai-now"],
          ["Exams", "/exams"],
        ],
        loginButtonText: "Login",
      },
    },
    HERO: {
      enabled: true,
      content: {
        eyebrow: "RUHS Medical Officer 2026 preparation is live",
        heading: "Online Mock Test Series for Medical Officer Exams",
        description:
          "Prepare for RUHS Medical Officer 2026 (Rajasthan MO) with exam-pattern mock tests, previous year papers, subject-wise practice and AI-powered explanations — all in one place.",
        primaryCtaText: "Start Free Practice",
        primaryCtaHref: "",
        secondaryCtaText: "Explore Tests",
        secondaryCtaHref: `${hub}/mock-test-series`,
        trustLine: "Start with free tests. Upgrade only when you need complete access.",
        showExamCard: true,
      },
    },
    STATISTICS: {
      enabled: true,
      content: {
        heading: "",
        subheading: "",
        background: "DEFAULT",
        showModeBadge: false,
        hideZeroLive: true,
        metrics: DEFAULT_STAT_METRICS,
      },
    },
    FREE_START: {
      enabled: true,
      content: {
        showFreeBadge: true,
        heading: "Start your RUHS MO preparation for free",
        description:
          "Everything below is free with a student account — no payment and no card details. Try the platform properly before you decide on complete access.",
        ctaText: "Start Free Practice",
        ctaHref: "",
        note: "No payment required to start.",
      },
      references: { examId },
    },
    FEATURED_EXAM: {
      enabled: true,
      content: {
        heading: "RUHS Medical Officer 2026",
        description:
          "Rajasthan University of Health Sciences (RUHS) conducts the Medical Officer recruitment exam for the Medical, Health & Family Welfare Department, Government of Rajasthan. Prepare for RUHS MO 2026 with mock tests built on the exam pattern, real previous year papers and subject-wise practice.",
        ctaText: "View RUHS MO 2026 exam details",
        ctaHref: "",
        secondaryCtaText: "",
        secondaryCtaHref: "",
        aiExplanationEnabled: false,
        showDeepLinks: true,
      },
      references: { examId },
    },
    PREVIOUS_YEAR_PAPERS: {
      enabled: true,
      content: {
        heading: "RUHS MO Previous Year Papers",
        description:
          "Attempt real RUHS Medical Officer papers online in a timed, exam-like format, then review every answer with explanations.",
        ctaText: "View all previous year papers",
        ctaHref: `${hub}/previous-year-papers`,
        maxCards: "",
      },
      references: { examId, paperIds: [] },
    },
    HOW_IT_WORKS: {
      enabled: true,
      content: {
        heading: "How Mock Test Series works",
        steps: [
          ["Create a free account", "Sign up in a minute — no payment needed to start practicing."],
          ["Take a timed test", "Attempt a mock test, previous year paper or subject-wise test, timed like the real exam."],
          ["Review every question", "See your score, the correct answers and a question-by-question analysis."],
          ["Learn and repeat", "Ask AI why an answer is right, revise your weak subjects and test yourself again."],
        ],
      },
    },
    AI_USP: {
      enabled: true,
      content: {
        heading: "Understand every answer with AI",
        description:
          "While you review a test, ask AI to explain any question: why the correct option is right, why the others are wrong, and how to remember it. Explanations are learning aids — confirm key facts with your standard textbooks.",
        features: [
          ["Ask AI on any question", "Get a clear, step-by-step explanation while you review your attempt."],
          ["Examiner traps", "See the common confusions an examiner tests, and how to avoid them."],
          ["AI question variants", "Practice the same concept asked in different ways."],
        ],
        ctaText: "",
        ctaHref: "",
      },
    },
    BENEFITS: {
      enabled: true,
      content: {
        heading: "What is Mock Test Series?",
        description:
          "Mock Test Series (mocktestseries.in) is an online exam-practice platform for medical officer recruitment exams. It brings realistic mock tests, previous year papers, focused subject practice and clear explanations into one place, so you can find your weak areas early and fix them before exam day.",
        features: [
          ["Exam-pattern mock tests", "Full-length and subject mocks with the timing and marking of the real exam, released on a published schedule."],
          ["Previous year papers online", "Real past papers you can attempt as a timed test instead of just reading a PDF."],
          ["Subject-wise practice", "Build tests by subject and topic to strengthen one area at a time."],
          ["Performance analysis", "Score, accuracy and subject-wise breakdown after every test, so you know what to revise next."],
          ["Question review and bookmarks", "Go through every question with its correct answer and save the ones you want to revisit."],
          ["Works on any device", "Practice on your phone, tablet or computer, right in the browser — no app to install."],
        ],
      },
    },
    MOCK_TEST_PROMOTION: {
      enabled: true,
      content: {
        eyebrow: "Complete Access",
        badge: "",
        numberMode: "LIVE",
        manualNumber: "",
        heading: "Unlock the Complete RUHS MO 2026 Test Series",
        description:
          "When you are ready for the full programme, Complete Access opens every mock test in the series as it is released — on top of everything that is already free.",
        ctaText: "Unlock Complete Series",
        ctaHref: `${hub}/mock-test-series`,
        compareText: "Compare Free vs Complete",
      },
    },
    EXAM_GUIDE: {
      enabled: true,
      content: {
        eyebrow: "Preparation guide",
        heading: "Preparing for RUHS Medical Officer 2026 with online mock tests",
        intro:
          "RUHS conducts the Medical Officer (MO) recruitment exam for posts in the Medical, Health & Family Welfare Department, Government of Rajasthan — which is why it is also searched as the Rajasthan Medical Officer exam or simply Rajasthan MO. Here is how to use Mock Test Series to prepare for it.",
        blocks: [
          [
            "Who the exam is for",
            "The exam is for MBBS doctors seeking Medical Officer posts in Rajasthan; the 2026 notification announced 600 posts. Eligibility, age limits and reservation rules are published by RUHS in the official information booklet.",
          ],
          [
            "Know the syllabus and pattern first",
            "RUHS MO questions have historically covered the whole MBBS curriculum — pre-clinical, para-clinical and clinical subjects. Start with the syllabus and exam pattern pages, then plan your revision subject by subject.",
          ],
          [
            "Start with previous year papers",
            "Previous year papers show the level of the exam and which topics come up again and again. Attempt them as timed tests rather than just reading them, and note every question you get wrong.",
          ],
          [
            "Use mock tests to build exam temperament",
            "Full-length mock tests train speed, accuracy and time management under exam conditions. Subject mocks help you close the gaps in one area before your next full mock.",
          ],
          [
            "Review, don't just score",
            "The real gain comes after the test: read the explanation for every wrong or guessed answer, bookmark difficult questions and revisit weak subjects in your next practice session.",
          ],
          [
            "Plan the final weeks",
            "Close to the exam, alternate full mocks with targeted subject practice and keep revising your bookmarked questions. Check the exam date and any official updates on the RUHS website regularly.",
          ],
        ],
        disclaimer:
          "Mock Test Series is an independent preparation platform. It is not affiliated with, endorsed by or connected to Rajasthan University of Health Sciences (RUHS) or the Government of Rajasthan. Always confirm notifications, eligibility, dates and the exam pattern on the official RUHS website.",
      },
      references: { examId },
    },
    FAQ: {
      enabled: true,
      content: {
        heading: "Frequently asked questions",
        structuredData: true,
        items: [
          [
            "What is Mock Test Series?",
            "Mock Test Series (mocktestseries.in) is an online exam-practice platform for medical officer recruitment exams. You can attempt timed mock tests in the exam pattern, practice previous year papers online, take subject-wise tests and review every question with AI-powered explanations. It currently focuses on RUHS Medical Officer 2026.",
          ],
          [
            "Can I start RUHS MO preparation for free?",
            "Yes. Create a free student account to attempt the free mock tests, practice RUHS MO previous year papers online, take subject-wise practice tests and use a daily allowance of AI explanations. No payment is needed to start.",
          ],
          [
            "Are RUHS Medical Officer previous year papers available?",
            "Yes. Previous year RUHS Medical Officer papers can be attempted online as timed tests, with your result, the correct answers and explanations afterwards. The Previous Year Papers page lists the years currently available.",
          ],
          [
            "Can I take RUHS MO mock tests online?",
            "Yes. Mock tests follow the RUHS MO exam pattern and run in your browser on mobile or desktop. They are released on a schedule, and the Mock Test Series page lists every test with its syllabus coverage and availability.",
          ],
          [
            "How does the AI explanation feature work?",
            "While reviewing a test, you can ask AI to explain a question — why the correct option is right and why the other options are wrong. Explanations are generated by AI as a learning aid. Free accounts get a daily allowance, and Complete Access includes a larger one.",
          ],
          [
            "What is included in the complete RUHS MO test series?",
            "Complete Access unlocks every mock test in the RUHS Medical Officer 2026 Mock Test Series as it is released, in addition to everything in the free plan. The current price, access period and a full Free vs Complete comparison are shown on the Mock Test Series page.",
          ],
          [
            "Can I use Mock Test Series on mobile?",
            "Yes. Mock Test Series works in any modern mobile browser, so you can practice on your phone, tablet or computer without installing an app.",
          ],
          [
            "Do I need to pay before trying the platform?",
            "No. You can register and practice with the free tests first, and upgrade only if you want complete access.",
          ],
          [
            "Is Mock Test Series the official RUHS website?",
            "No. Mock Test Series is an independent practice platform and is not affiliated with RUHS or the Government of Rajasthan. For official notifications, eligibility and exam dates, always refer to the official RUHS website.",
          ],
        ],
      },
    },
    CTA: {
      enabled: true,
      content: {
        heading: "Start preparing for RUHS MO 2026 today",
        description: "Create a free account, take your first mock test and see where you stand. Upgrade only if you need complete access.",
        buttonText: "Start Free Practice",
        buttonHref: "",
        secondaryButtonText: "View Mock Test Series",
        secondaryButtonHref: `${hub}/mock-test-series`,
      },
    },
    FOOTER: {
      enabled: true,
      content: {
        links: [
          ["RUHS Medical Officer 2026", hub],
          ["RUHS MO Mock Test Series", `${hub}/mock-test-series`],
          ["RUHS MO Previous Year Papers", `${hub}/previous-year-papers`],
          ["RUHS MO Syllabus", `${hub}/syllabus`],
          ["RUHS MO Exam Pattern", `${hub}/exam-pattern`],
          ["All Exams", "/exams"],
          ["Student Login", "/login"],
          ["Contact Us", "/contact"],
          ["Privacy Policy", "/privacy"],
          ["Terms and Conditions", "/terms"],
          ["Refund & Cancellation Policy", "/refund-policy"],
        ],
      },
    },
    CONTACT_INFO: { enabled: true },
    // Superseded: the hero exam card carries the date; Free Start + Complete Access cover the series.
    TEST_SERIES: { enabled: false },
    UPCOMING_EXAMS: { enabled: false },
  };
}

export const ORDER: HomepageSectionKey[] = [
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
  "EXAM_GUIDE",
  "FAQ",
  "CTA",
  "FOOTER",
  "CONTACT_INFO",
  "TEST_SERIES",
  "UPCOMING_EXAMS",
];
