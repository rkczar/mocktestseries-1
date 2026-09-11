import { ArrowRight, Sparkles } from "lucide-react";

export function AiExplanationPanel() {
  return (
    <div className="min-w-0 overflow-hidden rounded-2xl border border-primary-border bg-surface shadow-[0_14px_40px_-26px_rgba(15,76,129,.4)]">
      <div className="flex items-center gap-2.5 bg-primary px-5 py-[15px]">
        <Sparkles className="size-4 text-white" strokeWidth={2} />
        <span className="font-mono text-[11.5px] font-semibold tracking-[.08em] text-white uppercase">
          AI Explanation · Q14
        </span>
      </div>
      <div className="flex flex-col gap-3.5 p-5">
        <div>
          <p className="text-[13px] font-extrabold tracking-[.02em] text-success uppercase">
            Why Correct?
          </p>
          <p className="mt-1.5 text-[14.5px] leading-relaxed text-text-muted">
            Lorazepam has a longer duration of anticonvulsant action than diazepam because of
            lower lipid solubility, so seizure control lasts longer after a single dose.
          </p>
        </div>
        <div className="h-px bg-border-subtle" />
        <div>
          <p className="text-[13px] font-extrabold tracking-[.02em] text-error uppercase">
            Why Others Wrong?
          </p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            <li className="text-[14.5px] leading-snug text-text-muted">
              <span className="font-bold text-text">A. Phenytoin</span> — second-line; slow
              loading, risk of hypotension.
            </li>
            <li className="text-[14.5px] leading-snug text-text-muted">
              <span className="font-bold text-text">C. Valproate</span> — alternative
              second-line, not first choice.
            </li>
          </ul>
        </div>
        <div className="h-px bg-border-subtle" />
        <div className="rounded-[11px] border border-brand-accent-border bg-brand-accent-tint p-3.5">
          <p className="text-[12.5px] font-extrabold tracking-[.04em] text-brand-accent-text uppercase">
            Exam Pearl
          </p>
          <p className="mt-1.5 text-[14.5px] leading-snug text-[#5B4526]">
            Status epilepticus: benzodiazepine first, always. Then load an anti-epileptic.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
          <span className="min-w-0 flex-1 basis-40 rounded-[9px] border border-border-strong bg-background px-3.5 py-3 text-sm text-text-placeholder">
            Ask a follow-up question…
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-[9px] bg-primary px-4 py-3 text-sm font-bold text-white">
            Ask AI
            <ArrowRight className="size-[15px]" strokeWidth={2.2} />
          </span>
        </div>
      </div>
    </div>
  );
}
