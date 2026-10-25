import type { TemplateScene } from "@/lib/video-studio/template";

/**
 * Curated sample scenes for design previews (free: rendered by the admin's
 * own browser from the shared template, never by a paid call). Medical
 * content here is standard textbook material, written by hand.
 */
export const SAMPLE_SCENES: { key: string; label: string; scene: TemplateScene }[] = [
  {
    key: "hook",
    label: "Hook",
    scene: {
      narration: "Chest pain के बाद सबसे पहले कौन सा cardiac marker बढ़ता है? ये exam में बार-बार पूछा जाता है।",
      onScreenText: "पहला cardiac marker?",
      visual: { kind: "title", title: "हृदयाघात (Myocardial Infarction)", subtitle: "सबसे पहले कौन सा marker बढ़ता है?" },
      durationSec: 5,
    },
  },
  {
    key: "bullets",
    label: "Key points",
    scene: {
      narration: "Myoglobin सबसे पहले बढ़ता है, लेकिन specific नहीं है। Troponin I और T सबसे specific markers हैं।",
      onScreenText: "Markers का क्रम",
      visual: { kind: "bullets", title: "Cardiac markers", items: ["Myoglobin: 1–3 घंटे", "Troponin I / T: सबसे specific", "CK-MB: re-infarction"] },
      durationSec: 6,
    },
  },
  {
    key: "diagram",
    label: "Diagram",
    scene: {
      narration: "Plaque rupture से thrombus बनता है, coronary artery block होती है, और myocardium ischemic हो जाता है।",
      onScreenText: "Pathogenesis",
      visual: { kind: "diagram", title: "Pathogenesis", nodes: ["Plaque rupture", "Thrombus formation", "Coronary occlusion", "Myocardial necrosis"] },
      durationSec: 6,
    },
  },
  {
    key: "question",
    label: "MCQ",
    scene: {
      narration: "Option B, Troponin I, सबसे specific marker है।",
      onScreenText: "सही उत्तर?",
      visual: {
        kind: "question",
        stem: "Most specific marker of myocardial injury:",
        options: [
          { label: "A", text: "Myoglobin" },
          { label: "B", text: "Troponin I" },
          { label: "C", text: "LDH" },
          { label: "D", text: "AST" },
        ],
        correctLabel: "B",
        revealAtSec: 2.5,
      },
      durationSec: 5,
    },
  },
  {
    key: "cta",
    label: "Call to action",
    scene: { narration: "ऐसे ही high-yield questions practice करें MockTestSeries.in पर।", onScreenText: "Practice now", visual: { kind: "cta", title: "रोज़ practice करें", subtitle: "MockTestSeries.in" }, durationSec: 4 },
  },
];
