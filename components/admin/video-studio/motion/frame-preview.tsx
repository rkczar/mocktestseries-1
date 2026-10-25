"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ASPECT_MAP, type AspectRatio } from "@/lib/video-studio/types";
import { motionFrameDocument, type MotionFrameInput } from "@/lib/video-studio/motion/template";

const noSubscribe = () => () => {};

/**
 * Live, free preview of one motion frame: the exact HTML document the render
 * container captures (same fonts, word timing and motion), played by the
 * admin's browser and scaled down. CSP blocks scripts and every request
 * except the bundled fonts.
 */
export function MotionFramePreview({
  frame,
  styleKey,
  aspect,
  index,
  all,
  durationSec,
  words,
  subtitles,
  brand,
  imageSrc,
  width = 200,
  replay = true,
}: {
  frame: MotionFrameInput;
  styleKey: string;
  aspect: AspectRatio;
  index: number;
  all: { onScreen: string; tag: string | null }[];
  durationSec: number;
  words: { text: string; start: number; end: number }[];
  subtitles: boolean;
  brand: { wordmark: string; examLabel: string | null; showBranding: boolean; cta: string };
  imageSrc?: string | null;
  width?: number;
  /** false inside another button (a style picker): no nested <button>. */
  replay?: boolean;
}) {
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => null);
  const [run, setRun] = useState(0);
  const { width: W, height: H } = ASPECT_MAP[aspect];
  const scale = width / W;
  const doc = useMemo(
    () => (origin ? motionFrameDocument(frame, { aspect, styleKey, index, all, durationSec, words, subtitles, brand, imageSrc, fontBase: "/video-studio/fonts/", fontOrigin: origin }) : ""),
    [origin, frame, aspect, styleKey, index, all, durationSec, words, subtitles, brand, imageSrc]
  );
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="relative overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)] bg-black" style={{ width, height: Math.round(H * scale) }}>
        {doc ? (
          <iframe
            key={run}
            title={`Frame ${index + 1} preview`}
            srcDoc={doc}
            data-testid="motion-preview"
            loading="lazy"
            referrerPolicy="no-referrer"
            style={{ width: W, height: H, border: 0, transform: `scale(${scale})`, transformOrigin: "0 0", pointerEvents: "none" }}
          />
        ) : null}
      </div>
      {replay ? (
        <Button type="button" variant="ghost" size="compact" onClick={() => setRun((n) => n + 1)} aria-label={`Replay frame ${index + 1}`}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Replay
        </Button>
      ) : null}
    </div>
  );
}
