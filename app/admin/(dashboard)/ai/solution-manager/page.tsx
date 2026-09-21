import { AiOverview } from "@/components/admin/ai/ai-overview";

export const metadata = { title: "AI Overview — Mock Test Series.in Admin" };

/**
 * Kept as a standalone route (redirecting conceptually, not via HTTP
 * redirect, so any existing bookmark/link still resolves) for whatever
 * previously linked to /admin/ai/solution-manager. Renders the exact same
 * AiOverview as the "Overview" tab on /admin/ai — see that component's doc
 * comment for why this used to be a separate stub subsystem and no longer is.
 */
export default function Page() {
  return <AiOverview />;
}
