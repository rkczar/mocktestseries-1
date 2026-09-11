import { CircleCheck, Sparkles } from "lucide-react";

import { CtaLink } from "@/components/common/CtaLink";
import type { CtaButtonDTO } from "@/lib/content/types";

import { TestPreviewCard } from "./TestPreviewCard";

const TRUST_ITEMS = ["No card required", "Real exam interface", "Instant analysis"];

export function HeroSection({
  eyebrow,
  heading,
  description,
  primaryCta,
  secondaryCta,
}: {
  eyebrow: string;
  heading: string;
  description: string;
  primaryCta: CtaButtonDTO;
  secondaryCta: CtaButtonDTO;
}) {
  const headingLines = heading.split("\n");

  return (
    <section className="border-b border-border bg-surface">
      <div className="mx-auto grid max-w-[1200px] grid-cols-[repeat(auto-fit,minmax(320px,1fr))] items-center gap-x-14 gap-y-10 px-6 py-[clamp(44px,6vw,80px)]">
        <div className="min-w-0">
          {eyebrow ? (
            <div className="mb-[22px] inline-flex items-center gap-2 rounded-full border border-primary-border bg-primary-tint py-1.5 pr-3 pl-2">
              <Sparkles className="size-[15px] text-brand-accent" strokeWidth={2} />
              <span className="font-mono text-[11.5px] font-semibold tracking-[.06em] text-primary uppercase">
                {eyebrow}
              </span>
            </div>
          ) : null}
          <h1 className="font-display text-[clamp(38px,5.2vw,60px)] leading-[1.06] font-bold tracking-[-.02em] text-text-heading text-balance">
            {headingLines.map((line, i) => (
              <span key={line}>
                {line}
                {i < headingLines.length - 1 ? <br /> : null}
              </span>
            ))}
          </h1>
          <p className="mt-5 max-w-[52ch] text-[clamp(16px,1.4vw,18.5px)] leading-relaxed text-text-muted text-pretty">
            {description}
          </p>
          <div className="mt-[30px] flex flex-wrap gap-3">
            <CtaLink href={primaryCta.href} variant="primary" icon>
              {primaryCta.label}
            </CtaLink>
            <CtaLink href={secondaryCta.href} variant="secondary">
              {secondaryCta.label}
            </CtaLink>
          </div>
          <ul className="mt-7 flex flex-wrap gap-x-6.5 gap-y-2.5">
            {TRUST_ITEMS.map((item) => (
              <li key={item} className="flex items-center gap-2 text-sm text-text-muted">
                <CircleCheck className="size-4 text-success" strokeWidth={2.4} />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="min-w-0">
          <TestPreviewCard />
        </div>
      </div>
    </section>
  );
}
