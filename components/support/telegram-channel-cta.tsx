import { Send } from "lucide-react";

/**
 * "Join Our Telegram Channel" call to action. Rendered only when
 * lib/telegram-channel.ts returns a validated link for the surface.
 */
export function TelegramChannelCta({ href, variant = "section" }: { href: string; variant?: "section" | "card" }) {
  const body = (
    <div
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5 shadow-[var(--shadow-card)] sm:flex-row sm:items-center sm:justify-between sm:p-6"
      data-testid="telegram-cta"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#229ED9]/15 text-[#229ED9]" aria-hidden>
          <Send className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-[var(--color-foreground)] sm:text-lg">Join Our Telegram Channel</h2>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Get daily updates, new mock tests, previous year questions, exam announcements and important notifications.
          </p>
        </div>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-button)] bg-[#229ED9] px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#229ED9]"
      >
        <Send className="h-4 w-4" aria-hidden />
        Join Telegram Channel
      </a>
    </div>
  );
  if (variant === "card") return body;
  return (
    <section id="telegram-channel" aria-label="Telegram channel" className="border-t border-[var(--color-border)]">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">{body}</div>
    </section>
  );
}
