import { redirect } from "next/navigation";

export const metadata = { title: "Transactions — Mock Test Series.in Admin" };

/** Canonical view lives in the Payment Control Center tab; this route stays for deep links. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "tab") qs.set(k, v);
  qs.set("tab", "transactions");
  redirect(`/admin/payments?${qs.toString()}`);
}
