"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SelectNative } from "@/components/ui/select-native";
import { ScenePreview } from "@/components/admin/video-studio/scene-preview";
import { VIDEO_DESIGNS } from "@/lib/video-studio/designs";
import { SAMPLE_SCENES } from "@/lib/video-studio/samples";
import { ASPECTS, type AspectRatio } from "@/lib/video-studio/types";

const ANIM = { none: "Static", subtle: "Subtle motion", moderate: "Moderate motion", high: "High motion" } as const;

/**
 * Design Gallery: every ready design is previewed live by the admin's browser
 * from the shared scene template (no paid generation, no stored samples to go
 * stale). Designs that need something not configured yet say so instead of
 * offering a Select button.
 */
export function DesignGallery({ wordmark, canUse }: { wordmark: string; canUse: boolean }) {
  const [aspect, setAspect] = useState<AspectRatio>("9:16");
  const [sample, setSample] = useState(SAMPLE_SCENES[0].key);
  const scene = SAMPLE_SCENES.find((s) => s.key === sample)!.scene;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Aspect ratio
          <SelectNative value={aspect} onChange={(e) => setAspect(e.target.value as AspectRatio)} className="h-9 w-56">
            {ASPECTS.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </SelectNative>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Sample scene
          <SelectNative value={sample} onChange={(e) => setSample(e.target.value)} className="h-9 w-48">
            {SAMPLE_SCENES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </SelectNative>
        </label>
        <p className="max-w-xl text-xs text-[var(--color-muted-foreground)]">
          Previews are drawn by your browser from the exact template the renderer uses. Rendering cost: no provider charge (local CPU). Render time per video is shown once the worker has measured it.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="design-gallery">
        {VIDEO_DESIGNS.map((d) => (
          <Card key={d.key} data-design={d.key} data-status={d.status}>
            <CardHeader className="gap-1">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                {d.name}
                <Badge variant={d.status === "ready" ? "success" : "neutral"}>{d.status === "ready" ? "Ready" : "Not available yet"}</Badge>
              </CardTitle>
              <CardDescription>{d.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-xs">
              {d.status === "ready" && d.aspects.includes(aspect) ? (
                <ScenePreview scene={scene} theme={d.theme} aspect={aspect} brand={{ wordmark, examLabel: "NEET PG", showBranding: true, cta: "" }} width={aspect === "16:9" ? 300 : 200} title={`${d.name} preview`} />
              ) : d.status === "ready" ? (
                <p className="text-[var(--color-muted-foreground)]">Not designed for {aspect}.</p>
              ) : (
                <p className="text-[var(--color-muted-foreground)]">{d.laterReason}</p>
              )}
              <p><span className="text-[var(--color-muted-foreground)]">Best for:</span> {d.bestFor.join(", ")}</p>
              <p><span className="text-[var(--color-muted-foreground)]">Aspect ratios:</span> {d.aspects.join(" · ")}</p>
              <p><span className="text-[var(--color-muted-foreground)]">Animation:</span> {ANIM[d.animation]}</p>
              <p><span className="text-[var(--color-muted-foreground)]">Cost:</span> no provider charge for rendering</p>
              {canUse && d.status === "ready" ? (
                <Button asChild size="sm" variant="outline" className="mt-1 self-start">
                  <Link href={`/admin/video-studio/new?design=${d.key}`}>Select</Link>
                </Button>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
