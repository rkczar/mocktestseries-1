import { requirePageVisible } from "@/lib/page-visibility";
import { LegalDocumentPage, legalDocumentMetadata } from "@/app/contact/legal-document";

export function generateMetadata() {
  return legalDocumentMetadata("terms");
}

export default async function TermsPage() {
  await requirePageVisible("terms");
  return <LegalDocumentPage kind="terms" />;
}
