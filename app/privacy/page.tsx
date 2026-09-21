import { redirect } from "next/navigation";
import { requirePageVisible } from "@/lib/page-visibility";

export default async function PrivacyPolicyRedirect() {
  await requirePageVisible("privacy");
  redirect("/contact#privacy");
}
