import { Check, Sparkles, StickyNote, Target, X, Zap } from "lucide-react";

import { SectionHeading } from "@/components/common/SectionHeading";

import { AiExplanationPanel } from "./AiExplanationPanel";

const CHIPS = [
  { icon: Check, label: "Why Correct?", tone: "text-success" },
  { icon: X, label: "Why Others Wrong?", tone: "text-error" },
  { icon: Target, label: "Core Concept", tone: "text-primary" },
  { icon: Zap, label: "Exam Pearl", tone: "text-brand-accent" },
  { icon: StickyNote, label: "Memory Trick", tone: "text-primary" },
] as const;

export function AiUspSection() {
  return (
    <section className="py-[clamp(56px,7vw,92px)]">
      <div className="mx-auto grid max-w-[1200px] grid-cols-[repeat(auto-fit,minmax(300px,1fr))] items-start gap-x-14 gap-y-9 px-6">
        <div className="min-w-0">
          <SectionHeading
            eyebrow="The AI difference"
            title="Every question comes with a full explanation"
          />
          <p className="mt-3.5 max-w-[48ch] text-base leading-relaxed text-text-muted text-pretty">
            Scores tell you where you stand. Explanations tell you what to fix. After each
            question the AI breaks the answer down five ways — and stays available for
            follow-up questions.
          </p>
          <ul className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
            {CHIPS.map((chip) => (
              <li
                key={chip.label}
                className="flex items-center gap-2.5 rounded-[10px] border border-border bg-surface px-3.5 py-3.5 text-[14.5px] font-bold text-text-heading"
              >
                <chip.icon className={`size-[17px] flex-none ${chip.tone}`} strokeWidth={2.2} />
                {chip.label}
              </li>
            ))}
            <li className="flex items-center gap-2.5 rounded-[10px] border border-primary bg-primary px-3.5 py-3.5 text-[14.5px] font-bold text-primary-foreground">
              <Sparkles className="size-[17px] flex-none text-primary-foreground" strokeWidth={2} />
              Ask AI
            </li>
          </ul>
        </div>

        <AiExplanationPanel />
      </div>
    </section>
  );
}
