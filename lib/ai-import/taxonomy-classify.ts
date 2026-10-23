/**
 * Free, local subject / topic / subtopic classification of imported questions against the SELECTED exam's own
 * database taxonomy (pure: no I/O, no AI — the regression suite exercises it directly, and Verify 1 uses it).
 *
 * Each topic of the exam gets a term profile built from:
 *   - its own name and syllabus description (and its subject's),
 *   - a built-in list of common terminology / abbreviations for well-known topic names (used only when a topic with
 *     that kind of name exists in this exam — nothing is ever added to the taxonomy),
 *   - the exam's taxonomy memory: administrator-added synonyms and administrator-confirmed classifications,
 *   - reviewed (published) Question Bank questions filed under that same topic (evidence of how the topic is asked).
 * A question (stem, numbered statements, match lists, options, clinical context) is scored against every profile
 * (BM25 over words and word pairs). The best subject and topic are kept only when the evidence is strong AND clearly
 * ahead of the next choice; otherwise the question is left unresolved with the reason (never forced). Returned ids are
 * always ids of the given taxonomy — an id of another exam cannot come out of here.
 */
import type { ExamTaxonomySubject } from "@/lib/exam-taxonomy";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

/** A topic is assigned only at or above this confidence (the importer's own topicMinConfidence decides the flag). */
export const LOCAL_TOPIC_MIN = 0.55;
/** A subject is assigned only at or above this confidence (same floor as the AI classifier). */
export const LOCAL_SUBJECT_MIN = 0.6;
/** A stored administrator-confirmed question this similar (word sets) gives its mapping directly. */
export const CONFIRMED_MATCH_AT = 0.8;

/** Weight of one reviewed question's term in its topic's profile. */
const EVIDENCE_WEIGHT = 0.6;

export interface TaxonomyEvidence {
  topicId: string;
  text: string;
}

/** What the exam's taxonomy memory contributes (lib/ai-import/taxonomy-memory.ts); every id is checked again here. */
export interface ClassifierMemory {
  synonyms: { term: string; subjectId: string | null; topicId: string | null }[];
  confusions: { a: string; b: string; note: string | null }[];
  corrections: { id: string; text: string; subjectId: string; topicId: string | null; subTopicId: string | null }[];
}

export type LocalStatus = "CLASSIFIED" | "SUBJECT_ONLY" | "UNCERTAIN" | "INSUFFICIENT_TEXT" | "NO_TAXONOMY";

export interface LocalClassification {
  status: LocalStatus;
  subjectId: string | null;
  topicId: string | null;
  subTopicId: string | null;
  subjectConfidence: number;
  topicConfidence: number;
  /** "confirmed example" (an administrator-confirmed question of this exam) or "local terms". */
  method: "confirmed example" | "local terms";
  /** The words that decided it (most important first). */
  matched: string[];
  /** Plain explanation, shown on the question. */
  reason: string;
  /** Best alternatives (subject, topic, score) — shown when uncertain. */
  candidates: { subjectId: string; topicId: string | null; score: number }[];
  /** A neighbouring subject this one is commonly confused with, when it was close. */
  confusedWith: string | null;
  /** Best subjects with their scores (how far a stored subject is behind the best one). */
  subjectScores?: { subjectId: string; score: number }[];
}

// ---- Text ------------------------------------------------------------------------------------------------

const STOP = new Set(
  (
    "the a an of and or is are was were be been to in on at for by with from as that this these those which what who whom whose when where why how " +
    "following given below above statement statements correct incorrect true false option options answer select code codes choose using use used " +
    "except all most least none both only neither nor not also than then there their its it his her he she they them may can could would should will shall " +
    "patient patients year years old presents presented presenting history case likely diagnosis probable common commonly usually best seen found " +
    "consider considered regarding about into under over after before during between among other others such one two three four five first second third " +
    "list match pair pairs matched assertion reason explanation has have had does did done being any each every many much more less very " +
    "disease diseases disorder disorders condition conditions feature features clinical sign signs symptom symptoms management treatment treated cause causes caused " +
    "i ii iii iv v vi vii viii ix x a b c d e"
  ).split(" ")
);

/** Common abbreviations → their words (appended, the abbreviation itself stays). Only unambiguous, exam-neutral ones. */
const ABBREVIATIONS: Record<string, string> = {
  MI: "myocardial infarction", ACS: "acute coronary syndrome", CHF: "congestive heart failure", ECG: "electrocardiogram", EKG: "electrocardiogram", JVP: "jugular venous pressure",
  COPD: "chronic obstructive pulmonary disease", ARDS: "acute respiratory distress syndrome", TB: "tuberculosis", PFT: "pulmonary function test", DVT: "deep vein thrombosis",
  CKD: "chronic kidney disease", AKI: "acute kidney injury", GFR: "glomerular filtration rate", RTA: "renal tubular acidosis", UTI: "urinary tract infection",
  DKA: "diabetic ketoacidosis", HbA1c: "glycated hemoglobin diabetes", TSH: "thyroid stimulating hormone", SIADH: "inappropriate antidiuretic hormone",
  SLE: "systemic lupus erythematosus", RA: "rheumatoid arthritis", ANA: "antinuclear antibody", HLA: "human leukocyte antigen",
  ITP: "immune thrombocytopenic purpura", DIC: "disseminated intravascular coagulation", G6PD: "glucose 6 phosphate dehydrogenase", CML: "chronic myeloid leukemia", AML: "acute myeloid leukemia", CLL: "chronic lymphocytic leukemia",
  GERD: "gastroesophageal reflux", IBD: "inflammatory bowel disease", IBS: "irritable bowel syndrome", HBV: "hepatitis b virus", HCV: "hepatitis c virus", HBsAg: "hepatitis b surface antigen",
  HIV: "human immunodeficiency virus", AIDS: "acquired immunodeficiency", CSF: "cerebrospinal fluid", CNS: "central nervous system", GBS: "guillain barre",
  CVA: "stroke cerebrovascular", TIA: "transient ischemic attack", EEG: "electroencephalogram", MRI: "magnetic resonance imaging", CT: "computed tomography",
  ADHD: "attention deficit hyperactivity", OCD: "obsessive compulsive disorder", PTSD: "post traumatic stress disorder", ECT: "electroconvulsive therapy", SSRI: "selective serotonin reuptake inhibitor",
  VSD: "ventricular septal defect", PDA: "patent ductus arteriosus", TOF: "tetralogy of fallot", NEC: "necrotizing enterocolitis", RDS: "respiratory distress syndrome newborn",
  BCG: "vaccine immunization", OPV: "polio vaccine immunization", IPV: "polio vaccine immunization", MMR: "measles mumps rubella vaccine", DPT: "diphtheria pertussis tetanus vaccine", DTP: "diphtheria pertussis tetanus vaccine",
  IUGR: "intrauterine growth restriction", PPH: "postpartum hemorrhage", PIH: "pregnancy induced hypertension", IUCD: "intrauterine contraceptive device", PCOS: "polycystic ovary",
  CSOM: "chronic suppurative otitis media", POAG: "primary open angle glaucoma", IOP: "intraocular pressure",
  STI: "sexually transmitted infection", STD: "sexually transmitted disease",
  IMR: "infant mortality rate", NFHS: "national family health survey", WHO: "world health organization",
};

/** Light normalization so British / American spellings and plurals meet (applied to both sides). */
function stem(w: string): string {
  let x = w.replace(/ae/g, "e").replace(/oe/g, "e");
  if (x.length > 5 && x.endsWith("ies")) x = `${x.slice(0, -3)}y`;
  else if (x.length > 5 && /(sses|xes|ches|shes)$/.test(x)) x = x.slice(0, -2);
  else if (x.length > 4 && x.endsWith("s") && !/(ss|us|is)$/.test(x)) x = x.slice(0, -1);
  // Long medical words meet across their endings (thrombocytopenic / thrombocytopenia, glomerulonephritis / -nephritic).
  return x.length > 9 ? x.slice(0, 9) : x;
}

export function expandAbbreviations(text: string): string {
  const extra: string[] = [];
  for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9]{1,5})\b/g)) {
    const words = ABBREVIATIONS[m[1]];
    if (words) extra.push(words);
  }
  return extra.length ? `${text} ${extra.join(" ")}` : text;
}

/** Words (≥ 3 letters, no stop words) + adjacent word pairs, normalized. */
export function terms(text: string): string[] {
  const words = expandAbbreviations(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
  const out = [...words];
  for (let i = 0; i + 1 < words.length; i++) out.push(`${words[i]} ${words[i + 1]}`);
  return out;
}

/** The text the classifier reads: question context, stem (numbered statements included), match lists, options. */
export function classificationText(e: Pick<ExtractedQuestion, "stem" | "options"> & Partial<Pick<ExtractedQuestion, "listI" | "listII" | "passage" | "instructions">>): string {
  return [e.instructions ?? "", e.passage ?? "", e.stem, ...(e.listI ?? []).map((x) => x.text), ...(e.listII ?? []).map((x) => x.text), ...e.options.map((o) => o.text)].join("\n");
}

/** Enough of the question is present to classify it (text, not just labels / an image placeholder). */
export function textSufficient(e: Pick<ExtractedQuestion, "stem" | "options"> & Partial<Pick<ExtractedQuestion, "listI" | "listII" | "passage" | "instructions">>): { ok: boolean; why: string | null } {
  const stemWords = terms(e.stem.replace(/⟦IMG:[^⟧]*⟧/g, " ")).filter((t) => !t.includes(" "));
  const optionText = e.options.filter((o) => o.text.trim()).length;
  const all = terms(classificationText(e)).filter((t) => !t.includes(" "));
  if (!e.stem.trim()) return { ok: false, why: "the question text is empty" };
  if (all.length < 3) return { ok: false, why: "too little readable text to classify (fewer than three meaningful words in the question and options)" };
  if (stemWords.length < 2 && optionText < 2) return { ok: false, why: "the question text and options are incomplete" };
  return { ok: true, why: null };
}

// ---- Built-in terminology for common topic names ---------------------------------------------------------

/**
 * Cue words for topics by the kind of name they have. An entry contributes ONLY to topics of the selected exam
 * whose name matches `topic` (and whose subject matches `subject`, when given); exams without such topics are
 * unaffected. These are terms, never records.
 */
const TOPIC_CUES: { topic: RegExp; subject?: RegExp; terms: string }[] = [
  { topic: /cardi|heart/, terms: "heart cardiac murmur heart sound auscultation stethoscope systolic diastolic angina myocardial infarction ecg electrocardiogram arrhythmia atrial fibrillation valve mitral aortic stenosis regurgitation pericarditis endocarditis hypertension cardiomyopathy jugular venous pulse" },
  { topic: /respirat|pulmon|lung|chest/, terms: "lung pulmonary asthma bronchial copd pneumonia pleural effusion dyspnea cough wheeze spirometry bronchiectasis tuberculosis sputum hemoptysis respiratory" },
  { topic: /renal|kidney|nephro/, terms: "kidney renal nephrotic nephritic glomerular proteinuria hematuria dialysis creatinine urea tubular" },
  { topic: /electrolyte|acid.?base/, terms: "sodium potassium hyponatremia hypernatremia hyperkalemia hypokalemia acidosis alkalosis anion gap bicarbonate calcium magnesium" },
  { topic: /diabet/, terms: "diabetes insulin glucose hyperglycemia hypoglycemia ketoacidosis metformin glycated hemoglobin" },
  { topic: /endocrin/, terms: "thyroid hypothyroidism hyperthyroidism pituitary adrenal cortisol cushing addison acromegaly prolactin parathyroid hormone goitre" },
  { topic: /gastro|digest|alimentary|intestin|bowel/, terms: "stomach gastric peptic ulcer esophagus dysphagia bowel diarrhea constipation colitis crohn pancreatitis malabsorption celiac gastrointestinal bleeding" },
  { topic: /liver|hepat|bilia/, terms: "liver hepatitis cirrhosis jaundice bilirubin ascites portal hypertension gallstone biliary hepatic encephalopathy wilson hemochromatosis gilbert alcoholic hepatitis" },
  { topic: /hemat|haemat|blood/, terms: "anemia hemoglobin thalassemia sickle leukemia lymphoma platelet thrombocytopenia thrombocytopenic purpura bleeding coagulation hemophilia transfusion iron deficiency polycythemia erythrocytosis anticoagulant" },
  { topic: /infect|communicable/, subject: /medicine|pediatric|paediatric|microbio/, terms: "fever infection malaria typhoid dengue tuberculosis hiv antibiotic sepsis meningitis leptospirosis rabies tetanus vaccine" },
  { topic: /neuro/, terms: "brain stroke seizure epilepsy paralysis neuropathy cerebral headache migraine meningitis parkinson myasthenia neuron reflex coma" },
  { topic: /rheumat|immunolog|autoimmun/, terms: "arthritis rheumatoid lupus joint vasculitis autoimmune antinuclear gout spondylitis scleroderma" },
  { topic: /poison|toxicol/, terms: "poisoning overdose antidote organophosphate snake bite toxin" },
  { topic: /nutrition/, terms: "nutrition vitamin deficiency malnutrition protein energy kwashiorkor marasmus obesity diet calorie rickets scurvy" },
  { topic: /oncolog|tumou?r|neoplas|cancer/, terms: "cancer tumor carcinoma malignancy metastasis chemotherapy neoplasm" },
  { topic: /emergenc/, terms: "emergency shock resuscitation cardiac arrest anaphylaxis acute management" },
  { topic: /neonat|newborn/, terms: "newborn neonate neonatal preterm birth weight jaundice apgar breastfeeding respiratory distress" },
  { topic: /immuni[sz]ation|vaccin/, terms: "vaccine vaccination immunization schedule bcg polio measles booster" },
  { topic: /growth|development/, terms: "growth development milestone height weight head circumference puberty developmental" },
  { topic: /genetic/, terms: "chromosome genetic syndrome trisomy down syndrome inheritance mutation" },
  { topic: /adolescen/, terms: "adolescent adolescence puberty teenager" },
  { topic: /eczema|dermatitis/, terms: "eczema dermatitis itching pruritus atopic contact allergic" },
  { topic: /pigment/, terms: "pigmentation vitiligo melasma hyperpigmentation depigmentation melanin" },
  { topic: /papulosquamous/, terms: "psoriasis lichen planus scaling plaque pityriasis" },
  { topic: /vesiculobullous|bullous/, terms: "blister bulla pemphigus pemphigoid nikolsky vesicle" },
  { topic: /leprosy/, terms: "leprosy hansen lepromatous tuberculoid anesthetic patch nerve thickening" },
  { topic: /fungal/, terms: "fungal tinea dermatophyte candida ringworm" },
  { topic: /hair|nail/, terms: "hair alopecia nail baldness" },
  { topic: /acne/, terms: "acne comedone sebaceous rosacea" },
  { topic: /mood|depress|bipolar/, terms: "depression mania bipolar mood suicide lithium antidepressant" },
  { topic: /schizo|psychos/, terms: "schizophrenia hallucination delusion psychosis antipsychotic" },
  { topic: /anxiety/, terms: "anxiety panic phobia generalized anxiety" },
  { topic: /substance|alcohol|addict/, terms: "alcohol dependence withdrawal opioid substance addiction delirium tremens" },
  { topic: /sleep/, terms: "sleep insomnia narcolepsy" },
  { topic: /personality/, terms: "personality disorder borderline antisocial" },
  { topic: /psychopharmac/, terms: "antidepressant antipsychotic lithium ssri drug side effect psychiatric drug" },
  { topic: /obsessive/, terms: "obsession compulsion obsessive compulsive" },
];

/** Age / setting words that point to a whole subject (only when such a subject exists in the exam). */
const SUBJECT_CUES: { subject: RegExp; pattern: RegExp; weight: number; terms: string }[] = [
  { subject: /pediatric|paediatric/, pattern: /\b(child|children|infant|infants|newborn|neonate|neonatal|toddler|baby|boy|girl|school.?age)\b|\b(\d{1,2})\s*(month|months|week|weeks|day|days)[\s-]*old\b|\b([1-9]|1[0-2])[\s-]*(year|yr)s?[\s-]*old\b/i, weight: 2.5, terms: "child infant newborn pediatric" },
  { subject: /obstet|gyn/, pattern: /\b(pregnan\w*|gestation\w*|antenatal|postpartum|labou?r|trimester|primigravida|multigravida|menstrua\w*|uterus|uterine|ovary|ovarian|cervix|cervical cancer)\b/i, weight: 2.5, terms: "pregnancy obstetric gynecology" },
  { subject: /psychiatr/, pattern: /\b(hallucinat\w*|delusion\w*|psychiatric|suicid\w*|mood|anxiety|obsess\w*)\b/i, weight: 1.5, terms: "psychiatric mental" },
  { subject: /dermatol/, pattern: /\b(skin|rash|lesion|lesions|macule|papule|plaque|pruritus|itching|vitiligo|psoriasis|eczema)\b/i, weight: 1.5, terms: "skin dermatology" },
];

/** Neighbouring subjects that are often confused (both must exist in the exam). Combined with the memory's own pairs. */
const DEFAULT_CONFUSIONS: [RegExp, RegExp, string][] = [
  [/general medicine|^medicine$/, /pediatric|paediatric/, "the same disease is taught in both; the patient's age usually decides"],
  [/general medicine|^medicine$/, /respiratory/, "lung disease appears in both"],
  [/general medicine|^medicine$/, /dermatol/, "skin signs of systemic disease appear in both"],
  [/general medicine|^medicine$/, /psychiatr/, "organic and psychiatric causes overlap"],
  [/pathology/, /general medicine|^medicine$/, "disease mechanism vs clinical management"],
  [/microbio/, /community medicine|psm/, "infections and their prevention"],
  [/pediatric|paediatric/, /community medicine|psm/, "immunization and child health programmes"],
  [/obstet|gyn/, /community medicine|psm/, "maternal health programmes"],
  [/pharmacol/, /general medicine|^medicine$/, "drug of choice vs disease management"],
];

// ---- Index -----------------------------------------------------------------------------------------------

interface Doc {
  topicId: string;
  subjectId: string;
  tf: Map<string, number>;
  len: number;
}

export interface TaxonomyIndex {
  taxonomy: ExamTaxonomySubject[];
  docs: Doc[];
  /** Subject-level profile (name, syllabus, subject cue words). */
  subjectDocs: Map<string, Map<string, number>>;
  df: Map<string, number>;
  avgLen: number;
  confusions: { a: string; b: string; note: string | null }[];
  corrections: { id: string; terms: Set<string>; subjectId: string; topicId: string | null; subTopicId: string | null }[];
  subjectCues: { subjectId: string; pattern: RegExp; weight: number }[];
  /** How much reviewed evidence each topic has (shown in the taxonomy reference). */
  evidenceCount: Map<string, number>;
}

function addTerms(tf: Map<string, number>, text: string, weight: number): number {
  const ts = terms(text);
  for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + weight);
  return ts.length * weight;
}

/**
 * Builds the classifier for one exam. `evidence` texts whose topic is not in this taxonomy, and memory entries that
 * name ids outside it, are ignored (a renamed / unlinked record never leaks in).
 */
export function buildTaxonomyIndex(taxonomy: ExamTaxonomySubject[], evidence: TaxonomyEvidence[], memory: ClassifierMemory | null, opts: { evidencePerTopic?: number } = {}): TaxonomyIndex {
  const perTopic = opts.evidencePerTopic ?? 150;
  const topicIds = new Set(taxonomy.flatMap((s) => s.topics.map((t) => t.id)));
  const subjectIds = new Set(taxonomy.map((s) => s.id));
  const subjectOfTopic = new Map(taxonomy.flatMap((s) => s.topics.map((t) => [t.id, s.id] as const)));
  const byTopic = new Map<string, string[]>();
  for (const ev of evidence) {
    if (!topicIds.has(ev.topicId)) continue;
    const list = byTopic.get(ev.topicId) ?? [];
    if (list.length < perTopic) list.push(ev.text.slice(0, 1200));
    byTopic.set(ev.topicId, list);
  }
  const key = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const docs: Doc[] = [];
  const subjectDocs = new Map<string, Map<string, number>>();
  for (const s of taxonomy) {
    const sdoc = new Map<string, number>();
    addTerms(sdoc, s.name, 3);
    if (s.syllabusDescription) addTerms(sdoc, s.syllabusDescription, 1);
    for (const c of SUBJECT_CUES) if (c.subject.test(key(s.name))) addTerms(sdoc, c.terms, 2);
    for (const syn of memory?.synonyms ?? []) if (syn.subjectId === s.id && !syn.topicId) addTerms(sdoc, syn.term, 3);
    subjectDocs.set(s.id, sdoc);
    for (const t of s.topics) {
      const tf = new Map<string, number>();
      let len = addTerms(tf, t.name, 4);
      len += addTerms(tf, s.name, 1);
      if (t.syllabusDescription) len += addTerms(tf, t.syllabusDescription, 1.5);
      for (const st of t.subTopics) len += addTerms(tf, st.name, 1.5);
      for (const c of TOPIC_CUES) if (c.topic.test(key(t.name)) && (!c.subject || c.subject.test(key(s.name)))) len += addTerms(tf, c.terms, 2);
      for (const syn of memory?.synonyms ?? []) if (syn.topicId === t.id) len += addTerms(tf, syn.term, 4);
      for (const c of memory?.corrections ?? []) if (c.topicId === t.id && c.subjectId === s.id) len += addTerms(tf, c.text, 2);
      // Reviewed questions: each term counts once per question, so one (possibly mis-filed) question cannot dominate.
      for (const text of byTopic.get(t.id) ?? []) {
        const once = [...new Set(terms(text))];
        for (const x of once) tf.set(x, (tf.get(x) ?? 0) + EVIDENCE_WEIGHT);
        len += once.length * EVIDENCE_WEIGHT;
      }
      docs.push({ topicId: t.id, subjectId: s.id, tf, len });
    }
  }
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLen = docs.length ? docs.reduce((a, d) => a + d.len, 0) / docs.length : 1;
  const confusions: TaxonomyIndex["confusions"] = [];
  for (const [ra, rb, note] of DEFAULT_CONFUSIONS) {
    const a = taxonomy.find((s) => ra.test(key(s.name)));
    const b = taxonomy.find((s) => rb.test(key(s.name)));
    if (a && b && a.id !== b.id) confusions.push({ a: a.id, b: b.id, note });
  }
  for (const c of memory?.confusions ?? []) if (subjectIds.has(c.a) && subjectIds.has(c.b) && c.a !== c.b) confusions.push(c);
  const corrections = (memory?.corrections ?? [])
    .filter((c) => subjectIds.has(c.subjectId) && (!c.topicId || subjectOfTopic.get(c.topicId) === c.subjectId))
    .map((c) => ({ id: c.id, terms: new Set(terms(c.text).filter((t) => !t.includes(" "))), subjectId: c.subjectId, topicId: c.topicId, subTopicId: c.subTopicId }));
  const subjectCues = taxonomy.flatMap((s) => SUBJECT_CUES.filter((c) => c.subject.test(key(s.name))).map((c) => ({ subjectId: s.id, pattern: c.pattern, weight: c.weight })));
  return { taxonomy, docs, subjectDocs, df, avgLen, confusions, corrections, subjectCues, evidenceCount: new Map([...byTopic].map(([k, v]) => [k, v.length])) };
}

// ---- Scoring ---------------------------------------------------------------------------------------------

/** How strongly the paper's own subject mix (first pass over all its questions) favours a subject. */
const PRIOR_WEIGHT = 1.5;
/** Neighbouring questions on each side that form a question's section context. */
const WINDOW = 6;
/** An age / setting word of a subject (a child, a pregnancy) multiplies that subject's scores. */
const CUE_FACTOR = 1.5;
const K1 = 1.2;
const B = 0.6;

function bm25(index: TaxonomyIndex, tf: Map<string, number>, len: number, q: string[], qw?: Map<string, number>): { score: number; hits: { t: string; s: number }[] } {
  const N = index.docs.length;
  let score = 0;
  const hits: { t: string; s: number }[] = [];
  for (const t of q) {
    const f = tf.get(t);
    if (!f) continue;
    const n = index.df.get(t) ?? 0;
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    const s = ((qw?.get(t) ?? 1) * idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * len) / index.avgLen));
    score += s;
    hits.push({ t, s });
  }
  return { score, hits };
}

const jaccardSets = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
};

/** Strength of the evidence (0..1) from the best score; ~0.5 at a few specific shared terms. */
const strength = (s: number) => s / (s + 6);

/**
 * Classifies one question. `allowedSubjects` limits the subjects (a single-subject paper, or a printed heading);
 * ids outside the index's taxonomy are never returned.
 */
export function classifyLocally(index: TaxonomyIndex, e: Pick<ExtractedQuestion, "stem" | "options"> & Partial<Pick<ExtractedQuestion, "listI" | "listII" | "passage" | "instructions">>, opts: { allowedSubjects?: string[] | null; topicMin?: number; prior?: Map<string, number> | null } = {}): LocalClassification {
  const topicMin = Math.max(LOCAL_TOPIC_MIN, opts.topicMin ?? LOCAL_TOPIC_MIN);
  const none = (status: LocalStatus, reason: string, extra: Partial<LocalClassification> = {}): LocalClassification => ({ status, subjectId: null, topicId: null, subTopicId: null, subjectConfidence: 0, topicConfidence: 0, method: "local terms", matched: [], reason, candidates: [], confusedWith: null, ...extra });
  if (!index.taxonomy.length) return none("NO_TAXONOMY", "this exam has no subjects configured (Admin → Exams → Syllabus) — nothing can be assigned");
  const allowed = opts.allowedSubjects?.length ? new Set(opts.allowedSubjects.filter((id) => index.subjectDocs.has(id))) : null;
  if (opts.allowedSubjects?.length && !allowed?.size) return none("NO_TAXONOMY", "the paper's subject is not part of this exam's taxonomy");
  const suff = textSufficient(e);
  if (!suff.ok) return none("INSUFFICIENT_TEXT", `not classified: ${suff.why}`);
  const text = classificationText(e);
  // The question itself (context, stem, statements, lists) decides; option words count half (answer vocabulary such
  // as "autosomal dominant" is shared by many topics).
  const qw = new Map<string, number>();
  for (const t of terms([e.instructions ?? "", e.passage ?? "", e.stem, ...(e.listI ?? []).map((x) => x.text), ...(e.listII ?? []).map((x) => x.text)].join("\n"))) qw.set(t, 1);
  for (const t of terms(e.options.map((o) => o.text).join("\n"))) if (!qw.has(t)) qw.set(t, 0.5);
  const q = [...qw.keys()];
  const qWords = new Set(q.filter((t) => !t.includes(" ")));

  // 1. An administrator-confirmed question of this exam that is (almost) the same question.
  let bestCorr: { c: TaxonomyIndex["corrections"][number]; sim: number } | null = null;
  for (const c of index.corrections) {
    if (allowed && !allowed.has(c.subjectId)) continue;
    const sim = jaccardSets(qWords, c.terms);
    if (sim >= CONFIRMED_MATCH_AT && (!bestCorr || sim > bestCorr.sim)) bestCorr = { c, sim };
  }
  if (bestCorr) {
    const s = index.taxonomy.find((x) => x.id === bestCorr!.c.subjectId)!;
    const t = bestCorr.c.topicId ? s.topics.find((x) => x.id === bestCorr!.c.topicId) : undefined;
    const st = t && bestCorr.c.subTopicId ? t.subTopics.find((x) => x.id === bestCorr!.c.subTopicId) : undefined;
    return { status: t ? "CLASSIFIED" : "SUBJECT_ONLY", subjectId: s.id, topicId: t?.id ?? null, subTopicId: st?.id ?? null, subjectConfidence: 0.95, topicConfidence: t ? 0.95 : 0, method: "confirmed example", matched: [], reason: `same as a question an administrator classified for this exam (${Math.round(bestCorr.sim * 100)}% same words): ${s.name}${t ? ` › ${t.name}` : ""}${st ? ` › ${st.name}` : ""}`, candidates: [], confusedWith: null };
  }

  // 2. Term profiles.
  const cueBoost = new Map<string, number>();
  for (const c of index.subjectCues) if (c.pattern.test(text)) cueBoost.set(c.subjectId, (cueBoost.get(c.subjectId) ?? 0) + c.weight);
  const boost = (subjectId: string) => 1 + PRIOR_WEIGHT * (opts.prior?.get(subjectId) ?? 0);
  const scored = index.docs
    .filter((d) => !allowed || allowed.has(d.subjectId))
    .map((d) => {
      const r = bm25(index, d.tf, d.len, q, qw);
      return { d, score: (r.score + (cueBoost.get(d.subjectId) ?? 0)) * boost(d.subjectId) * (cueBoost.has(d.subjectId) ? CUE_FACTOR : 1), hits: r.hits };
    })
    .sort((a, b) => b.score - a.score);
  const subjectBest = new Map<string, (typeof scored)[number]>();
  for (const s of scored) if (!subjectBest.has(s.d.subjectId)) subjectBest.set(s.d.subjectId, s);
  // Subjects without topics compete through their subject profile only.
  const subjectScores = index.taxonomy
    .filter((s) => !allowed || allowed.has(s.id))
    .map((s) => {
      const sd = index.subjectDocs.get(s.id)!;
      const own = bm25(index, sd, [...sd.values()].reduce((a, b) => a + b, 0) || 1, q, qw).score * 0.5;
      const top = subjectBest.get(s.id);
      return { id: s.id, score: (top?.score ?? (cueBoost.get(s.id) ?? 0) * boost(s.id) * CUE_FACTOR) + own * boost(s.id), top };
    })
    .sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 3).map((x) => ({ subjectId: x.d.subjectId, topicId: x.d.topicId, score: Math.round(x.score * 100) / 100 }));
  const subjectScoreList = subjectScores.map((x) => ({ subjectId: x.id, score: Math.round(x.score * 100) / 100 }));
  const first = subjectScores[0];
  const second = subjectScores[1];
  if (!first || first.score <= 0.5) return none("UNCERTAIN", "no subject of this exam matches the question's terms", { candidates, subjectScores: subjectScoreList });
  const name = (id: string | null | undefined) => (id ? (index.taxonomy.find((s) => s.id === id)?.name ?? index.taxonomy.flatMap((s) => s.topics).find((t) => t.id === id)?.name ?? "?") : "—");
  const subjMargin = allowed?.size === 1 ? 1 : second ? (first.score - second.score) / first.score : 1;
  let subjectConfidence = allowed?.size === 1 ? 1 : Math.min(0.97, strength(first.score) * 0.45 + subjMargin * 0.75);
  const confusion = second ? index.confusions.find((c) => (c.a === first.id && c.b === second.id) || (c.b === first.id && c.a === second.id)) : undefined;
  let confusedWith: string | null = null;
  // A commonly confused pair is settled only by evidence that separates them: an age / setting word of one side
  // (a child → Pediatrics), or a paper that is clearly mostly one of the two.
  const p1 = opts.prior?.get(first.id) ?? 0;
  const p2 = second ? (opts.prior?.get(second.id) ?? 0) : 0;
  const settledBy = !confusion ? null : (cueBoost.get(first.id) ?? 0) > (cueBoost.get(second!.id) ?? 0) ? "age / setting words of the question" : p1 >= 0.2 && p1 >= 3 * p2 ? "the paper's subject mix" : null;
  if (confusion && settledBy) subjectConfidence = Math.max(subjectConfidence, LOCAL_SUBJECT_MIN);
  if (confusion && !settledBy && subjMargin < 0.35 && allowed?.size !== 1) {
    subjectConfidence = Math.min(subjectConfidence, LOCAL_SUBJECT_MIN - 0.01);
    confusedWith = second!.id;
  }
  const hitsOf = (x: (typeof scored)[number] | undefined) => (x?.hits ?? []).sort((a, b) => b.s - a.s).map((h) => h.t).filter((t, i, a) => a.indexOf(t) === i).slice(0, 6);
  if (subjectConfidence < LOCAL_SUBJECT_MIN) {
    return none("UNCERTAIN", confusedWith ? `${name(first.id)} or ${name(second!.id)} — these subjects are commonly confused (${confusion!.note ?? "overlapping content"}) and the question's terms do not separate them clearly` : `the terms fit several subjects (${name(first.id)} ${Math.round(subjectConfidence * 100)}%, next ${name(second?.id)})`, { candidates, matched: hitsOf(first.top), subjectConfidence, confusedWith, subjectScores: subjectScoreList });
  }
  // Topic within the chosen subject.
  const inSubject = scored.filter((x) => x.d.subjectId === first.id);
  const t1 = inSubject[0];
  const t2 = inSubject[1];
  const matched = hitsOf(t1);
  if (!t1 || t1.score - (cueBoost.get(first.id) ?? 0) <= 0.5) return { status: "SUBJECT_ONLY", subjectId: first.id, topicId: null, subTopicId: null, subjectConfidence, topicConfidence: 0, method: "local terms", matched, reason: `${name(first.id)} (${Math.round(subjectConfidence * 100)}%); no topic of this subject matches the question's terms`, candidates, confusedWith: null, subjectScores: subjectScoreList };
  const topicMargin = t2 ? (t1.score - t2.score) / t1.score : 1;
  const topicConfidence = Math.min(0.95, strength(t1.score) * 0.5 + topicMargin * 0.7);
  const topic = index.taxonomy.find((s) => s.id === first.id)!.topics.find((t) => t.id === t1.d.topicId)!;
  if (topicConfidence < topicMin) {
    return { status: "SUBJECT_ONLY", subjectId: first.id, topicId: null, subTopicId: null, subjectConfidence, topicConfidence, method: "local terms", matched, reason: `${name(first.id)} (${Math.round(subjectConfidence * 100)}%); topic unclear — ${topic.name} ${Math.round(topicConfidence * 100)}%${t2 ? `, next ${name(t2.d.topicId)}` : ""}`, candidates, confusedWith: null, subjectScores: subjectScoreList };
  }
  // Subtopic only when one is clearly named by the question's words.
  let subTopicId: string | null = null;
  if (topic.subTopics.length) {
    const sts = topic.subTopics
      .map((st) => {
        const words = terms(st.name).filter((t) => !t.includes(" "));
        const hit = words.filter((w) => qWords.has(w)).length;
        return { st, frac: words.length ? hit / words.length : 0 };
      })
      .sort((a, b) => b.frac - a.frac);
    if (sts[0] && sts[0].frac >= 0.6 && (!sts[1] || sts[1].frac < sts[0].frac)) subTopicId = sts[0].st.id;
  }
  const st = subTopicId ? topic.subTopics.find((x) => x.id === subTopicId) : undefined;
  return { status: "CLASSIFIED", subjectId: first.id, topicId: topic.id, subTopicId, subjectConfidence, topicConfidence, method: "local terms", matched, reason: `${name(first.id)} › ${topic.name}${st ? ` › ${st.name}` : ""} (subject ${Math.round(subjectConfidence * 100)}%, topic ${Math.round(topicConfidence * 100)}%) — matched “${matched.slice(0, 4).join("”, “")}”`, candidates, confusedWith: null, subjectScores: subjectScoreList };
}

/**
 * Classifies a whole paper: a first pass over every question gives the paper's subject mix (questions of one paper
 * usually come from a few subjects — e.g. a CMS Paper I is Medicine and Pediatrics); the second pass uses that mix as
 * context, so a medicine question is not filed under Pathology or Pharmacology only because it names a drug or a
 * lesion. The mix is reported in each reason. Fewer than five classifiable questions: no paper context.
 */
export function classifyPaper(index: TaxonomyIndex, questions: (Pick<ExtractedQuestion, "stem" | "options"> & Partial<Pick<ExtractedQuestion, "listI" | "listII" | "passage" | "instructions">>)[], opts: { allowedSubjects?: (string[] | null)[]; topicMin?: number } = {}): { results: LocalClassification[]; prior: Map<string, number> } {
  const run = (priors: Map<string, number>[] | null) => questions.map((e, i) => classifyLocally(index, e, { allowedSubjects: opts.allowedSubjects?.[i] ?? null, topicMin: opts.topicMin, prior: priors?.[i] ?? null }));
  /** The subject mix of some results: assigned subjects count fully, an unresolved question's best guess a little. */
  const mixOf = (rs: LocalClassification[], minUsable = 5): Map<string, number> => {
    const weight = new Map<string, number>();
    let total = 0;
    for (const r of rs) {
      const top = r.subjectId ?? (r.subjectConfidence >= 0.35 ? (r.candidates[0]?.subjectId ?? null) : null);
      if (!top) continue;
      const w = r.subjectId ? 1 : 0.3;
      weight.set(top, (weight.get(top) ?? 0) + w);
      total += w;
    }
    const usable = rs.filter((r) => r.status !== "INSUFFICIENT_TEXT" && r.status !== "NO_TAXONOMY").length;
    return usable >= minUsable && total > 0 ? new Map([...weight].map(([k, v]) => [k, v / total])) : new Map();
  };
  /**
   * Per question: half the whole paper's mix, half the mix of its neighbours (papers group questions by subject in
   * blocks — a Pediatrics section after Medicine), so a minority section is not pulled into the majority subject.
   */
  const contextOf = (rs: LocalClassification[], whole: Map<string, number>): Map<string, number>[] =>
    rs.map((_, i) => {
      const near = mixOf([...rs.slice(Math.max(0, i - WINDOW), i), ...rs.slice(i + 1, i + 1 + WINDOW)], 3);
      const out = new Map<string, number>();
      for (const k of new Set([...whole.keys(), ...near.keys()])) out.set(k, near.size ? 0.5 * (whole.get(k) ?? 0) + 0.5 * (near.get(k) ?? 0) : (whole.get(k) ?? 0));
      return out;
    });
  let results = run(null);
  let prior = mixOf(results);
  if (!prior.size) return { results, prior };
  // A few rounds: each round's assignments sharpen the mix (stable after two or three).
  for (let round = 0; round < 3; round++) {
    results = run(contextOf(results, prior));
    const next = mixOf(results);
    const moved = [...new Set([...prior.keys(), ...next.keys()])].reduce((a, k) => a + Math.abs((prior.get(k) ?? 0) - (next.get(k) ?? 0)), 0);
    prior = next;
    if (moved < 0.02) break;
  }
  const share = [...prior].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, p]) => `${index.taxonomy.find((s) => s.id === id)?.name ?? "?"} ${Math.round(p * 100)}%`).join(", ");
  results = run(contextOf(results, prior)).map((r) => {
    return r.method === "local terms" && r.status !== "INSUFFICIENT_TEXT" && r.status !== "NO_TAXONOMY" ? { ...r, reason: `${r.reason}; paper context: ${share}` } : r;
  });
  return { results, prior };
}

// ---- Verify 1: the stored subject / topic against the exam taxonomy and an independent local classification ----

/** The free check disagrees with a stored (non-administrator) choice only at or above these confidences. */
export const V1_SUBJECT_DISAGREE_AT = 0.8;
export const V1_TOPIC_DISAGREE_AT = 0.8;
/** …or when the stored subject's own score is below this share of the best subject's (and the check would assign it). */
export const V1_STORED_BEHIND = 0.5;

export interface StoredTaxonomy {
  subjectId: string | null;
  topicId: string | null;
  subTopicId: string | null;
  /** taxonomySource: admin · selected subject · source column · local classifier · confirmed example · AI (…). */
  source: string | null;
}

/**
 * Verify 1's classification result for one question (pure). `independent` is the local classifier's result for the
 * question WITHOUT the stored choice (only a single-subject paper keeps its selected subject). An administrator's
 * choice is never contradicted by a flag — a disagreement is shown, not raised — and is not "verified" either unless
 * the independent check agrees.
 */
export function verifyStoredTaxonomy(stored: StoredTaxonomy, independent: LocalClassification | null | undefined, taxonomy: ExamTaxonomySubject[]): { verification: import("@/lib/ai-import/types").TaxonomyVerification; problems: { code: string; detail: string }[] } {
  const name = (id: string | null | undefined) => (id ? (taxonomy.find((s) => s.id === id)?.name ?? taxonomy.flatMap((s) => s.topics).find((t) => t.id === id)?.name ?? taxonomy.flatMap((s) => s.topics.flatMap((t) => t.subTopics)).find((u) => u.id === id)?.name ?? "?") : "—");
  const ids = { subjectId: stored.subjectId, topicId: stored.topicId, subTopicId: stored.subTopicId };
  const found = independent && independent.subjectId ? { subjectId: independent.subjectId, topicId: independent.topicId, subTopicId: independent.subTopicId } : null;
  const out = (status: import("@/lib/ai-import/types").TaxonomyVerification["status"], findings: string[], problems: { code: string; detail: string }[] = []) => ({ verification: { status, stored: ids, found, confidence: independent ? (independent.topicId ? independent.topicConfidence : independent.subjectConfidence) : null, method: "local", findings }, problems });
  if (!taxonomy.length) return out("NOT_VERIFIED", ["this exam has no subjects configured — missing configuration (no other exam's taxonomy is used)"]);
  // 1. Validity: every stored id is part of THIS exam's hierarchy.
  const s = stored.subjectId ? taxonomy.find((x) => x.id === stored.subjectId) : undefined;
  const invalid: string[] = [];
  if (stored.subjectId && !s) invalid.push("the stored subject is not part of this exam");
  const t = s && stored.topicId ? s.topics.find((x) => x.id === stored.topicId) : undefined;
  if (stored.topicId && s && !t) invalid.push(`the stored topic is not under ${s.name} for this exam`);
  if (stored.subTopicId && t && !t.subTopics.some((u) => u.id === stored.subTopicId)) invalid.push(`the stored subtopic is not under ${t.name} for this exam`);
  if (invalid.length) return out("DISAGREEMENT", invalid, [{ code: "TAXONOMY_DISAGREES", detail: `Verify 1: ${invalid.join("; ")} — choose the subject / topic again.` }]);
  if (!independent || independent.status === "NO_TAXONOMY") return out("NOT_VERIFIED", ["not checked"]);
  if (independent.status === "INSUFFICIENT_TEXT") return out("NOT_VERIFIED", [`${independent.reason} — an extraction problem, not a taxonomy one`]);
  const admin = !!stored.source?.startsWith("admin");
  if (!s) return out("NEEDS_REVIEW", [independent.subjectId ? `no subject is stored; the free check suggests ${name(independent.subjectId)}${independent.topicId ? ` › ${name(independent.topicId)}` : ""} (${Math.round(independent.subjectConfidence * 100)}%)` : `no subject is stored and none fits reliably: ${independent.reason}`]);
  if (!independent.subjectId) return out("NEEDS_REVIEW", [`${admin ? "the administrator's choice" : `${s.name}${t ? ` › ${t.name}` : ""}`} is not confirmed by the free check: ${independent.reason}`]);
  if (independent.subjectId !== s.id) {
    // Decisive when the free check is very sure, or when it would assign its subject itself AND the stored subject's
    // own evidence is far behind it (less than half the best subject's score).
    const best = independent.subjectScores?.[0]?.score ?? 0;
    const mine = independent.subjectScores?.find((x) => x.subjectId === s.id)?.score ?? 0;
    const farBehind = best > 0 && mine < best * V1_STORED_BEHIND;
    const msg = `subject ${s.name} vs ${name(independent.subjectId)} (free check, ${Math.round(independent.subjectConfidence * 100)}%${independent.matched.length ? `, “${independent.matched.slice(0, 3).join("”, “")}”` : ""}${farBehind ? `; ${s.name} scores ${best ? Math.round((mine / best) * 100) : 0}% of it` : ""})`;
    if (independent.subjectConfidence < V1_SUBJECT_DISAGREE_AT && !farBehind) return out("NEEDS_REVIEW", [`${msg} — not decisive`]);
    return out("DISAGREEMENT", [admin ? `${msg} — the administrator's choice is kept; check it` : msg], admin ? [] : [{ code: "TAXONOMY_DISAGREES", detail: `Verify 1: ${msg}. Check the subject (bulk correction is available).` }]);
  }
  if (t && independent.topicId && independent.topicId !== t.id) {
    const msg = `topic ${t.name} vs ${name(independent.topicId)} (free check, ${Math.round(independent.topicConfidence * 100)}%)`;
    if (independent.topicConfidence < V1_TOPIC_DISAGREE_AT || stored.source === "source column") return out("NEEDS_REVIEW", [`${msg} — not decisive`]);
    return out("DISAGREEMENT", [admin ? `${msg} — the administrator's choice is kept; check it` : msg], admin ? [] : [{ code: "TAXONOMY_DISAGREES", detail: `Verify 1: ${msg}. Check the topic.` }]);
  }
  if (!t) return out("NEEDS_REVIEW", [`subject ${s.name} confirmed; no topic is stored${independent.topicId ? ` — the free check suggests ${name(independent.topicId)} (${Math.round(independent.topicConfidence * 100)}%)` : ""}`]);
  return out("AGREED", [`${s.name} › ${t.name}${independent.topicId ? "" : " (topic not independently confirmed)"} — ${independent.reason}`.slice(0, 400)]);
}
