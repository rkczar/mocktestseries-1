import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AiSlot, AiVariantType } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GenerateVariantControl, RetryVariantControl, PublishVariantControl } from "../variant-controls";

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
      aiVariants: { include: { options: { orderBy: { order: "asc" } } }, orderBy: { aiSlot: "asc" } },
    },
  });
  if (!parent || parent.parentQuestionId) notFound();

  const bySlot = new Map(parent.aiVariants.map((v) => [v.aiSlot, v]));

  return (
    <div className="flex flex-col gap-6">
      <Link href="/admin/ai/variants" className="text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]">
        ← Back to AI Question Variants
      </Link>
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{parent.code}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">{parent.exam.name}</p>
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
          <CardDescription>{parent.aiVariants.length}/5 slots used</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
                    <Badge variant={variant.status === "PUBLISHED" ? "success" : "neutral"}>
                      {variant.status === "PUBLISHED" ? "Published to Question Bank" : "Draft — not in Question Bank"}
                    </Badge>
                  ) : null}
                </div>

                {!variant ? (
                  <div className="flex flex-wrap gap-3">
                    <GenerateVariantControl parentQuestionId={parent.id} variantType={AiVariantType.AI_SIMILAR} />
                    <GenerateVariantControl parentQuestionId={parent.id} variantType={AiVariantType.AI_TRAP} />
                  </div>
                ) : variant.aiGenerationStatus === "COMPLETED" ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      {variant.code} · {variant.aiVariantType === "AI_SIMILAR" ? "Similar" : "Trap"} · {variant.aiModel} ·{" "}
                      {variant.aiGeneratedAt?.toLocaleString()}
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
                    {variant.status !== "PUBLISHED" ? (
                      <PublishVariantControl variantId={variant.id} parentQuestionId={parent.id} />
                    ) : null}
                  </div>
                ) : variant.aiGenerationStatus === "FAILED" ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs text-[var(--color-error)]">{variant.aiErrorMessage ?? "Generation failed."}</p>
                    <RetryVariantControl variantId={variant.id} parentQuestionId={parent.id} />
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
