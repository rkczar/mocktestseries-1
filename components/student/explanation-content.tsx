import type { ReactNode } from "react";
import type { ExplanationContent } from "@/lib/ai-explanation";

/**
 * The one canonical renderer for a structured AI explanation — used by the
 * Ask AI panel (Question Review, Saved Questions, every AI Variant) and the
 * homepage "Try AI Now" demo, so the typography never forks per page.
 * Presentation only: it renders ExplanationContent exactly as stored.
 *
 * Styling lives in the `.ai-expl*` rules in app/globals.css. Each section
 * gets a semantic tone from its heading text (cueTone), and the same
 * vocabulary is used to emphasise a leading "Memory Trick:"-style label
 * inside body text, so new cue names only need adding in one place.
 */

export type CueTone = "success" | "positive" | "warning" | "primary" | "secondary" | "neutral";

// Order matters: the first match wins ("Examiner traps" is a trap, not a variation).
const CUE_TONES: Array<[RegExp, CueTone]> = [
  [/correct answer|why (this|the correct)|is correct/i, "success"],
  [/trap|mistake|pitfall|watch for|caution|avoid/i, "warning"],
  [/memory|mnemonic|trick/i, "positive"],
  [/other options|wrong|incorrect|option analysis/i, "neutral"],
  [/pearl|high.?yield|key point|important|remember|takeaway|revision|exam tip|examiner|note/i, "primary"],
  [/concept|formula|explanation|principle|mechanism/i, "secondary"],
];

export function cueTone(heading: string): CueTone {
  return CUE_TONES.find(([re]) => re.test(heading))?.[1] ?? "neutral";
}

/** The few cues worth a compact tinted callout (thin left border) rather than a plain section. */
const CALLOUT_HEADINGS = /memory|mnemonic|trick|trap|mistake|pearl|high.?yield/i;

/** Labels that, when they open a line of body text ("Memory Trick: ABCD…"), are rendered as an accented label. */
const INLINE_LABEL =
  /^((?:ExamNet|Examiner) Traps?|Memory Trick|Mnemonic|Key Points?|Clinical Pearls?|Important|High Yield|Concept|Formula|Explanation|Correct Answer|Why This Is Correct|Why (?:the )?Other Options Are Wrong|Option Analysis|Takeaway|Remember|Quick Revision|Common Mistakes?|Exam Tip|Note|Option [A-F])\s*:\s*/i;

/** Renders one body string: a recognised leading cue label is accented, and Markdown **bold** gets real weight. Everything else stays plain body text. */
export function RichText({ text }: { text: string }) {
  const label = text.match(INLINE_LABEL);
  const rest = label ? text.slice(label[0].length) : text;
  return (
    <>
      {label ? (
        <span className="ai-expl-inline-label" data-tone={cueTone(label[1])}>
          {label[1]}:{" "}
        </span>
      ) : null}
      {rest.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
          <strong key={i} className="ai-expl-strong">
            {part.slice(2, -2)}
          </strong>
        ) : (
          part
        )
      )}
    </>
  );
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  const tone = cueTone(heading);
  const callout = CALLOUT_HEADINGS.test(heading);
  return (
    <section className="ai-expl-section" data-tone={tone} data-callout={callout || undefined}>
      <h4 className="ai-expl-heading">{heading}</h4>
      {children}
    </section>
  );
}

function List({ items, ordered }: { items: ReactNode[]; ordered?: boolean }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag className={ordered ? "ai-expl-list list-decimal" : "ai-expl-list list-disc"}>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </Tag>
  );
}

export interface ExplanationLabels {
  concept: string;
  optionAnalysis: string;
  pointsToRemember: string;
  memoryTrick: string;
  examinerTraps: string;
  trapWords: string;
  examinerVariation: string;
}

const DEFAULT_LABELS: ExplanationLabels = {
  concept: "Concept",
  optionAnalysis: "Why the other options are wrong",
  pointsToRemember: "Points to remember",
  memoryTrick: "Memory trick",
  examinerTraps: "Examiner traps",
  trapWords: "Watch for these words",
  examinerVariation: "How the examiner can change this question",
};

/** Never repeats the A/B/C/D options block; that already lives in the question card above this area. */
export function ExplanationContentView({
  content,
  labels,
  extra,
}: {
  content: ExplanationContent;
  labels?: Partial<ExplanationLabels>;
  extra?: ReactNode;
}) {
  const l = { ...DEFAULT_LABELS, ...labels };
  const optionEntries = Object.entries(content.optionAnalysis ?? {});
  return (
    <div className="ai-expl">
      {content.concept ? (
        <Section heading={l.concept}>
          <p className="ai-expl-body">
            <RichText text={content.concept} />
          </p>
        </Section>
      ) : null}

      {optionEntries.length > 0 ? (
        <Section heading={l.optionAnalysis}>
          <dl className="ai-expl-options">
            {optionEntries.map(([label, text]) => (
              <div key={label} className="contents">
                <dt className="ai-expl-option-label">{label}</dt>
                <dd className="ai-expl-body">
                  <RichText text={text} />
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}

      {content.pointsToRemember?.length ? (
        <Section heading={l.pointsToRemember}>
          <List items={content.pointsToRemember.map((p, i) => <RichText key={i} text={p} />)} />
        </Section>
      ) : null}

      {content.memoryTrick ? (
        <Section heading={l.memoryTrick}>
          <p className="ai-expl-body">
            <RichText text={content.memoryTrick} />
          </p>
        </Section>
      ) : null}

      {content.examinerTraps?.length ? (
        <Section heading={l.examinerTraps}>
          <List items={content.examinerTraps.map((t, i) => <RichText key={i} text={t} />)} />
        </Section>
      ) : null}

      {content.trapWords?.length ? (
        <Section heading={l.trapWords}>
          <p className="ai-expl-body">{content.trapWords.join(", ")}</p>
        </Section>
      ) : null}

      {content.examinerVariation ? (
        <Section heading={l.examinerVariation}>
          <p className="ai-expl-body">
            <RichText text={content.examinerVariation} />
          </p>
        </Section>
      ) : null}

      {extra}
    </div>
  );
}

/** A plain extra section (e.g. "Related practice questions") in the same typography. */
export function ExplanationSection({ heading, items, ordered }: { heading: string; items: string[]; ordered?: boolean }) {
  return (
    <Section heading={heading}>
      <List items={items.map((t, i) => <RichText key={i} text={t} />)} ordered={ordered} />
    </Section>
  );
}
