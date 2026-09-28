import type { Metadata } from "next";
import { getSiteUrl } from "@/lib/site-url";
import Link from "next/link";
import { PublicPageShell, getPublicChrome } from "@/components/homepage/public-page-shell";
import { getStudentSession } from "@/lib/student-session";
import { requirePageVisible } from "@/lib/page-visibility";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { str } from "@/components/homepage/content-helpers";
import { BRAND_NAME } from "@/lib/brand";
import { LegalBody } from "./legal-body";
import { MessageUsForm } from "./message-form";
import { SupportDetailsList, getPublicSupportDetails } from "./support-details";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: `Contact Us — ${BRAND_NAME}`,
    description: "Contact MockTestSeries.in, learn about the platform, or grow with us.",
    alternates: { canonical: `${await getSiteUrl()}/contact` },
  };
}

const SECTIONS = [
  { id: "contact", label: "Contact Us" },
  { id: "help", label: "Payments & Support" },
  { id: "about", label: "About" },
  { id: "message", label: "Message Us" },
  { id: "privacy", label: "Privacy Policy" },
  { id: "terms", label: "Terms & Conditions" },
  { id: "refund", label: "Refund & Cancellation" },
];

/** What students most often need support for — kept in code as UI copy (the legal text itself stays admin-managed). */
const SUPPORT_TOPICS = [
  "Payment issue — money debited but the purchase isn't confirmed",
  "Access not activated after a successful payment",
  "Duplicate payment or incorrect charge",
  "Refund or cancellation request",
  "Invoice issue",
  "Account or login issue",
  "Technical issue with a test or the website",
];

export default async function ContactPage() {
  await requirePageVisible("contact");
  const [{ contactInfo }, session, support] = await Promise.all([getPublicChrome(), getStudentSession(), getPublicSupportDetails()]);

  const infoContent = (contactInfo?.content as Record<string, unknown>) ?? {};
  const aboutHeading = str(infoContent, "aboutHeading", "About MockTestSeries.in");
  const aboutBody = str(infoContent, "aboutBody");
  const privacyBody = str(infoContent, "privacyBody");
  const privacyLastUpdated = str(infoContent, "privacyLastUpdated");
  const termsBody = str(infoContent, "termsBody");
  const termsLastUpdated = str(infoContent, "termsLastUpdated");
  const refundBody = str(infoContent, "refundBody");
  const refundLastUpdated = str(infoContent, "refundLastUpdated");
  const contactFormEnabled = infoContent.contactFormEnabled !== false;

  return (
    <PublicPageShell>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-10 sm:px-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">Contact &amp; Information</h1>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Everything about reaching {BRAND_NAME}, who we are, and our policies — in one place.
          </p>
          <nav aria-label="Page sections" className="mt-4 flex flex-wrap gap-2">
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-muted-foreground)] transition-colors hover:text-[var(--color-foreground)]"
              >
                {s.label}
              </a>
            ))}
          </nav>
        </div>

        <Card id="contact" className="scroll-mt-24">
          <CardHeader>
            <CardTitle>Contact Us</CardTitle>
            <CardDescription>{BRAND_NAME}</CardDescription>
          </CardHeader>
          <CardContent>
            <SupportDetailsList d={support} />
          </CardContent>
        </Card>

        <Card id="help" className="scroll-mt-24">
          <CardHeader>
            <CardTitle>Payments &amp; Support</CardTitle>
            <CardDescription>Contact us{contactFormEnabled ? " using Message Us below" : ""}{support.email ? ` or by email at ${support.email}` : ""} for:</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-[var(--color-muted-foreground)]">
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {SUPPORT_TOPICS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <p>
              Please include your registered email address or mobile number and, for payment matters, the order number and payment reference shown in your
              account or payment confirmation. If money was debited but your purchase isn&apos;t confirmed, please don&apos;t pay again straight away — the
              payment is re-checked automatically. Never share your card number, CVV, UPI PIN, OTP or password with anyone, including us.
            </p>
            <p>
              See our{" "}
              <Link href="/refund-policy" className="text-[var(--color-primary)] hover:underline">
                Refund &amp; Cancellation Policy
              </Link>
              ,{" "}
              <Link href="/terms" className="text-[var(--color-primary)] hover:underline">
                Terms &amp; Conditions
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="text-[var(--color-primary)] hover:underline">
                Privacy Policy
              </Link>
              .
            </p>
          </CardContent>
        </Card>

        <Card id="about" className="scroll-mt-24">
          <CardHeader>
            <CardTitle>{aboutHeading}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-muted-foreground)]">
              {aboutBody}
            </p>
          </CardContent>
        </Card>

        {contactFormEnabled ? (
          <Card id="message" className="scroll-mt-24">
            <CardHeader>
              <CardTitle>Message Us</CardTitle>
              <CardDescription>Send us a message — we&apos;ll get back to you by email.</CardDescription>
            </CardHeader>
            <CardContent>
              <MessageUsForm initialName={session?.user?.name ?? ""} initialEmail={session?.user?.email ?? ""} />
            </CardContent>
          </Card>
        ) : null}

        <Card id="privacy" className="scroll-mt-24">
          <CardHeader>
            <CardTitle>Privacy Policy</CardTitle>
            {privacyLastUpdated ? <CardDescription>Last Updated: {privacyLastUpdated}</CardDescription> : null}
          </CardHeader>
          <CardContent>
            <LegalBody text={privacyBody} />
          </CardContent>
        </Card>

        <Card id="terms" className="scroll-mt-24">
          <CardHeader>
            <CardTitle>Terms &amp; Conditions</CardTitle>
            {termsLastUpdated ? <CardDescription>Last Updated: {termsLastUpdated}</CardDescription> : null}
          </CardHeader>
          <CardContent>
            <LegalBody text={termsBody} />
          </CardContent>
        </Card>

        <Card id="refund" className="scroll-mt-24">
          <CardHeader>
            <CardTitle>Refund &amp; Cancellation Policy</CardTitle>
            {refundLastUpdated ? <CardDescription>Last Updated: {refundLastUpdated}</CardDescription> : null}
          </CardHeader>
          <CardContent>
            <LegalBody text={refundBody} />
          </CardContent>
        </Card>
      </div>
    </PublicPageShell>
  );
}
