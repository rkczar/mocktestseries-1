import { RestrictedCard } from "@/components/admin/restricted-card";
import { StudioSubnav } from "@/components/admin/instagram/studio-subnav";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getPublishingSwitch } from "@/lib/instagram/publish";

export const dynamic = "force-dynamic";

/**
 * Admin → Instagram (Content Studio). MASTER_ADMIN only — every action and
 * image route re-checks INSTAGRAM_MANAGE server-side as well. Publishing
 * (lib/instagram/publish.ts) happens only when a Master Admin confirms it in
 * the editor, and only while the Settings switch is ON.
 */
export default async function InstagramStudioLayout({ children }: { children: React.ReactNode }) {
  if (!(await hasPermission(PERMISSIONS.INSTAGRAM_MANAGE))) return <RestrictedCard title="Instagram" />;
  const publishing = await getPublishingSwitch();
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Instagram</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Turn previous year questions and Most Missed MCQs into reviewed 1080 × 1350 carousels.
        </p>
      </div>
      <StudioSubnav />
      {publishing.enabled ? (
        <div
          role="note"
          data-testid="publishing-enabled"
          className="rounded-[var(--radius-card)] border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-4 py-2.5 text-sm text-[var(--color-foreground)]"
        >
          <span className="font-semibold">Direct publishing is ON.</span> An approved (Ready) post goes to Instagram only when a Master Admin clicks “Confirm &amp; Publish”. Nothing is
          published automatically.
        </div>
      ) : (
        <div
          role="note"
          data-testid="publishing-disabled"
          className="rounded-[var(--radius-card)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-4 py-2.5 text-sm text-[var(--color-foreground)]"
        >
          <span className="font-semibold">Publishing is turned off.</span> Nothing is posted to Instagram. You can create, edit, review and download carousels. A Master Admin can
          turn direct publishing on in Settings.
        </div>
      )}
      {children}
    </div>
  );
}
