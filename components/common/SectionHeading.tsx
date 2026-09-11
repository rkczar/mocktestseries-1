import { cn } from "@/lib/utils";

import { EyebrowLabel } from "./EyebrowLabel";

export function SectionHeading({
  eyebrow,
  title,
  className,
  headingClassName,
}: {
  eyebrow?: string;
  title: string;
  className?: string;
  headingClassName?: string;
}) {
  return (
    <div className={className}>
      {eyebrow ? <EyebrowLabel>{eyebrow}</EyebrowLabel> : null}
      <h2
        className={cn(
          "font-display text-[clamp(27px,3vw,38px)] leading-[1.15] font-bold tracking-[-.015em] text-text-heading",
          eyebrow && "mt-2",
          headingClassName,
        )}
      >
        {title}
      </h2>
    </div>
  );
}
