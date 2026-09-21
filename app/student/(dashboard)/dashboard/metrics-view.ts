import { attemptTitle, type TitleableAttempt } from "@/lib/attempt-title";

/**
 * Normalizes getDashboardMetrics (global) and getExamScopedDashboardMetrics
 * (Active-Exam-scoped) into the one flat shape the client dashboard renders,
 * so ActiveExamDashboard never needs to know which source produced its data.
 */
export interface DashboardMetricsView {
  mcqSolvedToday: number;
  questionsAttempted: number;
  testsCompleted: number;
  averageScore: number | null;
  upcomingExam: { id: string; name: string; daysLeft: number | null } | null;
  recentTest: { id: string; title: string; score: number | null; maxScore: number | null } | null;
  inProgress: { id: string; title: string; examName: string } | null;
  weakTopics: { topicId: string; name: string; incorrectCount: number }[];
  savedQuestionsCount: number;
}

interface RawMetrics {
  mcqSolvedToday: number;
  questionsAttempted: number;
  testsCompleted: number;
  averageScore: number | null;
  upcomingExam: { id: string; name: string; daysLeft: number | null } | null;
  recentTest: { id: string; title: string; score: number | null; maxScore: number | null } | null;
  inProgress: (TitleableAttempt & { id: string; exam: { name: string } }) | null;
  weakTopics: { topicId: string; name: string; incorrectCount: number }[];
  savedQuestionsCount: number;
}

export function toDashboardMetricsView(raw: RawMetrics): DashboardMetricsView {
  return {
    mcqSolvedToday: raw.mcqSolvedToday,
    questionsAttempted: raw.questionsAttempted,
    testsCompleted: raw.testsCompleted,
    averageScore: raw.averageScore,
    upcomingExam: raw.upcomingExam,
    recentTest: raw.recentTest,
    inProgress: raw.inProgress ? { id: raw.inProgress.id, title: attemptTitle(raw.inProgress), examName: raw.inProgress.exam.name } : null,
    weakTopics: raw.weakTopics,
    savedQuestionsCount: raw.savedQuestionsCount,
  };
}
