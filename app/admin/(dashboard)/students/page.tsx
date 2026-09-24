import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { AllStudentsPanel } from "./all-students-panel";
import AttemptedQuestionsPage from "./attempted/page";
import StudentsHistoryPage from "./history/page";
import DeletionRequestsPage from "./deletion-requests/page";
import DeletedStudentsPage from "./deleted/page";
import EnrollmentPage from "./enrollment/page";

export const metadata = { title: "Students — Mock Test Series.in Admin" };

export default async function StudentsControlCenter({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string }>;
}) {
  const { examId } = await searchParams;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Students</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Every registered student, test history, attempted questions, enrollment, deletion requests and deleted
          accounts.
        </p>
      </div>

      <ControlCenterTabs
        defaultValue="all"
        tabs={[
          { value: "all", label: "All Students", content: <AllStudentsPanel /> },
          { value: "attempted", label: "Attempted", content: <AttemptedQuestionsPage /> },
          {
            value: "history",
            label: "History",
            content: <StudentsHistoryPage searchParams={Promise.resolve({ examId })} />,
          },
          { value: "enrollment", label: "Enrollment", content: <EnrollmentPage /> },
          { value: "deletion-requests", label: "Deletion Requests", content: <DeletionRequestsPage /> },
          { value: "deleted", label: "Deleted Students", content: <DeletedStudentsPage /> },
        ]}
      />
    </div>
  );
}
