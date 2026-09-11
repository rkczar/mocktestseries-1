import { Check, Clock, Sparkles } from "lucide-react";

const OPTIONS = [
  { key: "A", text: "Phenytoin", correct: false },
  { key: "B", text: "Lorazepam", correct: true },
  { key: "C", text: "Valproate", correct: false },
] as const;

export function TestPreviewCard() {
  return (
    <div>
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] font-semibold tracking-[.1em] text-text-faint uppercase">
          Interactive Test Preview
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-error-border bg-error-tint px-2.5 py-1 font-mono text-[11.5px] font-semibold text-error">
          <Clock className="size-[13px]" strokeWidth={2.2} />
          18:24
        </span>
      </div>

      <div className="overflow-hidden rounded-2xl border border-primary-border bg-surface shadow-[0_14px_40px_-22px_rgba(15,76,129,.35)]">
        <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-border-subtle px-5 py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="text-[13px] font-bold whitespace-nowrap text-primary">Q 14 / 100</span>
            <span className="h-4 w-px bg-border" />
            <span className="text-[13px] whitespace-nowrap text-text-faint">Pharmacology</span>
          </div>
          <div className="flex gap-1.5">
            <span className="size-[22px] rounded-md bg-success" />
            <span className="size-[22px] rounded-md bg-error" />
            <span className="size-[22px] rounded-md bg-brand-accent" />
            <span className="size-[22px] rounded-md bg-border" />
            <span className="size-[22px] rounded-md bg-border" />
          </div>
        </div>

        <div className="px-5 pt-[22px] pb-5">
          <p className="text-[16.5px] leading-normal font-semibold text-text text-pretty">
            Which of the following is the drug of choice for status epilepticus in the emergency
            setting?
          </p>
          <ul className="mt-[18px] flex flex-col gap-2.5">
            {OPTIONS.map((option) => (
              <li
                key={option.key}
                className={
                  option.correct
                    ? "flex items-center gap-2.5 rounded-[10px] border-[1.5px] border-success bg-success-tint px-3.5 py-3.5 text-[15px] font-semibold text-success-text"
                    : "flex items-center gap-2.5 rounded-[10px] border border-border px-3.5 py-3.5 text-[15px] text-text-muted"
                }
              >
                <span
                  className={
                    option.correct
                      ? "flex size-[26px] flex-none items-center justify-center rounded-[7px] bg-success font-mono text-[12.5px] font-semibold text-white"
                      : "flex size-[26px] flex-none items-center justify-center rounded-[7px] border border-border-strong font-mono text-[12.5px] font-semibold text-text-faint"
                  }
                >
                  {option.key}
                </span>
                {option.text}
                {option.correct ? (
                  <Check className="ml-auto size-[17px] flex-none text-success" strokeWidth={2.4} />
                ) : null}
              </li>
            ))}
          </ul>

          <div className="mt-4 rounded-[11px] border border-primary-border bg-primary-tint px-[15px] py-3.5">
            <div className="flex items-center gap-2">
              <Sparkles className="size-[15px] text-primary" strokeWidth={2} />
              <span className="font-mono text-[11px] font-semibold tracking-[.08em] text-primary uppercase">
                AI Explanation
              </span>
            </div>
            <p className="mt-2.5 text-sm leading-normal text-text-muted">
              Benzodiazepines act fastest by enhancing GABA-A inhibition. Lorazepam is preferred
              over diazepam for its longer anticonvulsant duration.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="rounded-full border border-border-strong bg-surface px-2.5 py-1 text-xs font-semibold text-primary">
                Why others wrong?
              </span>
              <span className="rounded-full border border-border-strong bg-surface px-2.5 py-1 text-xs font-semibold text-primary">
                Core concept
              </span>
              <span className="rounded-full border border-brand-accent-border bg-brand-accent-tint px-2.5 py-1 text-xs font-semibold text-brand-accent-text">
                Memory trick
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
