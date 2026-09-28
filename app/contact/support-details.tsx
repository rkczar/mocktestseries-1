import Link from "next/link";
import { Mail, MapPin, Phone, Building2 } from "lucide-react";
import { getPublicChrome } from "@/components/homepage/public-page-shell";
import { str } from "@/components/homepage/content-helpers";
import { composeSellerAddress, getInvoiceSettings } from "@/lib/payments/settings";

export interface PublicSupportDetails {
  businessName: string;
  address: string;
  email: string;
  phone: string;
}

/**
 * Public business / support details, read from the owner-entered values —
 * Admin → Payments → Settings (Invoice & Business Details) first, then the
 * Footer's public email / location. Only these display fields are exposed;
 * nothing is hardcoded, and an empty field is simply not shown.
 */
export async function getPublicSupportDetails(): Promise<PublicSupportDetails> {
  const [inv, { footer }] = await Promise.all([getInvoiceSettings(), getPublicChrome()]);
  const footerContent = (footer?.content as Record<string, unknown>) ?? {};
  return {
    businessName: inv.legalName.trim(),
    address: composeSellerAddress(inv).trim() || str(footerContent, "location"),
    email: inv.supportEmail.trim() || str(footerContent, "email"),
    phone: inv.supportPhone.trim(),
  };
}

export function SupportDetailsList({ d }: { d: PublicSupportDetails }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      {d.businessName ? (
        <p className="flex items-start gap-2 text-[var(--color-foreground)]">
          <Building2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {d.businessName}
        </p>
      ) : null}
      {d.email ? (
        <a href={`mailto:${d.email}`} className="flex items-center gap-2 break-all text-[var(--color-foreground)] hover:text-[var(--color-primary)]">
          <Mail className="h-4 w-4 shrink-0" aria-hidden /> {d.email}
        </a>
      ) : null}
      {d.phone ? (
        <a href={`tel:${d.phone.replace(/[^0-9+]/g, "")}`} className="flex items-center gap-2 text-[var(--color-foreground)] hover:text-[var(--color-primary)]">
          <Phone className="h-4 w-4 shrink-0" aria-hidden /> {d.phone}
        </a>
      ) : null}
      {d.address ? (
        <p className="flex items-start gap-2 whitespace-pre-line text-[var(--color-muted-foreground)]">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {d.address}
        </p>
      ) : null}
    </div>
  );
}

/** Footer block of the standalone legal pages: where to reach support about this document. */
export async function LegalSupportFooter() {
  const d = await getPublicSupportDetails();
  return (
    <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-5">
      <h2 className="text-base font-semibold text-[var(--color-foreground)]">Contact &amp; Support</h2>
      <SupportDetailsList d={d} />
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted-foreground)]">
        <Link href="/contact#message" className="hover:underline">
          Message Us
        </Link>
        <Link href="/terms" className="hover:underline">
          Terms &amp; Conditions
        </Link>
        <Link href="/privacy" className="hover:underline">
          Privacy Policy
        </Link>
        <Link href="/refund-policy" className="hover:underline">
          Refund &amp; Cancellation Policy
        </Link>
      </p>
    </div>
  );
}
