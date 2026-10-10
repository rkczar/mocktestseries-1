"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CAPTION_STYLE_LABELS, type CaptionStyle, type CaptionVariant, type PostContent, type PostDesign } from "@/lib/instagram/types";
import type { PostDto } from "@/lib/instagram/posts";
import { aiCaptionsAction } from "@/app/admin/(dashboard)/instagram/studio-actions";
import type { ActFn, ProviderChoice } from "@/components/admin/instagram/ai-studio-panel";

/** "Generate Trend-Informed Caption": three editable versions; choosing one copies it into the caption + hashtags. */
export function CaptionVersions({
  post,
  variants,
  currentStyle,
  disabled,
  provider,
  draftPayload,
  act,
  onPost,
  onUse,
}: {
  post: PostDto;
  variants: CaptionVariant[];
  currentStyle: CaptionStyle | null;
  disabled: boolean;
  provider: ProviderChoice;
  draftPayload: () => { content: PostContent; design: PostDesign };
  act: ActFn;
  onPost: (p: PostDto, summary: string) => void;
  onUse: (v: CaptionVariant) => void;
}) {
  const [instruction, setInstruction] = useState("");
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="caption-versions">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">Trend-informed caption versions</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          data-testid="ai-captions"
          onClick={() =>
            act(
              (confirm) => aiCaptionsAction({ postId: post.id, expectedRevision: post.revision, ...draftPayload(), confirmReplaceApproved: confirm, provider: provider === "default" ? null : provider, instruction }),
              (r) => onPost(r.post, r.summary)
            )
          }
        >
          <Sparkles className="h-4 w-4" aria-hidden /> {variants.length ? "Regenerate 3 versions" : "Generate Trend-Informed Caption"}
        </Button>
      </div>
      <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} disabled={disabled} placeholder="Optional instruction for the captions" />
      <p className="text-[11px] text-[var(--color-muted-foreground)]">
        Uses only stored evidence (your post metrics, platform data, reference posts you entered). It never claims something is trending without evidence, never copies competitor
        captions and excludes NEET UG keywords.
      </p>
      {variants.map((v) => (
        <div key={v.style} className={cn("flex flex-col gap-1 rounded-md border p-2 text-sm", currentStyle === v.style ? "border-[var(--color-primary)]" : "border-[var(--color-border)]")} data-testid={`caption-${v.style}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">{CAPTION_STYLE_LABELS[v.style]}</span>
            <Button type="button" size="compact" variant={currentStyle === v.style ? "primary" : "outline"} disabled={disabled} onClick={() => onUse(v)} data-testid={`use-caption-${v.style}`}>
              {currentStyle === v.style ? "In use" : "Use this version"}
            </Button>
          </div>
          <p className="whitespace-pre-wrap text-xs">{v.caption}</p>
          <p className="text-[11px] text-[var(--color-muted-foreground)]">{v.hashtags.join(" ")}</p>
        </div>
      ))}
      {post.content.keywords.length ? <p className="text-[11px] text-[var(--color-muted-foreground)]">{`Keywords: ${post.content.keywords.join(", ")}`}</p> : null}
    </div>
  );
}
