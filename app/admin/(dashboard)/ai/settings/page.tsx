import { getAiSettings } from "@/lib/ai-settings";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { prisma } from "@/lib/prisma";
import { AiGeneralSettingsCard } from "./general-settings-form";
import { HomepageDemoPicker, type EligibleDemoQuestion } from "./homepage-demo-picker";

export const metadata = { title: "AI Settings — Mock Test Series.in Admin" };

export default async function AiSettingsPage() {
  const session = await getAdminSession();
  if (!session?.user?.permissions?.includes(PERMISSIONS.SETTINGS_MANAGE)) {
    return <RestrictedCard title="AI Settings" />;
  }

  const [aiSettings, eligibleRows] = await Promise.all([
    getAiSettings(),
    prisma.aIExplanation.findMany({
      where: { status: "COMPLETED", adminReviewedAt: { not: null }, isStale: false },
      orderBy: { adminReviewedAt: "desc" },
      take: 100,
      select: {
        questionId: true,
        question: { select: { code: true, text: true, exam: { select: { name: true } }, subject: { select: { name: true } } } },
      },
    }),
  ]);

  const eligible: EligibleDemoQuestion[] = eligibleRows.map((r) => ({
    questionId: r.questionId,
    code: r.question.code,
    text: r.question.text,
    examName: r.question.exam.name,
    subjectName: r.question.subject.name,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Settings</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Ask AI and question-variant settings. All AI runs through OpenRouter only (AI → Providers); models and fallback order are set in AI → Features.
        </p>
      </div>

      <AiGeneralSettingsCard settings={aiSettings} />

      <HomepageDemoPicker eligible={eligible} selectedIds={aiSettings.homepageDemoQuestionIds} />
    </div>
  );
}
