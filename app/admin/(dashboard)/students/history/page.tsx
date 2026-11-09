import { TestHistoryView } from "@/components/admin/test-history-view";

export const metadata = { title: "Test History — Mock Test Series.in Admin" };

export default async function StudentsHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string }>;
}) {
  const { examId } = await searchParams;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Test History</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Every attempt across every student.</p>
      </div>
      <TestHistoryView examId={examId || undefined} basePath="/admin/students/history" studentHref={(id) => `/admin/students/${id}`} />
    </div>
  );
}
