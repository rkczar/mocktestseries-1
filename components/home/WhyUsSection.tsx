import { BarChart3, Monitor, RotateCcw, Target } from "lucide-react";

const CARDS = [
  {
    icon: Monitor,
    title: "Real Exam Experience",
    body: "Timer, question palette, mark-for-review and submit flow that match the real test.",
  },
  {
    icon: BarChart3,
    title: "Performance Analytics",
    body: "Accuracy, time per question, subject splits and progress across attempts.",
  },
  {
    icon: Target,
    title: "Weak Topic Detection",
    body: "The topics costing you the most marks, ranked, with practice sets attached.",
  },
  {
    icon: RotateCcw,
    title: "Practice Again",
    body: "Retake any test, or build a fresh set from only the questions you got wrong.",
  },
];

export function WhyUsSection() {
  return (
    <section className="border-y border-border bg-surface py-[clamp(56px,7vw,92px)]">
      <div className="mx-auto max-w-[1200px] px-6">
        <h2 className="max-w-[26ch] font-display text-[clamp(27px,3vw,38px)] leading-[1.15] font-bold tracking-[-.015em] text-text-heading">
          Why MockTestSeries.in
        </h2>
        <div className="mt-7 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
          {CARDS.map((card) => (
            <div key={card.title} className="rounded-[14px] border border-border bg-background p-5.5">
              <span className="flex size-10 items-center justify-center rounded-[11px] border border-primary-border bg-surface">
                <card.icon className="size-5 text-primary" strokeWidth={1.9} />
              </span>
              <h3 className="mt-4 text-[17px] font-extrabold text-text-heading">{card.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-text-muted">{card.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
