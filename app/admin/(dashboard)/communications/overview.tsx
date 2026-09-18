import Link from "next/link";
import { getCommunicationCounts } from "@/lib/communications";
import { StatCard } from "@/components/admin/stat-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export async function CommunicationsOverview() {
  const counts = await getCommunicationCounts();

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="New Messages" value={counts.new} />
        <StatCard label="Contact Messages" value={counts.contact} />
        <StatCard label="Grow With Us Requests" value={counts.growWithUs} />
        <StatCard label="In Progress" value={counts.inProgress} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Question Reports</CardTitle>
          <CardDescription>Reports on individual questions have their own established workflow.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/admin/questions/reports" className="text-sm text-[var(--color-primary)] hover:underline">
            Go to Question Reports →
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

export function AnnouncementsTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Outbound Announcements</CardTitle>
        <CardDescription>
          Sending messages to students (Admin → Students) is a separate, existing workflow — kept independent from
          this inbound inbox (Public/Student → Admin), not merged into the same database entity.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link href="/admin/website/announcements" className="text-sm text-[var(--color-primary)] hover:underline">
          Go to Announcements →
        </Link>
      </CardContent>
    </Card>
  );
}
