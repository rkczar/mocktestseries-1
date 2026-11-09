import { LiveMonitorView } from "@/components/admin/live-monitor-view";

export const metadata = { title: "Live CBT Monitor — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

/** Admin → Tests → Mock Test → Live CBT Monitor (read-only; components/admin/live-monitor-view.tsx). */
export default async function LiveCbtMonitorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LiveMonitorView id={id} />;
}
