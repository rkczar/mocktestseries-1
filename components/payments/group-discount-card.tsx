import { Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { WhatsAppGlyph } from "@/components/support/whatsapp-support-button";

const TIERS = [
  { students: 2, off: 20 },
  { students: 5, off: 40 },
  { students: 10, off: 50 },
] as const;

/**
 * Display-only group discount promo (Admin → Payments → Products & Pricing →
 * Show Group Discount Offer). The button only opens WhatsApp; coupons are
 * shared manually and redeemed through the normal checkout.
 */
export function GroupDiscountCard({ whatsappHref }: { whatsappHref: string }) {
  return (
    <Card
      data-testid="group-discount-card"
      className="mt-6 overflow-hidden border-[var(--color-primary)]/40 bg-gradient-to-br from-[var(--color-primary)]/10 via-[var(--color-card)] to-[var(--color-success)]/10"
    >
      <CardContent className="flex flex-col gap-5 p-5 sm:p-6 md:flex-row md:items-center md:justify-between md:gap-8">
        <div className="flex min-w-0 flex-col gap-2">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-primary)]">
            <Users className="h-4 w-4" aria-hidden /> Group offer
          </p>
          <h3 className="text-xl font-bold text-[var(--color-foreground)] sm:text-2xl">STUDY TOGETHER, SAVE MORE!</h3>
          <p className="text-sm font-medium text-[var(--color-foreground)]">Special Group Discounts for RUHS MO 2026 Aspirants</p>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Preparing with friends? Get an exclusive group discount on your MockTestSeries subscription!
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-4 md:w-80">
          <ul className="grid grid-cols-3 gap-2" aria-label="Group discounts">
            {TIERS.map((t) => (
              <li
                key={t.students}
                className="flex flex-col items-center rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] px-2 py-3 text-center"
              >
                <span className="text-xl font-bold text-[var(--color-primary)] sm:text-2xl">{t.off}% OFF</span>
                <span className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">{t.students} Students</span>
              </li>
            ))}
          </ul>
          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Contact Us on WhatsApp (opens in a new tab)"
            data-testid="group-discount-whatsapp"
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-button)] bg-[#25D366] px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-transform duration-150 ease-out hover:brightness-95 active:scale-[0.98] focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-[var(--color-primary)]"
          >
            <WhatsAppGlyph className="h-5 w-5" />
            Contact Us on WhatsApp
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
