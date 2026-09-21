import { redirect } from "next/navigation";
import { requirePageVisible } from "@/lib/page-visibility";

export default async function TermsRedirect() {
  await requirePageVisible("terms");
  redirect("/contact#terms");
}
