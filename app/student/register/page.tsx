import { permanentRedirect } from "next/navigation";

/** Legacy alias — registration lives on the canonical /login page (Register tab). Query parameters such as callbackUrl are carried over. */
export default async function StudentRegisterAlias({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (key === "tab") continue;
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, v);
  }
  params.set("tab", "register");
  permanentRedirect(`/login?${params.toString()}`);
}
