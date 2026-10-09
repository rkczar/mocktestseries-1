import type { StudioSettings } from "@/lib/instagram/config";
import type { RenderInput } from "@/lib/instagram/render";
import { defaultDesign, emptyContent } from "@/lib/instagram/types";

/**
 * A SYNTHETIC sample carousel (not a Question Bank question) used by
 * Admin -> Instagram -> Templates & Branding previews and by
 * scripts/ig-studio-render-samples.ts. Clearly fictional ids; never stored.
 */
export const SAMPLE_SETTINGS: StudioSettings = {
  instagramHandle: "mocktestseries.in",
  instagramSource: "footer",
  telegramUrl: "https://t.me/mocktestseries",
  telegramSource: "website",
  telegramName: "Telegram Channel",
  websiteUrl: "https://mocktestseries.in",
  websiteLabel: "mocktestseries.in",
  ctaHeadline: "Daily PYQs & Medical MCQs",
  ctaDescription: "Follow for one high-yield previous year question every day.",
  footerText: "Practice full mock tests at",
  showInstagram: true,
  showTelegram: true,
  showWebsite: true,
  showSaveShare: true,
  defaultTemplate: "midnight",
  defaultSlideCount: 5,
  defaultHashtags: [],
  examBadges: {},
  updatedAt: null,
};

export const SAMPLE_INPUT: RenderInput = {
  snapshot: {
    questionId: "sample",
    code: "SAMPLE-W03",
    text: "Drug of choice for the treatment of absence seizures in a 7-year-old child is:",
    contentFormat: "PLAIN",
    questionType: "SINGLE_CORRECT",
    options: [
      { label: "A", text: "Phenytoin", isCorrect: false },
      { label: "B", text: "Ethosuximide", isCorrect: true },
      { label: "C", text: "Carbamazepine", isCorrect: false },
      { label: "D", text: "Phenobarbitone", isCorrect: false },
    ],
    examId: "exam",
    examName: "RUHS MO",
    examCode: "RUHS-MO",
    paperId: "paper",
    paperTitle: "RUHS MO 2021",
    paperYear: 2021,
    paperCode: null,
    paperSharesYear: false,
    importPosition: 3,
    subjectName: "Pharmacology",
    topicName: "Antiepileptics",
    hasImages: false,
    status: "PUBLISHED",
    reviewRequired: false,
    reviewReason: null,
    aiExplanation: null,
    capturedAt: new Date().toISOString(),
  },
  content: {
    ...emptyContent(),
    hooks: [{ style: "curiosity", text: "Can You Solve This RUHS MO PYQ?" }],
    hookText: "Can You Solve This RUHS MO PYQ?",
    explanation:
      "Ethosuximide blocks T-type calcium channels in thalamic neurons, which generate the 3 Hz spike-and-wave rhythm of absence seizures. Phenytoin and carbamazepine can worsen absence seizures.",
    memoryTrick: "ETHOsuximide for absence: \"ETHO = Empty THOughts\" — the child just stares blankly.",
    clinicalPearl: "Valproate is preferred when absence seizures co-exist with generalized tonic-clonic seizures.",
    quickRevision: ["T-type calcium channel blocker", "EEG: 3 Hz spike-and-wave", "Avoid carbamazepine and phenytoin"],
    finalTrick: "Absence = Ethosuximide; mixed generalized = Valproate.",
    showFinalTrick: true,
    caption: "Can you solve this RUHS MO PYQ?",
  },
  design: defaultDesign(),
  series: "PYQ",
  seriesStats: null,
  questionNumber: 12,
  questionNumberVerified: true,
  settings: SAMPLE_SETTINGS,
};

/** The sample with the studio's real configured settings (handle, Telegram, CTA texts). */
export function sampleWith(settings: StudioSettings, design = defaultDesign()): RenderInput {
  return { ...SAMPLE_INPUT, settings, design };
}
