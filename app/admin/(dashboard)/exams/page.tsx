import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { AllExamsPanel } from "./all-exams-panel";
import SubjectsPage from "./subjects/page";
import TopicsPage from "./topics/page";
import SyllabusPage from "./syllabus/page";
import PreviousYearPapersPage from "./previous-year-papers/page";
import TestSeriesPage from "./test-series/page";

export const metadata = { title: "Exams — Mock Test Series.in Admin" };

export default async function ExamsControlCenter({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string; subjectId?: string }>;
}) {
  const { examId, subjectId } = await searchParams;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Exams</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Exams, subjects & topics, syllabus, previous year papers, and test series.
        </p>
      </div>

      <ControlCenterTabs
        defaultValue="all"
        tabs={[
          { value: "all", label: "All Exams", content: <AllExamsPanel /> },
          {
            value: "subjects",
            label: "Subjects & Topics",
            content: (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <SubjectsPage searchParams={Promise.resolve({ examId })} />
                <TopicsPage searchParams={Promise.resolve({ examId, subjectId })} />
              </div>
            ),
          },
          { value: "syllabus", label: "Syllabus", content: <SyllabusPage searchParams={Promise.resolve({ examId })} /> },
          {
            value: "pyp",
            label: "Previous Year Papers",
            content: <PreviousYearPapersPage searchParams={Promise.resolve({ examId })} />,
          },
          {
            value: "test-series",
            label: "Test Series",
            content: <TestSeriesPage searchParams={Promise.resolve({ examId })} />,
          },
        ]}
      />
    </div>
  );
}
