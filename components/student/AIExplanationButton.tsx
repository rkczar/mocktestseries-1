"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";

export function AIExplanationButton({
  attemptId,
  questionId,
  initialExplanation,
}: {
  attemptId: string;
  questionId: string;
  initialExplanation: string | null;
}) {
  const [explanation, setExplanation] = useState(initialExplanation);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/ai/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptId, questionId }),
      });
      const data = (await response.json()) as { explanation?: string; error?: string };
      if (!response.ok || !data.explanation) {
        throw new Error(data.error ?? "Something went wrong.");
      }
      setExplanation(data.explanation);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  if (explanation) {
    return (
      <div className="mt-3 rounded-[10px] border border-primary-border bg-primary-tint p-3.5">
        <p className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-bold tracking-[.04em] text-primary uppercase">
          <Sparkles className="size-3.5" strokeWidth={2} />
          AI walkthrough
        </p>
        <p className="text-[14px] leading-relaxed whitespace-pre-line text-text">{explanation}</p>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-[9px] border border-primary-border bg-primary-tint px-3.5 py-2 text-[13px] font-bold text-primary hover:bg-primary-tint/70 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Sparkles className="size-3.5" strokeWidth={2} />
        {loading ? "Thinking…" : "Get AI explanation"}
      </button>
      {error ? <p className="mt-1.5 text-[13px] text-error">{error}</p> : null}
    </div>
  );
}
