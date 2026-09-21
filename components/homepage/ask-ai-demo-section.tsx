import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { getHomepageAiDemoQuestions } from "@/lib/homepage-ai-demo";
import { TryAiNowPlayer } from "./try-ai-now-player";

const SECTION_WRAP = "mx-auto w-full max-w-2xl px-4 py-14 sm:px-6 sm:py-20";

/**
 * Public homepage "Try AI Now" mini test. Anonymous visitors never trigger
 * live AI generation here — getHomepageAiDemoQuestions only ever reads
 * AIExplanation rows that already exist (COMPLETED), that an admin has
 * explicitly marked reviewed and selected (or, absent a curated selection,
 * the most recently reviewed eligible rows), and that haven't gone stale
 * since. Capped at 10 questions server-side regardless of admin
 * configuration. Answers and score are computed entirely client-side and
 * are never written to the Student/TestAttempt tables — this is a demo,
 * not a real attempt.
 */
export async function AskAiDemoSection() {
  const questions = await getHomepageAiDemoQuestions();
  if (questions.length === 0) return null;

  return (
    <section id="try-ai-now" className="scroll-mt-20 border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className={SECTION_WRAP}>
        <div className="flex items-center justify-center gap-2">
          <Sparkles className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
          <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">Try AI Now</h2>
          <Badge variant="info">Live Demo</Badge>
        </div>
        <p className="mt-2 text-center text-[var(--color-muted-foreground)]">
          Experience AI-Powered Question Review — answer {questions.length} real questions and see the AI explanation instantly.
        </p>

        <div className="mt-8">
          <TryAiNowPlayer questions={questions} />
        </div>
      </div>
    </section>
  );
}
