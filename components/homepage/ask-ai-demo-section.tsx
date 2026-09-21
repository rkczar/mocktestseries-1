import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { getHomepageAiDemoQuestions } from "@/lib/homepage-ai-demo";
import { AiDemoCarousel } from "./ai-demo-carousel";

const SECTION_WRAP = "mx-auto w-full max-w-3xl px-4 py-14 sm:px-6 sm:py-20";

/**
 * Public homepage preview of Ask AI ("AI Explanation Demo"). Anonymous
 * visitors never trigger live generation here — getHomepageAiDemoQuestions
 * only ever reads AIExplanation rows that already exist (COMPLETED), that
 * an admin has explicitly marked reviewed and selected (or, absent a
 * curated selection, the most recently reviewed eligible rows), and that
 * haven't gone stale since. Capped at 10 questions server-side regardless
 * of admin configuration.
 */
export async function AskAiDemoSection() {
  const questions = await getHomepageAiDemoQuestions();
  if (questions.length === 0) return null;

  return (
    <section className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className={SECTION_WRAP}>
        <div className="flex items-center justify-center gap-2">
          <Sparkles className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
          <h2 className="text-2xl text-[var(--color-foreground)] sm:text-3xl">Ask AI in Action</h2>
          <Badge variant="info">AI Explanation Demo</Badge>
        </div>
        <p className="mt-2 text-center text-[var(--color-muted-foreground)]">
          Real, admin-reviewed AI explanations — browse a few, then sign up to Ask AI on any question.
        </p>

        <div className="mt-8">
          <AiDemoCarousel questions={questions} />
        </div>

        <p className="mt-6 text-center text-sm text-[var(--color-muted-foreground)]">
          <a href="/login" className="font-medium text-[var(--color-primary)] hover:underline">
            Create a free account
          </a>{" "}
          to practice more questions and get AI explanations on demand.
        </p>
      </div>
    </section>
  );
}
