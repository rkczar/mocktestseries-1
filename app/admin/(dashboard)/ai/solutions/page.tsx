import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RetryExplanationControl, RegenerateExplanationControl, MarkReviewedControl } from "./retry-explanation-control";

export const metadata = { title: "AI Solutions — Mock Test Series.in Admin" };

const STATUS_BADGE = {
  NONE: { label: "None", variant: "neutral" as const },
  PENDING: { label: "Pending", variant: "neutral" as const },
  GENERATING: { label: "Generating", variant: "info" as const },
  COMPLETED: { label: "Ready", variant: "success" as const },
  FAILED: { label: "Failed", variant: "error" as const },
};

export default async function AiSolutionsPage() {
  const explanations = await prisma.aIExplanation.findMany({
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: {
      question: { select: { code: true, text: true, exam: { select: { name: true } }, _count: { select: { aiVariants: true } } } },
      adminReviewedBy: { select: { name: true } },
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Solutions</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Every cached &quot;Ask AI&quot; explanation — one per Question, generated once and reused for every student.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Explanations</CardTitle>
          <CardDescription>{explanations.length} shown (most recently updated first)</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {explanations.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
              No explanations have been generated yet — they&apos;re created the first time a student clicks &quot;Ask
              AI&quot; on a question.
            </p>
          ) : (
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Question</th>
                  <th className="py-2 pr-4">Provider / Model</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Variants</th>
                  <th className="py-2 pr-4">Reviewed</th>
                  <th className="py-2 pr-4">Updated</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {explanations.map((e) => (
                  <tr key={e.id} className="border-b border-[var(--color-border)] last:border-0 align-top">
                    <td className="max-w-xs py-2.5 pr-4">
                      <p className="font-medium text-[var(--color-foreground)]">{e.question.code}</p>
                      <p className="truncate text-xs text-[var(--color-muted-foreground)]">{e.question.text}</p>
                      <p className="text-[11px] text-[var(--color-muted-foreground)]">{e.question.exam.name}</p>
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">
                      {e.provider || "—"} / {e.model || "—"}
                      <span className="block">v{e.version} · prompt {e.promptVersion}</span>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={STATUS_BADGE[e.status].variant}>{STATUS_BADGE[e.status].label}</Badge>
                      {e.status === "FAILED" && e.errorMessage ? (
                        <p className="mt-1 max-w-[220px] text-xs text-[var(--color-error)]">{e.errorMessage}</p>
                      ) : null}
                      {e.retryCount > 0 ? <p className="text-[11px] text-[var(--color-muted-foreground)]">Retries: {e.retryCount}</p> : null}
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">{e.question._count.aiVariants}/5</td>
                    <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">
                      {e.adminReviewedAt ? (
                        <>
                          <Badge variant="success">Reviewed</Badge>
                          <p className="mt-1">{e.adminReviewedBy?.name ?? "—"}</p>
                        </>
                      ) : e.status === "COMPLETED" ? (
                        <Badge variant="neutral">Needs Review</Badge>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">{e.updatedAt.toLocaleString()}</td>
                    <td className="py-2.5 pr-4">
                      <div className="flex flex-col items-end gap-1.5">
                        {e.status === "FAILED" ? <RetryExplanationControl questionId={e.questionId} /> : null}
                        {e.status === "COMPLETED" ? <RegenerateExplanationControl questionId={e.questionId} /> : null}
                        {e.status === "COMPLETED" && !e.adminReviewedAt ? <MarkReviewedControl questionId={e.questionId} /> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
