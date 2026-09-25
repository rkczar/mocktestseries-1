import { permanentRedirect } from "next/navigation";

/**
 * Legacy alias — /login is the one canonical Student Login. Kept as a page
 * (listed in lib/deprecated-routes.ts) so old links and bookmarks never 404;
 * every query parameter (callbackUrl, tab, …) is carried over in one hop.
 */
export default async function StudentLoginAlias({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, v);
  }
  const query = params.toString();
  permanentRedirect(query ? `/login?${query}` : "/login");
}
