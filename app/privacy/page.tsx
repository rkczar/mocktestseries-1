import { requirePageVisible } from "@/lib/page-visibility";
import { LegalDocumentPage, legalDocumentMetadata } from "@/app/contact/legal-document";

export function generateMetadata() {
  return legalDocumentMetadata("privacy");
}

export default async function PrivacyPolicyPage() {
  await requirePageVisible("privacy");
  return <LegalDocumentPage kind="privacy" />;
}
