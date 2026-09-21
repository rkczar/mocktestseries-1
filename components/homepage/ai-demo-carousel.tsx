"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { AiDemoQuestion } from "@/lib/homepage-ai-demo";

/**
 * Client-only navigation over data already fetched server-side
 * (getHomepageAiDemoQuestions) — flipping between questions never issues a
 * network request, so an anonymous visitor can browse all of them without
 * ever triggering a provider call.
 */
export function AiDemoCarousel({ questions }: { questions: AiDemoQuestion[] }) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const q = questions[index];
  if (!q) return null;

  const optionEntries = Object.entries(q.content.optionAnalysis ?? {});

  const goTo = (next: number) => {
    setIndex(((next % questions.length) + questions.length) % questions.length);
    setRevealed(false);
  };

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 sm:p-6">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="neutral">{q.code}</Badge>
        <span className="text-xs text-[var(--color-muted-foreground)]">
          {index + 1} / {questions.length}
        </span>
      </div>

      <p className="mt-3 text-base font-medium text-[var(--color-foreground)]">{q.text}</p>

      <div className="mt-3 flex flex-col gap-2">
        {q.options.map((opt) => {
          const showState = revealed && opt.isCorrect;
          const showWrong = revealed && !opt.isCorrect;
          return (
            <div
              key={opt.label}
              className={`flex items-center gap-2 rounded-[var(--radius-button)] border px-3 py-2 text-sm ${
                showState
                  ? "border-[var(--color-success)]/50 bg-[var(--color-success)]/10"
                  : showWrong
                    ? "border-[var(--color-border)] opacity-60"
                    : "border-[var(--color-border)]"
              }`}
            >
              <span className="font-medium">{opt.label}.</span> {opt.text}
              {showState ? <CheckCircle2 className="ml-auto h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden /> : null}
            </div>
          );
        })}
      </div>

      {!revealed ? (
        <Button size="sm" variant="outline" className="mt-4" onClick={() => setRevealed(true)}>
          Reveal AI Explanation
        </Button>
      ) : (
        <div className="mt-4 flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-info)]/30 bg-[var(--color-info)]/5 p-4 text-sm text-[var(--color-foreground)]">
          {q.content.concept ? (
            <p>
              <span className="font-medium">Why it&apos;s correct: </span>
              {q.content.concept}
            </p>
          ) : null}

          {optionEntries.length > 0 ? (
            <div>
              <p className="font-medium">Why the other options are wrong</p>
              <div className="mt-1 flex flex-col gap-1">
                {optionEntries.map(([label, text]) => (
                  <p key={label} className="flex items-start gap-1.5">
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-error)]" aria-hidden />
                    <span>
                      <span className="font-medium">{label} — </span>
                      {text}
                    </span>
                  </p>
                ))}
              </div>
            </div>
          ) : null}

          {q.content.pointsToRemember?.length ? (
            <div>
              <p className="font-medium">Points to remember</p>
              <ul className="mt-1 list-disc pl-5">
                {q.content.pointsToRemember.map((point, i) => (
                  <li key={i}>{point}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {q.content.memoryTrick ? (
            <p>
              <span className="font-medium">Memory trick: </span>
              {q.content.memoryTrick}
            </p>
          ) : null}

          {q.content.examinerTraps?.length ? (
            <div>
              <p className="font-medium">Examiner traps</p>
              <ul className="mt-1 list-disc pl-5">
                {q.content.examinerTraps.map((trap, i) => (
                  <li key={i}>{trap}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {q.content.examinerVariation ? (
            <p>
              <span className="font-medium">Related variant: </span>
              {q.content.examinerVariation}
            </p>
          ) : null}
        </div>
      )}

      {questions.length > 1 ? (
        <div className="mt-5 flex items-center justify-between gap-2">
          <Button variant="outline" size="sm" onClick={() => goTo(index - 1)}>
            <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
          </Button>
          <Button variant="outline" size="sm" onClick={() => goTo(index + 1)}>
            Next <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
