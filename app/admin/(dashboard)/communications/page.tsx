import Link from "next/link";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { CommunicationsOverview, AnnouncementsTab } from "./overview";
import { InboxTable } from "./inbox-table";
import { EmailTab, type EmailTabParams } from "./email/email-tab";

export const metadata = { title: "Communications — Mock Test Series.in Admin" };

export default async function CommunicationsPage({ searchParams }: { searchParams: Promise<EmailTabParams & { tab?: string }> }) {
  const session = await getAdminSession();
  if (!session?.user?.permissions?.includes(PERMISSIONS.COMMUNICATIONS_VIEW)) {
    return <RestrictedCard title="Communications" />;
  }
  const params = await searchParams;
  const canManageEmail = session.user.permissions.includes(PERMISSIONS.EMAIL_MANAGE);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Communications</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          The central inbox for everything submitted through Contact Us → Message Us and the sitewide Grow with Us
          dialog, plus outbound Email to students. Announcements and question reports live in their own established
          workflows, linked from Overview.
        </p>
      </div>

      <ControlCenterTabs
        defaultValue="overview"
        tabs={[
          { value: "overview", label: "Overview", content: <CommunicationsOverview /> },
          { value: "inbox", label: "Inbox", content: <InboxTable title="Inbox" description="Every submission, all types" /> },
          {
            value: "contact",
            label: "Contact",
            content: <InboxTable type="CONTACT" title="Contact Messages" description="Submitted through Contact Us → Message Us" />,
          },
          {
            value: "grow-with-us",
            label: "Grow With Us",
            content: (
              <InboxTable type="GROW_WITH_US" title="Grow With Us" description="Teacher / Contributor / IT / Content enquiries" />
            ),
          },
          { value: "announcements", label: "Announcements", content: <AnnouncementsTab /> },
          {
            value: "email",
            label: "Email",
            // Rendered only when open: the Email tabs run their own queries.
            content: params.tab === "email" ? <EmailTab params={params} canManage={canManageEmail} /> : <EmailTabLink />,
          },
        ]}
      />
    </div>
  );
}

function EmailTabLink() {
  // Switching tabs is client-side; a refresh with ?tab=email renders the Email tabs.
  return (
    <p className="text-sm text-[var(--color-muted-foreground)]">
      <Link href="/admin/communications?tab=email" className="text-[var(--color-primary)] hover:underline">
        Open Email →
      </Link>
    </p>
  );
}
