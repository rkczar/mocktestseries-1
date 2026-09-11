import { SubmitButton } from "@/components/auth/SubmitButton";

import { updateSectionsAction } from "./actions";

const SECTION_LABELS: Record<string, string> = {
  hero: "Hero",
  trust: "Trust strip",
  featured_exams: "Featured exams",
  popular_series: "Popular test series",
  ai_usp: "AI explanation feature",
  why_us: "Why us",
  how_it_works: "How it works",
  upcoming: "Upcoming exams",
  final_cta: "Final CTA",
};

export function SectionsTab({
  sections,
}: {
  sections: { key: string; order: number; isVisible: boolean }[];
}) {
  return (
    <form action={updateSectionsAction} className="max-w-2xl">
      <table className="w-full border-separate border-spacing-y-2 text-sm">
        <thead>
          <tr className="text-left text-[12px] font-bold text-text-faint uppercase">
            <th className="pb-1">Section</th>
            <th className="w-24 pb-1">Order</th>
            <th className="w-24 pb-1">Visible</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <tr key={section.key} className="rounded-lg bg-surface">
              <td className="rounded-l-lg border border-r-0 border-border px-3 py-2.5 font-semibold text-text-heading">
                <input type="hidden" name="key" value={section.key} />
                {SECTION_LABELS[section.key] ?? section.key}
              </td>
              <td className="border-y border-border px-3 py-2.5">
                <input
                  type="number"
                  name={`order_${section.key}`}
                  defaultValue={section.order}
                  className="h-8 w-16 rounded-[6px] border border-border-strong px-2 text-sm"
                />
              </td>
              <td className="rounded-r-lg border border-l-0 border-border px-3 py-2.5">
                <input
                  type="checkbox"
                  name={`isVisible_${section.key}`}
                  defaultChecked={section.isVisible}
                  className="size-4 accent-primary"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <SubmitButton className="mt-4 w-fit px-6">Save order & visibility</SubmitButton>
    </form>
  );
}
