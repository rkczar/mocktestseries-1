/**
 * Instagram Studio exam scope (pure, client + server safe).
 *
 * The studio is for MBBS-level and post-MBBS medical competitive exams only:
 * FMGE, NEET PG, INI-CET, AIIMS medical recruitment, UPSC CMS, RUHS / Haryana
 * / Punjab / other State Medical Officer exams, plus any exam a Master Admin
 * adds later. NEET UG and school-level entrance preparation are always
 * excluded here — this only scopes the studio; NEET UG data elsewhere on the
 * platform is untouched.
 */

/** NEET UG / school-level wording, anywhere (exam names, captions, hashtags, keywords). */
export const EXCLUDED_TERMS = /\bneet[\s_-]*ug\b|#?neetug\b|\bneet[\s_-]*20\d\d\b|\bncert\b|\bclass\s*1[12]\b|\bboard\s+exams?\b|\baiims\s+mbbs\s+entrance\b|\bjee\b/i;

/** True for exams the studio must never use (NEET UG, school level). */
export function isExcludedExam(name: string, code?: string | null): boolean {
  const t = `${name} ${code ?? ""}`;
  return /\bneet[\s_-]*ug\b|\bneetug\b|\bnursing\s+entrance\b|\bclass\s*1[12]\b/i.test(t);
}

/** Exams in scope by default (name/code match). A Master Admin can add others or remove these. */
export function isDefaultEligible(name: string, code?: string | null): boolean {
  if (isExcludedExam(name, code)) return false;
  const t = `${name} ${code ?? ""}`;
  return /\bfmge\b|\bneet[\s_-]*pg\b|\bini[\s_-]*cet\b|\baiims\b|\bupsc\b.*\bcms\b|\bcms\b|medical\s+officer|\b[a-z]{2,8}[\s_-]+mo\b|\bmo\s+exam\b|\bnext\b.*\bexam\b/i.test(t);
}

export interface ExamProfile {
  key: string;
  label: string;
  /** How questions in this exam read — fed to the AI so variants/captions match the exam. */
  style: string;
  difficulty: string;
  keywords: string[];
  hashtags: string[];
}

const PROFILES: { match: RegExp; profile: ExamProfile }[] = [
  {
    match: /\bfmge\b/i,
    profile: {
      key: "FMGE",
      label: "FMGE",
      style: "Direct one-liner recall and short clinical scenarios across all 19 subjects; standard textbook facts; frequently image-free factual MCQs.",
      difficulty: "moderate",
      keywords: ["FMGE", "FMGE preparation", "foreign medical graduate", "MCI screening"],
      hashtags: ["#FMGE", "#FMGEPreparation", "#FMGEMCQ"],
    },
  },
  {
    match: /\bneet[\s_-]*pg\b|\bnext\b/i,
    profile: {
      key: "NEET_PG",
      label: "NEET PG",
      style: "Clinical vignette MCQs testing application and next best step; recent guideline-based management; two-step reasoning.",
      difficulty: "moderate to high",
      keywords: ["NEET PG", "NEET PG preparation", "PG entrance", "clinical MCQ"],
      hashtags: ["#NEETPG", "#NEETPGPreparation", "#NEETPGMCQ"],
    },
  },
  {
    match: /\bini[\s_-]*cet\b|\baiims\b/i,
    profile: {
      key: "INI_CET",
      label: "INI-CET / AIIMS",
      style: "Conceptual, often tricky clinical questions; recent advances; fine distinctions between close options; AIIMS-style multi-step reasoning.",
      difficulty: "high",
      keywords: ["INI-CET", "AIIMS", "INICET preparation"],
      hashtags: ["#INICET", "#AIIMS", "#INICETPreparation"],
    },
  },
  {
    match: /\bcms\b|\bupsc\b/i,
    profile: {
      key: "UPSC_CMS",
      label: "UPSC CMS",
      style: "Factual standard-textbook questions across General Medicine, Paediatrics, Surgery, OBG and PSM; national health programmes.",
      difficulty: "moderate",
      keywords: ["UPSC CMS", "Combined Medical Services", "CMS preparation"],
      hashtags: ["#UPSCCMS", "#CMSPreparation"],
    },
  },
  {
    match: /medical\s+officer|\bmo\b/i,
    profile: {
      key: "STATE_MO",
      label: "State Medical Officer",
      style: "State PSC / health-university Medical Officer pattern: factual recall, clinical basics, PSM and national health programmes, previous-paper style.",
      difficulty: "moderate",
      keywords: ["Medical Officer exam", "MO exam preparation", "state MO PYQ"],
      hashtags: ["#MedicalOfficer", "#MOExam", "#MedicalOfficerExam"],
    },
  },
];

const GENERIC: ExamProfile = {
  key: "MEDICAL",
  label: "Medical competitive exams",
  style: "MBBS-level clinical and factual MCQs, standard textbook facts.",
  difficulty: "moderate",
  keywords: ["medical exam preparation", "MBBS MCQ"],
  hashtags: ["#MedicalMCQ", "#MBBS"],
};

export function examProfile(name: string, code?: string | null): ExamProfile {
  const t = `${name} ${code ?? ""}`;
  return PROFILES.find((p) => p.match.test(t))?.profile ?? GENERIC;
}

/** Removes NEET UG / school-level hashtags and keywords. */
export function stripExcluded(list: string[]): string[] {
  return list.filter((x) => !EXCLUDED_TERMS.test(x));
}
