import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SelectNative } from "@/components/ui/select-native";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const metadata = { title: "AI Variant Monitoring — Mock Test Series.in Admin" };

const GENERATION_BADGE = {
  NONE: { label: "—", variant: "neutral" as const },
  PENDING: { label: "Pending", variant: "neutral" as const },
  GENERATING: { label: "Generating", variant: "info" as const },
  COMPLETED: { label: "Valid", variant: "success" as const },
  FAILED: { label: "Failed", variant: "error" as const },
};

const STATUS_BADGE = {
  PUBLISHED: { label: "In Question Bank", variant: "success" as const },
  DRAFT: { label: "Draft (legacy)", variant: "neutral" as const },
  ARCHIVED: { label: "Archived", variant: "warning" as const },
};

/**
 * AI Variant Monitoring / Audit. Variants are generated automatically from
 * Ask AI and saved straight into the Question Bank (lib/ai-variant.ts) —
 * this page only monitors them and links to per-source quality control.
 */
export default async function AiVariantsPage({
  searchParams,
}: {
  searchParams?: Promise<{ examId?: string; q?: string; status?: string }>;
}) {
  const params = (await searchParams) ?? {};

  const where: Prisma.QuestionWhereInput = {
    parentQuestionId: { not: null },
    examId: params.examId || undefined,
    ...(params.status === "FAILED" ? { aiGenerationStatus: "FAILED" } : {}),
    ...(params.status === "ARCHIVED" ? { status: "ARCHIVED" } : {}),
    ...(params.status === "ACTIVE" ? { status: { not: "ARCHIVED" }, aiGenerationStatus: "COMPLETED" } : {}),
    ...(params.q
      ? {
          OR: [
            { text: { contains: params.q, mode: "insensitive" } },
            { code: { startsWith: params.q, mode: "insensitive" } },
            { parentQuestion: { code: { startsWith: params.q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [exams, variants, totals] = await Promise.all([
    prisma.exam.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
    prisma.question.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        code: true,
        text: true,
        status: true,
        aiGenerationStatus: true,
        aiModel: true,
        createdAt: true,
        parentQuestionId: true,
        parentQuestion: { select: { code: true } },
        exam: { select: { name: true } },
        subject: { select: { name: true } },
        topic: { select: { name: true } },
        _count: { select: { reports: true, mockTestQuestions: true, savedByStudents: true } },
      },
    }),
    prisma.question.groupBy({ by: ["status"], where: { parentQuestionId: { not: null } }, _count: true }),
  ]);
  const countFor = (s: string) => totals.find((t) => t.status === s)?._count ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">AI Variant Monitoring</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          AI Question Variants (AI01–AI05 per source question) are generated automatically from Ask AI, validated,
          de-duplicated and saved straight into the Question Bank. No approval is needed — use this page to audit
          them and archive any that fall short.
        </p>
        <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
          In Question Bank: {countFor("PUBLISHED")} · Draft (legacy): {countFor("DRAFT")} · Archived: {countFor("ARCHIVED")}
        </p>
      </div>

      <Card>
        <CardContent className="pt-5">
          <form className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <SelectNative name="examId" defaultValue={params.examId ?? ""}>
              <option value="">All Exams</option>
              {exams.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </SelectNative>
            <SelectNative name="status" defaultValue={params.status ?? ""}>
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="ARCHIVED">Archived</option>
              <option value="FAILED">Failed (legacy)</option>
            </SelectNative>
            <div className="flex gap-2 sm:col-span-2">
              <Input name="q" placeholder="Search text or source/variant code…" defaultValue={params.q ?? ""} />
              <Button type="submit">Filter</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Variants</CardTitle>
          <CardDescription>{variants.length} shown (newest first, top 100)</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {variants.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No AI variants match.</p>
          ) : (
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Source</th>
                  <th className="py-2 pr-4">Variant</th>
                  <th className="py-2 pr-4">Question</th>
                  <th className="py-2 pr-4">Exam / Subject / Topic</th>
                  <th className="py-2 pr-4">Created</th>
                  <th className="py-2 pr-4">Validation</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Usage</th>
                  <th className="py-2 pr-4">Reports</th>
                </tr>
              </thead>
              <tbody>
                {variants.map((v) => (
                  <tr key={v.id} className="border-b border-[var(--color-border)] align-top last:border-0">
                    <td className="py-2.5 pr-4">
                      <Link href={`/admin/ai/variants/${v.parentQuestionId}`} className="font-mono text-xs text-[var(--color-primary)] hover:underline">
                        {v.parentQuestion?.code ?? "—"}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs font-semibold text-[var(--color-foreground)]">{v.code.match(/AI\d{2}$/)?.[0] ?? v.code}</td>
                    <td className="max-w-xs py-2.5 pr-4 text-[var(--color-foreground)]">{v.text.slice(0, 110)}</td>
                    <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">
                      {v.exam.name}
                      <br />
                      {v.subject.name}
                      {v.topic ? ` · ${v.topic.name}` : ""}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">{v.createdAt.toLocaleDateString("en-IN")}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={GENERATION_BADGE[v.aiGenerationStatus].variant}>{GENERATION_BADGE[v.aiGenerationStatus].label}</Badge>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={STATUS_BADGE[v.status].variant}>{STATUS_BADGE[v.status].label}</Badge>
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">
                      {v._count.mockTestQuestions} test{v._count.mockTestQuestions === 1 ? "" : "s"} · {v._count.savedByStudents} saved
                    </td>
                    <td className="py-2.5 pr-4">
                      {v._count.reports > 0 ? <Badge variant="warning">{v._count.reports}</Badge> : <span className="text-xs text-[var(--color-muted-foreground)]">0</span>}
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
