import { BarChart3, FileText, Monitor, Sparkles } from "lucide-react";

const ITEMS = [
  { icon: FileText, title: "Exam-focused Questions", subtitle: "Mapped to the real syllabus" },
  { icon: Sparkles, title: "AI Explanations", subtitle: "On every single question" },
  { icon: BarChart3, title: "Detailed Analysis", subtitle: "Accuracy, speed, weak topics" },
  { icon: Monitor, title: "Real Exam Experience", subtitle: "Timed, palette-based UI" },
];

export function TrustStrip() {
  return (
    <section className="border-b border-border bg-surface">
      <div className="mx-auto grid max-w-[1200px] grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-5 px-6 py-7">
        {ITEMS.map((item) => (
          <div key={item.title} className="flex min-w-0 items-start gap-3">
            <item.icon className="mt-0.5 size-5 flex-none text-primary" strokeWidth={1.9} />
            <div className="min-w-0">
              <p className="text-[15px] font-bold text-text">{item.title}</p>
              <p className="mt-0.5 text-[13.5px] text-text-faint">{item.subtitle}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
