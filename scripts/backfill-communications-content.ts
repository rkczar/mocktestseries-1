/**
 * One-time content backfill for the Contact / About / Legal work:
 *  - Footer contact email + location (the canonical source Footer and
 *    /contact both read from) on both the PUBLISHED and DRAFT homepage
 *    configs.
 *  - A CONTACT_INFO HomepageSection (About Us, Privacy Policy, Terms &
 *    Conditions body text, and the contactFormEnabled/growWithUsEnabled
 *    toggles) on both configs, since they were created before this section
 *    key existed and getOrCreateDraft() only seeds new configs.
 *
 * Idempotent: re-running updates the same rows rather than duplicating them.
 * Only touches Website/homepage content — no student, admin, or test data.
 *
 * Run with: NODE_OPTIONS="--conditions=react-server" npx tsx scripts/backfill-communications-content.ts
 */
import "dotenv/config";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const TODAY = new Date().toISOString().slice(0, 10);

const ABOUT_BODY =
  "MockTestSeries.in helps students preparing for competitive exams practice with full-length mock tests, " +
  "previous year question papers, and AI-powered explanations — all in one place. We're based in Jaipur, " +
  "Rajasthan, India.";

const PRIVACY_BODY = `## Who We Are
MockTestSeries.in ("we", "us", "the Platform") provides online mock tests, previous year question papers, and AI-generated explanations for competitive exam preparation. This policy explains what information we collect from visitors and registered students, and how we use it.

## Information You Provide
When you create a student account, we collect your name and, depending on how you sign up, your email address or mobile number. If you sign in with Google, we receive your Google account's email address to link your account. If you sign in with a mobile number, we send a one-time password (OTP) to verify it — OTP codes are never stored in plain text.

If you contact us through the Contact Us → Message Us form or the Grow with Us dialog, we collect the name, email, phone number (if provided), and message you submit.

## Information We Collect Automatically
We record your test attempts, answers, scores, and time taken so you can review your results and track your progress. We also record which questions you save for later. If you sign in, we log basic authentication activity (method used, timestamp, and IP address) to protect your account against abuse.

## AI-Generated Explanations
When you request an AI explanation for a question, the question text is sent to our AI provider (Google Gemini) to generate an explanation. We do not send your name, email, or other personal information as part of that request.

## Payments
MockTestSeries.in does not currently process payments. All content on the Platform is available without a paid checkout flow. If paid plans are introduced in the future, this policy will be updated before any payment information is collected. [Requires owner/legal review before payments launch.]

## Cookies and Sessions
We use cookies to keep you signed in (separate session cookies for students and administrators) and to remember your light/dark theme preference. We do not use third-party advertising or analytics tracking cookies at this time.

## How We Use Your Information
We use your information to operate your account, show you your test history and performance, respond to messages you send us, and keep the Platform secure. We do not sell your personal information.

## Who Can See Your Information
Contact Us and Grow with Us submissions, and your account details, are visible only to authorized administrators — never displayed publicly.

## Account Deletion
You can request deletion of your account from your profile. An administrator reviews and processes deletion requests; once approved, your account data is removed according to our internal process.

## Changes to This Policy
We may update this policy as the Platform changes. The date above reflects the last update.

## Contact
Questions about this policy can be sent through our Contact Us page.

[This policy describes the Platform's actual current data handling and has not been reviewed by a lawyer. Have it reviewed by qualified legal counsel before relying on it for compliance purposes.]`;

const TERMS_BODY = `## Acceptance of Terms
By creating an account or using MockTestSeries.in, you agree to these terms.

## Who Can Use This Platform
The Platform is intended for students preparing for competitive exams. You are responsible for the accuracy of the information you provide when registering.

## Your Account
You are responsible for keeping your login credentials secure. Notify us if you suspect unauthorized access to your account.

## Test Content
Mock tests, previous year papers, and questions on the Platform are provided for practice and self-assessment. AI-generated explanations are produced automatically and may occasionally be inaccurate — verify important concepts against your study material.

## Acceptable Use
Do not attempt to disrupt the Platform, access another student's data, or misuse the Contact Us / Grow with Us forms (for example, automated or abusive submissions).

## Content Ownership
Questions, papers, and other content on the Platform belong to MockTestSeries.in or its licensors. You may use them for your own exam preparation, not for redistribution.

## Account Deletion
You may request deletion of your account at any time; see our Privacy Policy for how that works.

## No Payment Obligation Today
The Platform does not currently charge for access. If paid plans are introduced, separate terms covering payment, refunds, and cancellation will be published before checkout is enabled. [Requires owner/legal review before payments launch.]

## Changes to These Terms
We may update these terms as the Platform evolves. The date above reflects the last update.

## Contact
Questions about these terms can be sent through our Contact Us page.

[These terms describe the Platform's actual current functionality and have not been reviewed by a lawyer. Have them reviewed by qualified legal counsel before relying on them for compliance purposes.]`;

async function main() {
  const configs = await prisma.homepageConfig.findMany({
    where: { status: { in: ["PUBLISHED", "DRAFT"] } },
    include: { sections: true },
  });

  for (const config of configs) {
    console.log(`\n--- ${config.status} v${config.version} (${config.id}) ---`);

    const footer = config.sections.find((s) => s.key === "FOOTER");
    if (footer) {
      const content = { ...(footer.content as Record<string, unknown>) };
      content.email = "info@mocktestseries.com";
      content.location = "Jaipur, Rajasthan, India";
      await prisma.homepageSection.update({ where: { id: footer.id }, data: { content: content as Prisma.InputJsonValue } });
      console.log("  Updated FOOTER email/location.");
    } else {
      console.log("  No FOOTER section found — skipped (unexpected).");
    }

    const contactInfo = config.sections.find((s) => s.key === "CONTACT_INFO");
    const contactInfoContent = {
      aboutHeading: "About MockTestSeries.in",
      aboutBody: ABOUT_BODY,
      privacyBody: PRIVACY_BODY,
      privacyLastUpdated: TODAY,
      termsBody: TERMS_BODY,
      termsLastUpdated: TODAY,
      contactFormEnabled: true,
      growWithUsEnabled: true,
    };
    if (contactInfo) {
      await prisma.homepageSection.update({ where: { id: contactInfo.id }, data: { content: contactInfoContent } });
      console.log("  Updated existing CONTACT_INFO section.");
    } else {
      const maxOrder = Math.max(0, ...config.sections.map((s) => s.order));
      await prisma.homepageSection.create({
        data: {
          homepageConfigId: config.id,
          key: "CONTACT_INFO",
          isEnabled: true,
          order: maxOrder + 1,
          content: contactInfoContent,
          references: {},
        },
      });
      console.log("  Created new CONTACT_INFO section.");
    }
  }

  console.log("\nDone.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
