import type { Metadata } from "next";
import { Mail, MapPin } from "lucide-react";
import { PublicPageShell, getPublicChrome } from "@/components/homepage/public-page-shell";
import { getStudentSession } from "@/lib/student-session";
import { requirePageVisible } from "@/lib/page-visibility";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { str } from "@/components/homepage/content-helpers";
import { BRAND_NAME } from "@/lib/brand";
import { LegalBody } from "./legal-body";
import { MessageUsForm } from "./message-form";

export const metadata: Metadata = {
  title: `Contact Us — ${BRAND_NAME}`,
  description: "Contact MockTestSeries.in, learn about the platform, or grow with us.",
};

const SECTIONS = [
  { id: "contact", label: "Contact Us" },
  { id: "about", label: "About" },
  { id: "message", label: "Message Us" },
  { id: "privacy", label: "Privacy Policy" },
  { id: "terms", label: "Terms & Conditions" },
];

export default async function ContactPage() {
  await requirePageVisible("contact");
  const [{ footer, contactInfo }, session] = await Promise.all([getPublicChrome(), getStudentSession()]);

  const footerContent = (footer?.content as Record<string, unknown>) ?? {};
  const infoContent = (contactInfo?.content as Record<string, unknown>) ?? {};

  const email = str(footerContent, "email");
  const location = str(footerContent, "location");
  const aboutHeading = str(infoContent, "aboutHeading", "About MockTestSeries.in");
  const aboutBody = str(infoContent, "aboutBody");
  const privacyBody = str(infoContent, "privacyBody");
  const privacyLastUpdated = str(infoContent, "privacyLastUpdated");
  const termsBody = str(infoContent, "termsBody");
  const termsLastUpdated = str(infoContent, "termsLastUpdated");
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
          <CardContent className="flex flex-col gap-2 text-sm">
            {email ? (
              <a
                href={`mailto:${email}`}
                className="flex items-center gap-2 text-[var(--color-foreground)] hover:text-[var(--color-primary)]"
              >
                <Mail className="h-4 w-4" aria-hidden /> {email}
              </a>
            ) : null}
            {location ? (
              <p className="flex items-center gap-2 text-[var(--color-muted-foreground)]">
                <MapPin className="h-4 w-4" aria-hidden /> {location}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card id="about" className="scroll-mt-24">
          <CardHeader>
            <CardTitle>{aboutHeading}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-muted-foreground)]">
              {aboutBody || "Content coming soon."}
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
      </div>
    </PublicPageShell>
  );
}
