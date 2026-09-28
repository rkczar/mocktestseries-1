import { requirePageVisible } from "@/lib/page-visibility";
import { LegalDocumentPage, legalDocumentMetadata } from "@/app/contact/legal-document";

export function generateMetadata() {
  return legalDocumentMetadata("refund");
}

export default async function RefundPolicyPage() {
  await requirePageVisible("refund-policy");
  return <LegalDocumentPage kind="refund" />;
}
