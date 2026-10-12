"use client";

import { useEffect, useState } from "react";
import { ImageIcon, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MEDICAL_IMAGE_LIMITS, type MedicalImage, type PostContent, type PostDesign, type SlideModule } from "@/lib/instagram/types";
import type { PostDto } from "@/lib/instagram/posts";
import type { ReferenceImageResult } from "@/lib/instagram/medical-image-core";
import { aiMedicalImageAction, medicalImageStatusAction, referenceImageSearchAction, referenceImageUseAction } from "@/app/admin/(dashboard)/instagram/studio-actions";
import type { ActFn, AskCostFn } from "@/components/admin/instagram/ai-studio-panel";

/** Stored images are served by the existing public media route (content-addressed, unguessable keys). */
const mediaSrc = (key: string) => `/media/${key}`;

function credit(img: MedicalImage): string {
  if (img.source.kind === "ai") return `AI-generated · ${img.source.model ?? "Gemini"}`;
  return `${img.source.author ?? "Unknown author"} · ${img.source.license ?? ""} · Wikimedia Commons`;
}

/**
 * Editor "Diagram & Trap" tab → optional Medical Image slide. Generate (Gemini
 * image model) or Find Reference Image (Wikimedia Commons, free licences only)
 * stores a preview candidate; the slide is added only when the admin clicks
 * Add to Carousel. Nothing is generated on page load.
 */
export function MedicalImagePanel({
  post,
  draft,
  base,
  act,
  askCost,
  onPost,
  onEditContent,
  onAddModule,
  onRemoveModule,
  defaultQuery,
}: {
  post: PostDto;
  draft: { content: PostContent; design: PostDesign };
  base: () => { postId: string; expectedRevision: number; content: PostContent; design: PostDesign };
  act: ActFn;
  askCost: AskCostFn;
  onPost: (p: PostDto, summary: string) => void;
  onEditContent: (c: Partial<PostContent>) => void;
  onAddModule: (m: SlideModule) => void;
  onRemoveModule: (m: SlideModule) => void;
  defaultQuery: string;
}) {
  const [status, setStatus] = useState<{ available: boolean; message: string } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [query, setQuery] = useState(defaultQuery);
  const [results, setResults] = useState<ReferenceImageResult[] | null>(null);
  const c = draft.content;
  const cand = c.imageCandidate;
  const img = c.medicalImage;
  const onSlide = draft.design.modules.includes("MEDICAL_IMAGE");

  // One cheap settings read (no AI call) so the admin knows before clicking.
  useEffect(() => {
    let live = true;
    medicalImageStatusAction().then((r) => live && r.ok && setStatus(r.data));
    return () => {
      live = false;
    };
  }, []);

  const setImage = (p: Partial<MedicalImage>) => img && onEditContent({ medicalImage: { ...img, ...p } });

  return (
    <section className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" data-testid="image-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Medical Image · optional extra slide</h3>
        {img && onSlide ? (
          <span className="text-xs font-medium text-[var(--color-warning)]" data-testid="image-status">
            On the carousel · check it before publishing
          </span>
        ) : null}
      </div>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        A visual memory aid added after the existing slides (before Follow). The image has no text: the title and memory tip are drawn by the app from this post. The question, options and answer are
        never changed. Images are generated or fetched only when you click.
      </p>
      <p className="text-xs" data-testid="image-provider" data-available={status ? String(status.available) : ""}>
        {status ? (status.available ? `Image generation: ${status.message}` : status.message) : "Checking image generation…"}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          data-testid="ai-image"
          disabled={status?.available === false}
          onClick={() => askCost({ feature: "ig_image", context: { postId: post.id } }, (quoteId) => act(() => aiMedicalImageAction({ ...base(), instruction, quoteId }), (r) => onPost(r.post, r.summary)))}
        >
          <Sparkles className="h-4 w-4" aria-hidden /> {cand || img ? "Regenerate" : "Generate Medical Image"}
        </Button>
      </div>
      <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder='Optional instruction, e.g. "cross-section of the spinal cord tracts"' maxLength={300} />

      <details data-testid="reference-search">
        <summary className="cursor-pointer text-xs font-medium">Find Reference Image (Wikimedia Commons · public domain / CC0 / CC BY / CC BY-SA only)</summary>
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex gap-2">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search, e.g. brachial plexus" data-testid="reference-query" />
            <Button type="button" variant="outline" onClick={() => act(() => referenceImageSearchAction({ query }), (r) => setResults(r))} data-testid="reference-go">
              <Search className="h-4 w-4" aria-hidden /> Find Reference Image
            </Button>
          </div>
          {results ? (
            results.length ? (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="reference-results">
                {results.map((r) => (
                  <li key={r.fileTitle} className="flex flex-col gap-1 rounded-md border border-[var(--color-border)] p-1.5 text-[11px]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.thumbUrl} alt={r.fileTitle} loading="lazy" className="aspect-[4/3] w-full rounded object-contain bg-white" />
                    <span className="line-clamp-2" title={r.fileTitle}>
                      {r.fileTitle.replace(/^File:/, "")}
                    </span>
                    <span className="text-[var(--color-muted-foreground)]">{`${r.license} · ${r.author}`}</span>
                    <a href={r.pageUrl} target="_blank" rel="noreferrer noopener" className="underline">
                      Source page
                    </a>
                    <Button
                      type="button"
                      size="compact"
                      variant="outline"
                      data-testid="reference-use"
                      onClick={() => act(() => referenceImageUseAction({ ...base(), fileTitle: r.fileTitle }), (x) => onPost(x.post, x.summary))}
                    >
                      Use this image
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-[var(--color-muted-foreground)]">No freely licensed images found. Try a simpler search term.</p>
            )
          ) : null}
        </div>
      </details>

      {cand ? (
        <div className="flex flex-col gap-2 rounded-md bg-[var(--color-surface)] p-2" data-testid="image-candidate">
          <p className="text-xs font-semibold">Preview — not on the carousel yet</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={mediaSrc(cand.key)} alt="Medical image preview" className="max-h-72 w-full rounded object-contain bg-white" data-testid="image-candidate-img" />
          <p className="text-[11px] text-[var(--color-muted-foreground)]">{credit(cand)}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="image-add"
              onClick={() => {
                onEditContent({ medicalImage: cand, imageCandidate: null });
                if (!onSlide) onAddModule("MEDICAL_IMAGE");
              }}
            >
              <ImageIcon className="h-4 w-4" aria-hidden /> Add to Carousel
            </Button>
            <Button type="button" size="sm" variant="ghost" data-testid="image-skip" onClick={() => onEditContent({ imageCandidate: null })}>
              Skip Image
            </Button>
          </div>
          <p className="text-[11px] text-[var(--color-muted-foreground)]">Then click Save. The slide preview on the left shows the finished slide.</p>
        </div>
      ) : null}

      {img ? (
        <div className="flex flex-col gap-2" data-testid="image-current">
          <p className="text-xs font-semibold">{onSlide ? "On the carousel" : "Approved image (slide removed from the order)"}</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={mediaSrc(img.key)} alt="Medical image on the carousel" className="max-h-56 w-full rounded object-contain bg-white" />
          <p className="text-[11px] text-[var(--color-muted-foreground)]">{credit(img)}</p>
          <label className="flex flex-col gap-1 text-xs">
            {`Title (${img.title.length}/${MEDICAL_IMAGE_LIMITS.title})`}
            <Input value={img.title} onChange={(e) => setImage({ title: e.target.value })} data-testid="image-title" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            {`Memory tip (${img.memoryTip.length}/${MEDICAL_IMAGE_LIMITS.memoryTip})`}
            <Input value={img.memoryTip} onChange={(e) => setImage({ memoryTip: e.target.value })} data-testid="image-tip" />
          </label>
          <div className="flex flex-wrap gap-2">
            {!onSlide ? (
              <Button type="button" size="sm" variant="outline" onClick={() => onAddModule("MEDICAL_IMAGE")}>
                Add to Carousel
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="image-remove"
              onClick={() => {
                onEditContent({ medicalImage: null });
                if (onSlide) onRemoveModule("MEDICAL_IMAGE");
              }}
            >
              Remove Image
            </Button>
          </div>
        </div>
      ) : null}
      {post.content.medicalImage?.key !== img?.key || post.content.imageCandidate?.key !== cand?.key ? (
        <p className="text-[11px] text-[var(--color-warning)]">Unsaved image change — click Save.</p>
      ) : null}
    </section>
  );
}
