import { CtaLink } from "@/components/common/CtaLink";
import type { CtaButtonDTO } from "@/lib/content/types";

export function FinalCtaSection({
  heading,
  body,
  note,
  primaryCta,
  secondaryCta,
}: {
  heading: string;
  body: string;
  note: string | null;
  primaryCta: CtaButtonDTO;
  secondaryCta: CtaButtonDTO;
}) {
  return (
    <section className="py-[clamp(56px,7vw,92px)]">
      <div className="mx-auto max-w-[1200px] px-6">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] items-center gap-x-12 gap-y-8 rounded-[20px] bg-primary p-[clamp(32px,5vw,56px)]">
          <div className="min-w-0">
            <h2 className="font-display text-[clamp(27px,3.2vw,40px)] leading-[1.12] font-bold tracking-[-.015em] text-white text-balance">
              {heading}
            </h2>
            <p className="mt-3.5 max-w-[46ch] text-[16.5px] leading-relaxed text-panel-foreground">
              {body}
            </p>
          </div>
          <div className="flex min-w-0 flex-col items-start gap-3">
            <div className="flex flex-wrap gap-3">
              <CtaLink href={primaryCta.href} variant="accent" icon>
                {primaryCta.label}
              </CtaLink>
              <CtaLink href={secondaryCta.href} variant="ghost">
                {secondaryCta.label}
              </CtaLink>
            </div>
            {note ? (
              <p className="font-mono text-xs tracking-[.03em] text-panel-faint">{note}</p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
