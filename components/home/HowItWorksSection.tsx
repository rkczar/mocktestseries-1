import { SectionHeading } from "@/components/common/SectionHeading";

const STEPS = [
  {
    number: "01",
    title: "Choose Exam",
    body: "Pick your exam and the test series that fits where you are.",
  },
  {
    number: "02",
    title: "Take Test",
    body: "Attempt it under real exam timing and interface conditions.",
  },
  {
    number: "03",
    title: "Understand With AI",
    body: "Go through every question with the AI explanation, then ask follow-ups.",
  },
  {
    number: "04",
    title: "Analyze & Improve",
    body: "Review analytics, fix weak topics, retake and compare.",
  },
];

export function HowItWorksSection() {
  return (
    <section className="py-[clamp(56px,7vw,92px)]">
      <div className="mx-auto max-w-[1200px] px-6">
        <SectionHeading eyebrow="How it works" title="Four steps, start to improvement" />
        <div className="mt-7.5 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-5">
          {STEPS.map((step, i) => (
            <div
              key={step.number}
              className={
                i === 0
                  ? "border-t-2 border-primary pt-4.5"
                  : "border-t-2 border-primary-border pt-4.5"
              }
            >
              <p className="font-mono text-[13px] font-semibold tracking-[.06em] text-brand-accent-text">
                {step.number}
              </p>
              <h3 className="mt-2.5 text-lg font-extrabold text-text-heading">{step.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-text-muted">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
