import type { Metadata } from "next";

import { Container } from "@/components/common/Container";

export const metadata: Metadata = {
  title: "About",
  description: "What MockTestSeries.in is and how it helps you prepare.",
};

export default function AboutPage() {
  return (
    <Container className="py-[clamp(28px,4vw,48px)]">
      <p className="font-mono text-[11.5px] font-semibold tracking-[.1em] text-brand-accent-text uppercase">
        About
      </p>
      <h1 className="mt-2 font-display text-[clamp(28px,3.4vw,40px)] leading-[1.1] font-bold tracking-[-.02em] text-text-heading">
        Practice smart, understand every answer
      </h1>
      <div className="mt-5 flex max-w-[65ch] flex-col gap-4 text-[15.5px] leading-relaxed text-text-muted">
        <p>
          MockTestSeries.in builds exam-realistic mock tests for India&apos;s competitive and
          recruitment exams, timed and structured the way the real exam is — question palette,
          negative marking, and a proper OMR-style interface where the exam calls for one.
        </p>
        <p>
          What sets it apart is what happens after you submit: every question comes with an AI
          explanation covering why the correct answer is right, why each wrong option is wrong,
          the underlying concept, and a memory trick to make it stick — not just a score.
        </p>
        <p>
          Exams, test series and pricing are managed from an admin panel, so new exams and
          content go live without changing any code. The first exam on the platform is the RUHS
          Medical Officer 2026 recruitment.
        </p>
      </div>
    </Container>
  );
}
