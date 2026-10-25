"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ASPECT_MAP, type AspectRatio } from "@/lib/video-studio/types";
import type { DesignTheme } from "@/lib/video-studio/designs";
import { sceneDocument, type TemplateBrand, type TemplateScene } from "@/lib/video-studio/template";

const noSubscribe = () => () => {};

/**
 * Live, free scene preview: the exact HTML the render worker captures, drawn
 * by the admin's own browser (correct Devanagari shaping) and scaled down.
 * The document's CSP blocks scripts and every network request except the
 * bundled fonts.
 */
export function ScenePreview({
  scene,
  theme,
  aspect,
  brand,
  subtitles = true,
  width = 240,
  title = "Scene preview",
}: {
  scene: TemplateScene;
  theme: DesignTheme;
  aspect: AspectRatio;
  brand: TemplateBrand;
  subtitles?: boolean;
  width?: number;
  title?: string;
}) {
  // The admin site's origin is needed for the document's CSP (font-src); null during server rendering.
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => null);
  const [run, setRun] = useState(0);
  const { width: W, height: H } = ASPECT_MAP[aspect];
  const scale = width / W;
  const doc = useMemo(
    () => (origin ? sceneDocument(scene, { aspect, theme, brand, subtitles, fontBase: "/video-studio/fonts/", fontOrigin: origin }) : ""),
    [origin, scene, aspect, theme, brand, subtitles]
  );
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="relative overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-black" style={{ width, height: Math.round(H * scale) }}>
        {doc ? (
          <iframe
            key={run}
            title={title}
            srcDoc={doc}
            data-testid="scene-preview"
            loading="lazy"
            referrerPolicy="no-referrer"
            style={{ width: W, height: H, border: 0, transform: `scale(${scale})`, transformOrigin: "0 0", pointerEvents: "none" }}
          />
        ) : null}
      </div>
      <Button type="button" variant="ghost" size="compact" onClick={() => setRun((n) => n + 1)} aria-label={`Replay ${title}`}>
        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Replay
      </Button>
    </div>
  );
}
