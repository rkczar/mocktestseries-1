import { SectionHeading } from "@/components/common/SectionHeading";
import type { TestSeriesCardDTO } from "@/lib/content/types";

import { TestSeriesCard } from "./TestSeriesCard";

export function PopularTestSeriesSection({ series }: { series: TestSeriesCardDTO[] }) {
  if (series.length === 0) return null;

  return (
    <section className="border-y border-border bg-surface py-[clamp(56px,7vw,92px)]">
      <div className="mx-auto max-w-[1200px] px-6">
        <SectionHeading
          eyebrow="Popular Test Series"
          title="Three ways to practice"
          headingClassName="max-w-[22ch]"
        />
        <div className="mt-7 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-5">
          {series.map((item) => (
            <TestSeriesCard key={item.slug} series={item} />
          ))}
        </div>
      </div>
    </section>
  );
}
