import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/rbac";
import { getOrCreateDraft } from "@/lib/homepage";
import { resolveHomepage } from "@/lib/homepage-render";
import { HomepageView } from "@/components/homepage/homepage-view";

export const metadata = { title: "Homepage Preview — Mock Test Series.in Admin" };

/**
 * Renders the current DRAFT through the exact same pipeline the public site
 * uses (resolveHomepage + HomepageView) — never a second content model, just
 * the unpublished version of the same one. Lives outside the (dashboard)
 * route group — like /admin/login — so it renders full-width, without the
 * admin sidebar/header chrome, matching what the public site will look like.
 */
export default async function HomepagePreviewPage() {
  const session = await getAdminSession();
  if (!session?.user) redirect("/admin/login");

  const draft = await getOrCreateDraft();
  const homepage = await resolveHomepage(draft);

  return (
    <div>
      <div className="sticky top-0 z-50 bg-[var(--color-warning)] px-4 py-2 text-center text-sm font-medium text-white">
        Draft preview — version {draft.version}. Not published. Changes here are not visible to the public.
      </div>
      <HomepageView homepage={homepage} />
    </div>
  );
}
