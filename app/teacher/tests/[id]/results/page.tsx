import { inScopeOr404, requireTeacherPage } from "@/lib/teacher/page";
import { mockTestInScope } from "@/lib/teacher/scope";
import { LiveMonitorView } from "@/components/admin/live-monitor-view";

export const metadata = { title: "Test Results — Teacher Portal" };
export const dynamic = "force-dynamic";

/** Test-wise results for a Mock Test of the teacher's exams: the Admin Live CBT Monitor, teacher mode. */
export default async function TeacherTestResults({ params }: { params: Promise<{ id: string }> }) {
  const scope = await requireTeacherPage();
  const { id } = await params;
  const mock = await inScopeOr404(() => mockTestInScope(scope, id));
  return <LiveMonitorView id={mock.id} teacher={{ backHref: `/teacher/tests/${mock.id}`, selfHref: `/teacher/tests/${mock.id}/results`, studentHref: (sid) => `/teacher/students/${sid}` }} />;
}
