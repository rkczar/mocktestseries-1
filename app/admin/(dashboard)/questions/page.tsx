import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { AllQuestionsPanel } from "./all-questions-panel";
import AddQuestionPage from "./add/page";
import BulkImportPage from "./bulk-import/page";
import QueriesPage from "./queries/page";
import QuestionReportsPage from "./reports/page";
import TemplatesPage from "./templates/page";

export const metadata = { title: "Question Bank — Mock Test Series.in Admin" };

export default async function QuestionsControlCenter({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string; status?: string; id?: string }>;
}) {
  const { examId, status, id } = await searchParams;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Question Bank</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          All questions, adding/editing, bulk import, student queries, reports, and templates.
        </p>
      </div>

      <ControlCenterTabs
        defaultValue="all"
        tabs={[
          { value: "all", label: "All Questions", content: <AllQuestionsPanel examId={examId} status={status} /> },
          { value: "add", label: "Add Question", content: <AddQuestionPage searchParams={Promise.resolve({ id })} /> },
          { value: "bulk-import", label: "Bulk Import", content: <BulkImportPage /> },
          { value: "queries", label: "Queries", content: <QueriesPage /> },
          { value: "reports", label: "Reports", content: <QuestionReportsPage /> },
          { value: "templates", label: "Templates", content: <TemplatesPage /> },
        ]}
      />
    </div>
  );
}
