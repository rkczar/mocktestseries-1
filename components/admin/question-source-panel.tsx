import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ISSUE_DEFS } from "@/lib/ai-import/config";

/**
 * Source evidence of a Question Bank question (QuestionSourceEvidence): the ORIGINAL question crop and the ORIGINAL answer-key
 * crop (genuine stored pixels, served by /api/admin/questions/[id]/source/[part]) with provenance and verification
 * flags, so student preview ↔ original question ↔ official key can be compared on one screen. Missing evidence is shown
 * as an explicit unavailable state, never a recreation.
 */
const KEY_STATUS: Record<string, { label: string; variant: "success" | "warning" | "neutral" | "error" }> = {
  OFFICIAL: { label: "Official key", variant: "success" },
  PROVISIONAL: { label: "Provisional key", variant: "warning" },
  UNCONFIRMED: { label: "Key not confirmed for this paper", variant: "warning" },
  NO_ENTRY: { label: "Answer key has no entry for this number", variant: "error" },
  NOT_AVAILABLE: { label: "Answer Key Not Available", variant: "neutral" },
};

function Img({ src, alt, testId }: { src: string; alt: string; testId: string }) {
  return (
    <a href={src} target="_blank" rel="noreferrer" title="Open full size (zoom)">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} loading="lazy" className="w-full rounded border border-[var(--color-border)] bg-white" data-testid={testId} />
    </a>
  );
}

export async function QuestionSourcePanel({ questionId }: { questionId: string }) {
  const s = await prisma.questionSourceEvidence.findUnique({ where: { questionId } });
  if (!s) {
    return (
      <Card data-testid="source-evidence-missing">
        <CardHeader>
          <CardTitle>Source evidence</CardTitle>
          <CardDescription>No original source is stored for this question (added by hand, or imported before source evidence was kept). Nothing is shown rather than a recreation.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const crops = (Array.isArray(s.questionCrops) ? s.questionCrops : []) as { key: string; page: number; box: unknown }[];
  const key = s.keyCrop as { key: string; page: number; kind: "CELL" | "PAGE" } | null;
  const ks = KEY_STATUS[s.keyStatus ?? "NOT_AVAILABLE"] ?? KEY_STATUS.NOT_AVAILABLE;
  const issues = (s.issues ?? {}) as Record<string, string>;
  const fact = (label: string, value: React.ReactNode) => (
    <div>
      <dt className="text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className="font-medium break-words">{value ?? "—"}</dd>
    </div>
  );
  return (
    <Card data-testid="source-evidence">
      <CardHeader>
        <CardTitle>Source evidence</CardTitle>
        <CardDescription>Original paper and official answer key, as cut from the uploaded files. Click an image to open it full size.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <section className="flex flex-col gap-2" data-testid="source-question">
          <h3 className="text-sm font-semibold">Original question{s.sourceLabel ? ` ${s.section ? `${s.section} ` : ""}${s.sourceLabel}` : ""}</h3>
          {crops.length ? crops.map((c, i) => <figure key={c.key} className="flex flex-col gap-1"><Img src={`/api/admin/questions/${questionId}/source/q${i}`} alt={`Original question, page ${c.page}`} testId="source-question-crop" /><figcaption className="text-xs text-[var(--color-muted-foreground)]">{s.fileName ?? "Source file"} · page {c.page}</figcaption></figure>) : <p className="rounded border border-dashed p-3 text-xs" data-testid="source-question-unavailable">Original question crop unavailable{s.cropNote ? `: ${s.cropNote}` : "."}</p>}
          {crops.length && s.cropNote ? <p className="text-xs text-[var(--color-muted-foreground)]">{s.cropNote}</p> : null}
        </section>
        <section className="flex flex-col gap-2" data-testid="source-key">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            Official answer key <Badge variant={ks.variant} data-testid="source-key-status">{ks.label}</Badge>
          </h3>
          {key ? <figure className="flex flex-col gap-1"><Img src={`/api/admin/questions/${questionId}/source/key`} alt={`Answer key entry for question ${s.sourceLabel ?? ""}`} testId="source-key-crop" /><figcaption className="text-xs text-[var(--color-muted-foreground)]">{s.keyFileName ?? "Answer key"} · page {key.page}{key.kind === "PAGE" ? " (whole page — find number " + (s.sourceLabel ?? "") + ")" : ""}</figcaption></figure> : <p className="rounded border border-dashed p-3 text-xs" data-testid="source-key-unavailable">{s.keyStatus === "NOT_AVAILABLE" ? "Answer Key Not Available — upload the official key to the import; matching updates this question." : "Answer-key crop unavailable."}</p>}
        </section>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs" data-testid="source-facts">
          {fact("Paper", [s.paperTitle, s.year].filter(Boolean).join(" · ") || null)}
          {fact("Question number", s.sourceLabel)}
          {fact("Source file · page", s.fileName ? `${s.fileName} · p ${s.pages.join(", ") || "—"}` : null)}
          {fact("Answer key file · page", s.keyFileName ? `${s.keyFileName} · p ${s.keyPage ?? "—"}` : null)}
          {fact("Official answer (key)", s.officialAnswerRaw ?? (s.officialAnswer.join(", ") || null))}
          {fact("Extracted / AI answer", [s.extractedAnswer.join(", "), s.aiAnswer.length ? `AI ${s.aiAnswer.join(", ")}` : ""].filter(Boolean).join(" · ") || null)}
          {fact("Answer status", s.answerStatus)}
          {fact("Read by", [s.ocrEngine, typeof s.ocrConfidence === "number" ? `confidence ${Math.round(s.ocrConfidence * 100)}%` : ""].filter(Boolean).join(" · ") || null)}
          {fact("Import", s.jobId && s.aiImportQuestionId ? <Link className="underline" href={`/admin/ai-importer/questions/${s.aiImportQuestionId}`}>{s.jobTitle ?? "AI import"}</Link> : s.jobTitle)}
          {fact("Captured", s.updatedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC")}
        </dl>
        {s.issueCodes.length ? (
          <ul className="flex flex-col gap-1 text-xs" data-testid="source-flags">
            {s.issueCodes.map((c) => (
              <li key={c}>
                <Badge variant="warning">{ISSUE_DEFS[c]?.label ?? c}</Badge> <span className="text-[var(--color-muted-foreground)]">{String(issues[c] ?? "").slice(0, 300)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {s.sourceText ? (
          <details className="text-xs">
            <summary className="cursor-pointer">Original text as read (OCR / text layer)</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-muted)] p-2">{s.sourceText}</pre>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
