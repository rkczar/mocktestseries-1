/**
 * Hand-written editorial pages that only some exams have (keyed by Exam.code). An exam without an
 * entry gets a 404 on these routes, so adding a page for one exam never creates a thin page for
 * another (RUHS MO has none). Every statement is transcribed from the cited official document;
 * nothing is forecast. Rajasthan FSO (RPSC): checked against RPSC's documents on 2026-11-12.
 */

export interface EditorialBlock {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  /** Verbatim text from the official document, shown as a quotation. */
  quote?: string[];
}

export interface EditorialPage {
  title: string;
  metaTitle: string;
  metaDescription: string;
  intro: string;
  blocks: EditorialBlock[];
  sources: { label: string; url: string }[];
  checkedOn: string;
}

const RPSC = "https://rpsc.rajasthan.gov.in";
const ADVT_2022 = { label: "RPSC Detailed Advertisement No. 11/2022-23 (21-10-2022)", url: `${RPSC}/Static/RecruitmentAdvertisements/AEF2AEAF0A7645B785B846E207D99386.pdf` };
const ADVT_2019 = { label: "RPSC Advertisement No. 04/2019-20 (05-08-2019)", url: `${RPSC}/Static/RecruitmentAdvertisements/69A75E0E09D2489B8AAA118769D4EE82.pdf` };

export type EditorialPageKey = "eligibility" | "recruitment" | "preparation-strategy";

const PAGES: Record<string, Partial<Record<EditorialPageKey, EditorialPage>>> = {
  "RUHS-FSO": {
    eligibility: {
      title: "Rajasthan FSO Eligibility and Qualification",
      metaTitle: "RPSC FSO Eligibility, Qualification & Age Limit (Advt 2022)",
      metaDescription:
        "RPSC Food Safety Officer eligibility from the last advertisement (No. 11/2022-23): required degree, Hindi and Rajasthan culture, age 18–40 and Pay Level L-11.",
      intro:
        "These are the eligibility conditions of the latest RPSC Food Safety Officer advertisement, No. 11/2022-23 dated 21-10-2022. RPSC has not published a newer FSO advertisement; a future one may change any of these conditions, so always check the advertisement you apply under.",
      blocks: [
        {
          heading: "Educational qualification",
          quote: [
            "1. (i) A degree in Food Technology or Dairy technology or Biotechnology or Oil Technology or Agriculture Science or Veterinary Sciences or Bio-Chemistry or Microbiology or Masters Degree in Chemistry or Degree in Medicine from a recognized University. or any other equivalent/recognized qualification notified by the Central Government; and",
            "(ii) has successfully completed training as specified by the Food Authority in a recognized institute or institution approved for the purpose: (Note:- There is no requirement for training prior to selection. This training shall be provided to the selected candidates during probation period.)",
            "Provided that no person who has any financial interest in the manufacture, import or sale of any article of food shall be appointed to be a Food Safety Officer under these rules.",
            "2. Working knowledge of Hindi written in Devnagari Script and knowledge of Rajasthan Culture.",
          ],
          paragraphs: [
            "Final-year students: the advertisement allows a candidate who has appeared, or is appearing, in the final-year examination of the required qualification to apply, but proof of the qualification must be given before the competitive examination held by RPSC.",
          ],
        },
        {
          heading: "Age limit",
          bullets: [
            "Minimum 18 years and below 40 years, counted on 01-01-2023 (Advertisement No. 11/2022-23).",
            "The advertisement lists category-wise relaxations of the upper age limit (for example, no upper age limit for widow and divorced women). Read the full list in the advertisement before applying.",
          ],
        },
        {
          heading: "Pay",
          bullets: ["Pay Matrix Level L-11 (Grade Pay 4200), with fixed monthly pay during probation as per State Government rules."],
        },
      ],
      sources: [ADVT_2022],
      checkedOn: "12 November 2026",
    },
    recruitment: {
      title: "Rajasthan FSO Recruitment: Past Cycles and Current Status",
      metaTitle: "RPSC FSO Recruitment: 2019 & 2022 Cycles, Posts and Status",
      metaDescription:
        "RPSC Food Safety Officer recruitment history from official notices: Advt 2019 (98 posts) and Advt 2022 (200 posts), exam dates, answer keys and current status.",
      intro:
        "Food Safety Officer posts of the Rajasthan Medical and Health Services Department are filled by the Rajasthan Public Service Commission (RPSC), Ajmer. RPSC has run two FSO recruitment cycles. This page lists only what RPSC has published.",
      blocks: [
        {
          heading: "Current status",
          paragraphs: [
            "As of 12 November 2026, RPSC has not published a new Food Safety Officer advertisement after Advertisement No. 11/2022-23 (21-10-2022), and no FSO exam date is listed by RPSC. News reports of new posts are not an RPSC notification; wait for the advertisement on rpsc.rajasthan.gov.in.",
          ],
        },
        {
          heading: "FSO 2022 (Advertisement No. 11/2022-23)",
          bullets: [
            "Advertisement dated 21-10-2022: 200 posts.",
            "Competitive examination held on 27-06-2023: one paper, 150 questions, 150 marks, 2 hours 30 minutes — Part A General Knowledge of Rajasthan (40) and Part B Concerned Subject (110).",
            "Negative marking: one-third of the marks of a question for each wrong answer (an incorrect answer or more than one answer).",
            "Final answer key published 29-07-2024; questions 16, 43, 50, 72, 106 and 130 deleted.",
          ],
        },
        {
          heading: "FSO 2019 (Advertisement No. 04/2019-20)",
          bullets: [
            "Advertisement dated 05-08-2019: 98 posts (89 Non-TSP + 9 TSP).",
            "Selection by interview, with an objective screening test held on 25-11-2019: 150 questions, 150 marks, 3 hours, one-third negative marking.",
            "Model answer key issued 20-12-2019; question 71 deleted. RPSC lists no final key for 2019.",
          ],
        },
      ],
      sources: [ADVT_2022, ADVT_2019, { label: "RPSC website", url: `${RPSC}/` }],
      checkedOn: "12 November 2026",
    },
    // Hand-written: FSO has two past papers, below the data-driven strategy page's 3-paper gate.
    "preparation-strategy": {
      title: "How to Prepare for Rajasthan FSO",
      metaTitle: "How to Prepare for RPSC FSO: Study Plan from Past Papers",
      metaDescription:
        "An RPSC Food Safety Officer study plan based on the official exam pattern, syllabus and the 2019 and 2022 papers: what to study first and how to practise.",
      intro:
        "This plan is built on what RPSC has published: the exam pattern and negative marking of the 2022 examination, the syllabus subjects, and the two past papers (2019 and 2022). RPSC has not announced a new FSO examination yet, so use the time to cover the syllabus fully and practise with past papers.",
      blocks: [
        {
          heading: "1. Know the paper",
          bullets: [
            "2022 examination: one paper, 150 questions, 150 marks, 2 hours 30 minutes.",
            "Part A, General Knowledge of Rajasthan: 40 questions. Part B, Concerned Subject: 110 questions.",
            "One-third of a question's marks is deducted for each wrong answer (an incorrect answer or more than one answer), so skip questions you cannot narrow down.",
          ],
        },
        {
          heading: "2. Cover the Part B subjects first",
          paragraphs: [
            "Part B carries 110 of the 150 marks. Its syllabus covers chemistry, food microbiology and fermentation, biochemistry, nutrition and toxicology, biology and human physiology, biotechnology and statistics, agriculture with reference to Rajasthan, livestock and dairy, and food technology, food laws and hygiene.",
            "Start with the subjects closest to your degree, then fill the gaps. Food laws and hygiene (the Food Safety and Standards Act and its regulations) is common to every background and worth reading from the official text.",
          ],
        },
        {
          heading: "3. Prepare Part A alongside",
          paragraphs: [
            "Part A is 40 questions on Rajasthan: history, culture and heritage; geography, natural resources and socio-economic development; and current events of Rajasthan and India. Give it a fixed daily slot rather than leaving it to the end, and keep current-affairs notes from now until the exam.",
          ],
        },
        {
          heading: "4. Use the past papers",
          bullets: [
            "Attempt the 2019 and 2022 papers under time, then review every wrong and skipped question.",
            "Use the Important Topics page to see which syllabus areas the two papers asked about most. With only two papers, treat it as a guide, not a forecast.",
            "Practise subject-wise from the question bank for the subjects where you lose most marks.",
          ],
        },
        {
          heading: "5. Before the exam",
          bullets: [
            "Read the new RPSC advertisement as soon as it is published: the pattern, syllabus or eligibility can change.",
            "Practise filling an OMR sheet within the time limit.",
            "In the last weeks, revise your notes and re-attempt the past papers instead of starting new material.",
          ],
        },
      ],
      sources: [ADVT_2022, { label: "RPSC website", url: `${RPSC}/` }],
      checkedOn: "14 November 2026",
    },
  },
};

export function getEditorialPage(examCode: string, key: EditorialPageKey): EditorialPage | null {
  return PAGES[examCode]?.[key] ?? null;
}

/** Exams that publish the data-driven Important Topics page (RUHS MO's stays on hold). */
const IMPORTANT_TOPICS_EXAMS = new Set<string>(["RUHS-FSO"]);

export function hasImportantTopicsPage(examCode: string): boolean {
  return IMPORTANT_TOPICS_EXAMS.has(examCode);
}

/** Extra sitemap paths for an exam's editorial pages (only those it has). */
export function editorialPagePaths(examCode: string): string[] {
  return [
    ...(Object.keys(PAGES[examCode] ?? {}) as EditorialPageKey[]),
    ...(hasImportantTopicsPage(examCode) ? ["important-topics"] : []),
  ];
}
