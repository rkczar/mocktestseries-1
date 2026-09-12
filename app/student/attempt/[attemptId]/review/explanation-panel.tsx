"use client";

import { useState, useTransition } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { QuestionSnapshot } from "@/lib/test-attempt";
import { getExplanationAction } from "../actions";

export function ExplanationPanel({ questionId, snapshot }: { questionId: string; snapshot: QuestionSnapshot }) {
  const [isPending, startTransition] = useTransition();
  const [content, setContent] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      const result = await getExplanationAction(questionId, snapshot);
      if (result.ok) {
        setContent(result.content);
      } else {
        setError(result.error);
      }
    });
  };

  if (content) {
    const whyNotEntries = Object.entries(content).filter(([key]) => key.startsWith("whyNot"));
    return (
      <div className="mt-4 rounded-[var(--radius-card)] border border-[var(--color-info)]/30 bg-[var(--color-info)]/5 p-4">
        <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-[var(--color-info)]">
          <Sparkles className="h-4 w-4" aria-hidden /> AI Explanation
        </p>
        <div className="flex flex-col gap-2 text-sm text-[var(--color-foreground)]">
          {content.whyCorrect ? (
            <p>
              <span className="font-medium">Why it&apos;s correct: </span>
              {content.whyCorrect}
            </p>
          ) : null}
          {whyNotEntries.map(([key, value]) => (
            <p key={key}>
              <span className="font-medium">Why not {key.replace("whyNot", "")}: </span>
              {value}
            </p>
          ))}
          {content.memoryTrick ? (
            <p>
              <span className="font-medium">Memory trick: </span>
              {content.memoryTrick}
            </p>
          ) : null}
          {content.rephrase ? (
            <p>
              <span className="font-medium">Rephrased: </span>
              {content.rephrase}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4">
      <Button variant="outline" size="sm" onClick={handleClick} disabled={isPending}>
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
        {isPending ? "Generating…" : "Get AI Explanation"}
      </Button>
      {error ? <p className="mt-2 text-sm text-[var(--color-error)]">{error}</p> : null}
    </div>
  );
}
