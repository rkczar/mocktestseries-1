import type { Metadata } from "next";

import { Container } from "@/components/common/Container";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern using MockTestSeries.in.",
};

export default function TermsPage() {
  return (
    <Container className="max-w-[760px] py-[clamp(28px,4vw,48px)]">
      <h1 className="font-display text-[clamp(28px,3.4vw,36px)] font-bold tracking-[-.02em] text-text-heading">
        Terms of Service
      </h1>
      <p className="mt-3 rounded-[10px] border border-brand-accent-border bg-brand-accent-tint px-4 py-3 text-sm text-brand-accent-text">
        Draft starting terms — replace with a version reviewed by qualified counsel before
        relying on it as your binding terms of service.
      </p>

      <div className="mt-6 flex flex-col gap-6 text-[15px] leading-relaxed text-text-muted">
        <section>
          <h2 className="text-base font-extrabold text-text-heading">Using the platform</h2>
          <p className="mt-1.5">
            Your account is personal to you — don&apos;t share login credentials or test content
            in a way that undermines the integrity of a mock exam. We can suspend accounts used
            to abuse the platform.
          </p>
        </section>
        <section>
          <h2 className="text-base font-extrabold text-text-heading">Content</h2>
          <p className="mt-1.5">
            Questions, explanations and other test content are provided for personal exam
            preparation. Reproducing or redistributing them outside the platform isn&apos;t
            permitted.
          </p>
        </section>
        <section>
          <h2 className="text-base font-extrabold text-text-heading">No exam guarantee</h2>
          <p className="mt-1.5">
            Mock tests are practice material based on publicly available exam patterns and past
            papers. We don&apos;t guarantee they match the exact content of any future official
            exam.
          </p>
        </section>
        <section>
          <h2 className="text-base font-extrabold text-text-heading">Changes</h2>
          <p className="mt-1.5">
            We may update these terms as the platform changes. Continued use after an update
            means you accept the revised terms.
          </p>
        </section>
      </div>
    </Container>
  );
}
