import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getQuestionDependencies } from "@/lib/question-dependencies";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DependencyUsesTable, KIND_LABEL } from "@/components/admin/question-dependencies/dependency-uses-table";
import { ReplacePanel } from "./replace-panel";

export const metadata = { title: "Retire / Replace Question — Mock Test Series.in Admin" };

/**
 * Admin → Question → Retire / Replace (docs/QUESTION-RETIREMENT.md): the
 * question's full dependency view, then one preview and one confirmation.
 */
export default async function ReplaceQuestionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [question, session] = await Promise.all([
    prisma.question.findUnique({
      where: { id },
      select: {
        id: true,
        code: true,
        text: true,
        status: true,
        retiredAt: true,
        retiredReason: true,
        parentQuestionId: true,
        replacedBy: { select: { id: true, code: true } },
        options: { orderBy: { order: "asc" }, select: { label: true, text: true, isCorrect: true } },
        exam: { select: { name: true } },
      },
    }),
    getAdminSession(),
  ]);
  if (!question) notFound();
  const deps = (await getQuestionDependencies([id])).get(id)!;
  const canPreview = Boolean(session?.user?.permissions?.includes(PERMISSIONS.QUESTIONS_MANAGE));
  const canApply = canPreview && session?.user?.role === "MASTER_ADMIN";

  return (
    <div className="flex flex-col gap-6">
      <div>
        {deps.paperId ? (
          <Link href={`/admin/exams/previous-year-papers/${deps.paperId}`} className="text-xs text-[var(--color-primary)] hover:underline">
            ← {deps.paperTitle}
          </Link>
        ) : (
          <Link href="/admin/questions" className="text-xs text-[var(--color-primary)] hover:underline">
            ← Question Bank
          </Link>
        )}
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Retire / Replace {question.code}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {question.exam.name}
          {deps.paperTitle ? ` · ${deps.paperTitle}${deps.paperQuestionNumber ? ` · Q${deps.paperQuestionNumber}` : ""}` : ""}
        </p>
      </div>

      {question.retiredAt ? (
        <Card>
          <CardContent className="py-4 text-sm">
            <Badge variant="error">Retired</Badge>{" "}
            {question.retiredAt.toISOString().slice(0, 16).replace("T", " ")} UTC — {question.retiredReason}
            {question.replacedBy ? (
              <>
                {" "}· replaced by{" "}
                <Link className="text-[var(--color-primary)] hover:underline" href={`/admin/questions/${question.replacedBy.id}/replace`}>
                  {question.replacedBy.code}
                </Link>
              </>
            ) : null}
            . Retired questions are read-only and are never served again.{" "}
            <Link className="text-[var(--color-primary)] hover:underline" href="/admin/questions/replacements">
              Replacement history
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Question</CardTitle>
          <CardDescription>
            Status {question.status}
            {question.parentQuestionId ? " · AI variant" : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p className="whitespace-pre-wrap text-[var(--color-foreground)]">{question.text}</p>
          <ul className="flex flex-col gap-1">
            {question.options.map((o) => (
              <li key={o.label} className={o.isCorrect ? "font-medium text-[var(--color-success)]" : "text-[var(--color-muted-foreground)]"}>
                {o.label}. {o.text}
                {o.isCorrect ? " ✓" : ""}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dependencies</CardTitle>
          <CardDescription>Every test and module that uses this question, and who has sat it.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label={KIND_LABEL.MOCK_TEST + "s"} value={deps.mockTests} />
            <Tile label="Admin modules" value={deps.adminModules} />
            <Tile label="Student modules" value={deps.studentModules} />
            <Tile label="Grand / Live tests" value={deps.grandOrLive} />
            <Tile label="Attempts submitted" value={deps.attempts.submitted} />
            <Tile label="Active sessions" value={deps.activeSessions} />
            <Tile label="Attempts invalidated" value={deps.attempts.invalidated} />
            <Tile label="AI variants · bookmarks · reports" value={`${deps.aiVariants} · ${deps.bookmarks} · ${deps.reports}`} />
          </div>
          <DependencyUsesTable uses={deps.uses} />
        </CardContent>
      </Card>

      {/* Always mounted at the same place: the apply's revalidation re-renders this
          page as retired, and the panel must keep showing its confirmation. */}
      <ReplacePanel
        oldQuestionId={question.id}
        oldCode={question.code}
        canPreview={canPreview}
        canApply={canApply}
        isVariant={!!question.parentQuestionId}
        retired={!!question.retiredAt}
      />
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] p-3">
      <div className="text-xs uppercase text-[var(--color-muted-foreground)]">{label}</div>
      <div className="text-lg font-semibold text-[var(--color-foreground)]">{value}</div>
    </div>
  );
}
