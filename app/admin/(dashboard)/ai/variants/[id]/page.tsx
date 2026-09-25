import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AiSlot } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GenerateMissingControl, ArchiveVariantControl, PublishVariantControl } from "../variant-controls";

export const metadata = { title: "AI Variants — Mock Test Series.in Admin" };

const SLOT_ORDER: AiSlot[] = [AiSlot.AI01, AiSlot.AI02, AiSlot.AI03, AiSlot.AI04, AiSlot.AI05];

const STATUS_BADGE = {
  NONE: { label: "Empty", variant: "neutral" as const },
  PENDING: { label: "Pending", variant: "neutral" as const },
  GENERATING: { label: "Generating…", variant: "info" as const },
  COMPLETED: { label: "Ready", variant: "success" as const },
  FAILED: { label: "Failed", variant: "error" as const },
};

export default async function VariantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const parent = await prisma.question.findUnique({
    where: { id },
    include: {
      exam: true,
      options: { orderBy: { order: "asc" } },
      subject: true,
      topic: true,
      aiVariants: {
        include: { options: { orderBy: { order: "asc" } }, aiExplanation: true, _count: { select: { reports: true, mockTestQuestions: true } } },
        orderBy: { aiSlot: "asc" },
      },
    },
  });
  if (!parent || parent.parentQuestionId) notFound();

  const bySlot = new Map(parent.aiVariants.map((v) => [v.aiSlot, v]));

  return (
    <div className="flex flex-col gap-6">
      <Link href="/admin/ai/variants" className="text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]">
        ← Back to AI Variant Monitoring
      </Link>
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{parent.code}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {parent.exam.name} · {parent.subject.name}
          {parent.topic ? ` · ${parent.topic.name}` : ""}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Source Question</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-[var(--color-foreground)]">{parent.text}</p>
          <div className="flex flex-col gap-1.5">
            {parent.options.map((o) => (
              <div
                key={o.label}
                className={
                  o.isCorrect
                    ? "rounded-[var(--radius-card)] border border-[var(--color-success)] bg-[var(--color-success)]/10 p-2 text-sm"
                    : "rounded-[var(--radius-card)] border border-[var(--color-border)] p-2 text-sm"
                }
              >
                <span className="font-semibold">{o.label}.</span> {o.text}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI Variants</CardTitle>
          <CardDescription>
            {parent.aiVariants.filter((v) => v.aiGenerationStatus === "COMPLETED" && v.status !== "ARCHIVED").length}/5 active · generated
            automatically from Ask AI and saved to the Question Bank
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {parent.status === "PUBLISHED" && parent.aiVariants.filter((v) => v.aiGenerationStatus === "COMPLETED").length < 5 ? (
            <GenerateMissingControl parentQuestionId={parent.id} />
          ) : null}
          {SLOT_ORDER.map((slot) => {
            const variant = bySlot.get(slot);
            return (
              <div key={slot} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-[var(--color-foreground)]">{slot}</span>
                  <Badge variant={STATUS_BADGE[variant?.aiGenerationStatus ?? "NONE"].variant}>
                    {STATUS_BADGE[variant?.aiGenerationStatus ?? "NONE"].label}
                  </Badge>
                  {variant?.aiGenerationStatus === "COMPLETED" ? (
                    <Badge variant={variant.status === "PUBLISHED" ? "success" : variant.status === "ARCHIVED" ? "warning" : "neutral"}>
                      {variant.status === "PUBLISHED" ? "In Question Bank" : variant.status === "ARCHIVED" ? "Archived" : "Draft (legacy)"}
                    </Badge>
                  ) : null}
                </div>

                {!variant ? (
                  <p className="text-xs text-[var(--color-muted-foreground)]">Empty — filled automatically the next time a student asks for AI Question Variants.</p>
                ) : variant.aiGenerationStatus === "COMPLETED" ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      {variant.code} · {variant.aiModel || "unknown model"} · {variant.aiGeneratedAt?.toLocaleString("en-IN")} · used in{" "}
                      {variant._count.mockTestQuestions} test(s) · {variant._count.reports} report(s)
                    </p>
                    <p className="text-sm text-[var(--color-foreground)]">{variant.text}</p>
                    <div className="flex flex-col gap-1.5">
                      {variant.options.map((o) => (
                        <div
                          key={o.label}
                          className={
                            o.isCorrect
                              ? "rounded-[var(--radius-card)] border border-[var(--color-success)] bg-[var(--color-success)]/10 p-2 text-sm"
                              : "rounded-[var(--radius-card)] border border-[var(--color-border)] p-2 text-sm"
                          }
                        >
                          <span className="font-semibold">{o.label}.</span> {o.text}
                        </div>
                      ))}
                    </div>
                    {(() => {
                      const concept = (variant.aiExplanation?.content as { concept?: unknown } | null)?.concept;
                      return typeof concept === "string" && concept ? (
                        <p className="text-xs text-[var(--color-muted-foreground)]">
                          <span className="font-semibold">Explanation:</span> {concept}
                        </p>
                      ) : null;
                    })()}
                    <div className="flex flex-wrap gap-2">
                      <Link href={`/admin/questions?tab=add&id=${variant.id}`} className="self-center text-xs text-[var(--color-primary)] hover:underline">
                        Edit / fix in Question Bank
                      </Link>
                      {variant.status !== "ARCHIVED" ? <ArchiveVariantControl variantId={variant.id} parentQuestionId={parent.id} /> : null}
                      {variant.status !== "PUBLISHED" ? (
                        <PublishVariantControl
                          variantId={variant.id}
                          parentQuestionId={parent.id}
                          label={variant.status === "ARCHIVED" ? "Restore" : "Add to Question Bank"}
                        />
                      ) : null}
                    </div>
                  </div>
                ) : variant.aiGenerationStatus === "FAILED" ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-[var(--color-error)]">{variant.aiErrorMessage ?? "Generation failed."}</p>
                    <p className="text-xs text-[var(--color-muted-foreground)]">This slot is refilled automatically by the next generation.</p>
                  </div>
                ) : (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    Still generating — refresh in a moment. If this persists, it will become retryable automatically.
                  </p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
