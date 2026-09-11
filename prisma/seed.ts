import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.homepageContent.deleteMany();
  await prisma.homepageContent.create({
    data: {
      heroEyebrow: "AI-Powered Exam Preparation",
      heroHeading: "Practice Smart.\nUnderstand Every Answer.",
      heroDescription:
        "Take timed, exam-realistic mock tests for India's top competitive and recruitment exams, then get a full AI explanation on every single question.",
      finalCtaHeading: "Take your first mock test today",
      finalCtaBody:
        "No card required. Start with a free mock test and see exactly how AI explanations help you learn faster.",
      finalCtaNote: "Free mock test · No credit card required",
    },
  });

  const sections: {
    key: string;
    title?: string;
    eyebrow?: string;
    order: number;
  }[] = [
    { key: "hero", order: 0 },
    { key: "trust", order: 1 },
    {
      key: "featured_exams",
      eyebrow: "Featured Exams",
      title: "Start with the exam you are preparing for",
      order: 2,
    },
    {
      key: "popular_series",
      title: "Three ways to practice",
      order: 3,
    },
    {
      key: "ai_usp",
      eyebrow: "The AI difference",
      title: "Every question comes with a full explanation",
      order: 4,
    },
    { key: "why_us", title: "Why MockTestSeries.in", order: 5 },
    { key: "how_it_works", title: "How It Works", order: 6 },
    { key: "upcoming", title: "Know what is next", order: 7 },
    { key: "final_cta", order: 8 },
  ];
  for (const section of sections) {
    await prisma.homepageSection.upsert({
      where: { key: section.key },
      update: section,
      create: section,
    });
  }

  const ctaButtons: {
    slot: string;
    label: string;
    href: string;
    variant: string;
  }[] = [
    { slot: "header_primary", label: "Start Free", href: "/student/register", variant: "primary" },
    {
      slot: "hero_primary",
      label: "Start Free Mock Test",
      href: "/student/register",
      variant: "primary",
    },
    { slot: "hero_secondary", label: "Browse Exams", href: "/exams", variant: "secondary" },
    {
      slot: "final_primary",
      label: "Start Free Mock Test",
      href: "/student/register",
      variant: "accent",
    },
    { slot: "final_secondary", label: "View Pricing", href: "/pricing", variant: "ghost" },
  ];
  for (const button of ctaButtons) {
    await prisma.ctaButton.upsert({
      where: { slot: button.slot },
      update: button,
      create: button,
    });
  }

  await prisma.announcement.deleteMany();
  await prisma.announcement.create({
    data: {
      tag: "New",
      message:
        "RUHS Medical Officer 2026 test series is live — AI explanations on every question.",
      linkLabel: "View exam",
      linkHref: "/exams/ruhs-medical-officer-2026",
      isActive: true,
    },
  });

  await prisma.testSeries.deleteMany();
  await prisma.exam.deleteMany();
  const exam = await prisma.exam.create({
    data: {
      slug: "ruhs-medical-officer-2026",
      title: "RUHS Medical Officer 2026",
      shortTitle: "RUHS Medical Officer",
      description:
        "Full-syllabus mock tests for the RUHS Medical Officer 2026 recruitment exam, with AI explanations on every question.",
      status: "ACTIVE",
      isFeatured: true,
      order: 0,
      region: "Rajasthan",
      metaChips: ["100 Q · 90 min", "12 mock tests", "AI explanations"],
      testSeries: {
        create: [
          {
            slug: "ruhs-medical-officer-2026-full-mock",
            kind: "FULL_MOCK",
            title: "Full Mock Tests",
            description: "12 full-length mock tests matching the real exam pattern.",
            metaLabel: "12 tests · 100 Q each",
            isPopular: true,
            order: 0,
          },
          {
            slug: "ruhs-medical-officer-2026-previous-year",
            kind: "PREVIOUS_YEAR",
            title: "Previous Year Papers",
            description: "Solve actual papers from past RUHS Medical Officer exams.",
            metaLabel: "2019 – 2025",
            isPopular: true,
            order: 1,
          },
          {
            slug: "ruhs-medical-officer-2026-subject-wise",
            kind: "SUBJECT_WISE",
            title: "Subject-wise Practice",
            description: "Drill individual subjects until every weak topic is gone.",
            metaLabel: "19 subjects",
            isPopular: true,
            order: 2,
          },
        ],
      },
    },
  });

  await prisma.upcomingExam.deleteMany();
  await prisma.upcomingExam.createMany({
    data: [
      {
        title: "RUHS Staff Nurse 2026",
        subtitle: "Rajasthan University of Health Sciences",
        dateLabel: "Feb 2026",
        region: "Rajasthan",
        status: "Notification out",
        statusTone: "success",
        actionLabel: "Get notified",
        actionHref: "/upcoming-exams",
        examId: exam.id,
        order: 0,
      },
      {
        title: "SSC CGL 2026",
        subtitle: "Staff Selection Commission",
        dateLabel: "Expected Apr 2026",
        region: "All India",
        status: "Expected",
        statusTone: "accent",
        actionLabel: "Get notified",
        actionHref: "/upcoming-exams",
        order: 1,
      },
    ],
  });

  await prisma.pricingPlan.deleteMany();
  await prisma.pricingPlan.createMany({
    data: [
      {
        name: "Free",
        priceInPaise: 0,
        period: "forever",
        description: "Try the platform with one full mock test per exam.",
        features: [
          "1 free mock test per exam",
          "AI explanation on every question",
          "Basic performance summary",
        ],
        isPopular: false,
        order: 0,
        ctaLabel: "Start Free",
      },
      {
        name: "Full Access",
        priceInPaise: 49900,
        period: "one-time",
        description: "Unlock every mock test, previous year paper and subject-wise set for one exam.",
        features: [
          "All mock tests for the exam",
          "All previous year papers",
          "Subject-wise practice sets",
          "AI explanation on every question",
          "Full performance analytics & weak-topic detection",
        ],
        isPopular: true,
        order: 1,
        ctaLabel: "Get Full Access",
      },
    ],
  });

  console.log("Seed complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
