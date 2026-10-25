"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MotionFramePreview } from "@/components/admin/video-studio/motion/frame-preview";
import { MOTION_LABELS, MOTION_STYLES } from "@/lib/video-studio/motion/styles";
import { defaultTag, estimateTiming, type MotionVisual } from "@/lib/video-studio/motion/storyboard";

/** A three-frame sample (hook → diagram → stat) every style renders, so styles can be compared on the same content. */
const SAMPLE: { sentence: string; onScreen: string; visual: Omit<MotionVisual, "motion" | "tag"> }[] = [
  { sentence: "Heart attack के बाद सबसे पहले कौन सा marker बढ़ता है?", onScreen: "Which marker rises first?", visual: { kind: "motion", type: "statement", highlight: "first" } },
  { sentence: "Plaque rupture, फिर thrombus, और फिर necrosis होता है।", onScreen: "MI pathway", visual: { kind: "motion", type: "diagram", highlight: "pathway", nodes: ["Plaque rupture", "Thrombus", "Necrosis"] } },
  { sentence: "Troponin I 3 से 6 घंटे में बढ़ता है।", onScreen: "Troponin I rises in 6 hours", visual: { kind: "motion", type: "stat", highlight: "Troponin", value: "6", unit: "hours" } },
];
const timing = estimateTiming(SAMPLE.map((s) => s.sentence), "hinglish", null, "reading");

export function MotionStyleGallery({ wordmark }: { wordmark: string }) {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-[var(--color-muted-foreground)]">
        One style per video, locked from the first frame to the last. The previews below are the exact documents the renderer captures (live, free). Styles are independent re-implementations of publicly described storyboard styles, adapted for medical teaching.
      </p>
      {MOTION_STYLES.map((s) => (
        <Card key={s.key} data-style={s.key}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">{s.name}<Badge>Idea: “{s.inspiredBy}”</Badge>{s.status === "needs_images" ? <Badge variant="warning">Needs your images</Badge> : <Badge variant="success">Ready</Badge>}</CardTitle>
            <CardDescription>{s.job} — {s.description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-3">
              {SAMPLE.map((f, i) => {
                const t = timing.frames[i];
                return (
                  <MotionFramePreview
                    key={i}
                    frame={{ sentence: f.sentence, onScreen: f.onScreen, visual: { ...f.visual, motion: s.motions[i % s.motions.length], tag: s.tagHint ? defaultTag(s, i, SAMPLE.length) : null } as MotionVisual }}
                    styleKey={s.key}
                    aspect="9:16"
                    index={i}
                    all={SAMPLE.map((x) => ({ onScreen: x.onScreen, tag: null }))}
                    durationSec={t.end - t.start}
                    words={timing.words.filter((w) => w.frame === i).map((w) => ({ text: w.text, start: w.start - t.start, end: w.end - t.start }))}
                    subtitles
                    brand={{ wordmark, examLabel: "NEET PG", showBranding: true, cta: "" }}
                    width={150}
                  />
                );
              })}
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-[var(--color-muted-foreground)]">
              <dt>Best for</dt><dd>{s.bestFor.join(", ")}</dd>
              <dt>Motions</dt><dd>{s.motions.map((m) => MOTION_LABELS[m].label).join(", ")}</dd>
              <dt>Transition</dt><dd>{s.transition.type === "none" ? "Continuous camera" : `${s.transition.type} (${s.transition.sec}s)`}</dd>
              <dt>Highlight</dt><dd>{s.highlight}{s.grain ? " · film grain" : ""}</dd>
            </dl>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
