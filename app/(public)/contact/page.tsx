import type { Metadata } from "next";
import { Mail } from "lucide-react";

import { Container } from "@/components/common/Container";

export const metadata: Metadata = {
  title: "Contact Us",
  description: "Get in touch with the MockTestSeries.in team.",
};

const SUPPORT_EMAIL = "support@mocktestseries.in";

export default function ContactPage() {
  return (
    <Container className="py-[clamp(28px,4vw,48px)]">
      <p className="font-mono text-[11.5px] font-semibold tracking-[.1em] text-brand-accent-text uppercase">
        Contact
      </p>
      <h1 className="mt-2 font-display text-[clamp(28px,3.4vw,40px)] leading-[1.1] font-bold tracking-[-.02em] text-text-heading">
        Get in touch
      </h1>
      <p className="mt-3 max-w-[60ch] text-[15.5px] leading-relaxed text-text-muted">
        Questions about an exam, a test result, or your account — email us and we&apos;ll get
        back to you.
      </p>
      <a
        href={`mailto:${SUPPORT_EMAIL}`}
        className="mt-6 inline-flex items-center gap-2.5 rounded-[10px] bg-primary px-6 py-[15px] text-base font-bold text-primary-foreground hover:bg-primary-hover"
      >
        <Mail className="size-[18px]" strokeWidth={2.2} />
        {SUPPORT_EMAIL}
      </a>
    </Container>
  );
}
