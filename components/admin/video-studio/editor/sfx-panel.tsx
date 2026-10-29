"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Music2, Play, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { SFX_CATEGORIES, SFX_CATEGORY_LABELS, SFX_LIBRARY, SFX_MAP, sfxUrl } from "@/lib/video-studio/sfx";
import { LIMITS, anchorTime, newId, segmentOffsets, sfxChecks, sfxTimeline, type EditProject, type EditSfx } from "@/lib/video-studio/editor-model";

/**
 * AI Video Editor → Sound effects. Optional: the list starts empty and nothing is ever added without the
 * editor clicking "Add". A clip can follow a cut or an overlay (it moves with it when the edit changes);
 * preview plays the bundled WAV in the browser (and, during "Play edit", each clip as the playhead
 * passes it — approximate, the video's timeupdate is ~4 Hz); the export mixes it with FFmpeg, sample
 * accurate (no Earshot at render time).
 */
export function SfxPanel({ p, change, editable, playhead, seek, sequencePlaying = false }: { p: EditProject; change: (next: EditProject) => void; editable: boolean; playhead: number; seek: (t: number) => void; sequencePlaying?: boolean }) {
  const clips = useMemo(() => p.sfx ?? [], [p.sfx]);
  const [pick, setPick] = useState(SFX_LIBRARY[0].key);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const resolved = useMemo(() => new Map(sfxTimeline({ ...p, sfx: clips }).map((c) => [c.id, c])), [p, clips]);
  const checks = useMemo(() => sfxChecks({ ...p, sfx: clips }), [p, clips]);
  const offs = segmentOffsets(p);

  // "Play edit": start each clip when the playhead crosses its start (a jump of > 1 s is a seek, not playback).
  const last = useRef(playhead);
  const live = useRef<HTMLAudioElement[]>([]);
  useEffect(() => {
    const prev = last.current;
    last.current = playhead;
    if (!sequencePlaying || playhead < prev || playhead - prev > 1) return;
    for (const c of resolved.values()) {
      if (c.start < prev || c.start >= playhead) continue;
      const a = new Audio(sfxUrl(c.key) ?? "");
      a.volume = Math.min(1, c.volume);
      a.currentTime = c.trimIn + (playhead - c.start);
      a.addEventListener("timeupdate", () => a.currentTime >= c.trimIn + c.duration && a.pause());
      live.current.push(a);
      void a.play().catch(() => undefined);
    }
  }, [playhead, sequencePlaying, resolved]);
  useEffect(() => {
    if (sequencePlaying) return;
    for (const a of live.current) a.pause();
    live.current = [];
  }, [sequencePlaying]);
  useEffect(() => () => {
    audio.current?.pause();
    for (const a of live.current) a.pause();
  }, []);

  function preview(key: string, trimIn = 0, trimOut?: number, volume = 1) {
    const url = sfxUrl(key);
    if (!url) return;
    audio.current?.pause();
    if (playing === key) return setPlaying(null);
    const a = new Audio(url);
    a.volume = Math.min(1, volume);
    a.currentTime = trimIn;
    if (trimOut !== undefined) a.addEventListener("timeupdate", () => a.currentTime >= trimOut && (a.pause(), setPlaying(null)));
    a.addEventListener("ended", () => setPlaying(null));
    audio.current = a;
    setPlaying(key);
    void a.play().catch(() => setPlaying(null));
  }

  const setClip = (id: string, patch: Partial<EditSfx>) => change({ ...p, sfx: clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

  function add() {
    const s = SFX_MAP[pick];
    // A transition sound lands its loudest moment on the playhead; everything else starts there.
    const start = Math.max(0, Math.round((playhead - (s.category === "transition" ? s.peakAtSec : 0)) * 100) / 100);
    change({ ...p, sfx: [...clips, { id: newId(), key: s.key, start, anchor: null, offsetSec: 0, trimIn: 0, trimOut: s.durationSec, volume: s.category === "emphasis" ? 0.7 : 0.8, fadeInSec: 0, fadeOutSec: 0 }] });
  }

  /** Anchor choices: every cut after the first segment, and every overlay start. */
  const anchors = [
    ...p.segments.slice(1).map((s, i) => ({ value: `cut:${s.id}`, label: `Cut ${i + 1} (${offs[i + 1].toFixed(1)} s)` })),
    ...p.overlays.map((o) => ({ value: `overlay:${o.id}`, label: `${o.kind} overlay (${o.start.toFixed(1)} s)` })),
  ];

  function setAnchor(c: EditSfx, value: string) {
    if (!value) {
      const r = resolved.get(c.id);
      return setClip(c.id, { anchor: null, offsetSec: 0, start: r?.start ?? c.start });
    }
    const [kind, id] = value.split(":") as ["cut" | "overlay", string];
    const at = anchorTime(p, { kind, id }) ?? 0;
    const s = SFX_MAP[c.key];
    // Default offset: a transition sound's peak on the event; anything else starts on it.
    setClip(c.id, { anchor: { kind, id }, offsetSec: s.category === "transition" ? -Math.min(s.peakAtSec, at) : 0, start: at });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Music2 className="h-4 w-4" aria-hidden /> Sound effects (optional)</CardTitle>
        <CardDescription>Short effects from the built-in library. Nothing is added automatically. Attach an effect to a cut or an overlay and it moves with it when you trim or reorder. &quot;Play edit&quot; previews them roughly in time; the export places them exactly.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <SelectNative aria-label="Sound" className="h-8 w-auto text-xs" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="sfx-pick">
            {SFX_CATEGORIES.map((cat) => (
              <optgroup key={cat} label={SFX_CATEGORY_LABELS[cat]}>
                {SFX_LIBRARY.filter((s) => s.category === cat).map((s) => <option key={s.key} value={s.key}>{`${s.label} (${s.durationSec.toFixed(1)} s)`}</option>)}
              </optgroup>
            ))}
          </SelectNative>
          <Button type="button" size="sm" variant="outline" onClick={() => preview(pick)} data-testid="sfx-preview">
            {playing === pick ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />} Preview
          </Button>
          {editable ? (
            <Button type="button" size="sm" variant="outline" disabled={clips.length >= LIMITS.sfx} onClick={add} data-testid="sfx-add">+ Add at playhead</Button>
          ) : null}
        </div>
        {checks.length ? (
          <ul className="flex flex-col gap-1 text-xs" data-testid="sfx-checks">
            {checks.map((c) => (
              <li key={c.code} className={c.severity === "warn" ? "flex items-start gap-1 text-[var(--color-warning)]" : "flex items-start gap-1 text-[var(--color-muted-foreground)]"}>
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {c.message}
              </li>
            ))}
          </ul>
        ) : null}
        <ol className="flex flex-col gap-2" data-testid="sfx-clips">
          {clips.length === 0 ? <li className="text-xs text-[var(--color-muted-foreground)]">No sound effects. The video uses only its own audio and music.</li> : null}
          {clips.map((c) => {
            const s = SFX_MAP[c.key];
            const r = resolved.get(c.id);
            return (
              <li key={c.id} className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-2 text-xs" data-sfx={c.key}>
                <div className="flex flex-wrap items-center gap-2">
                  <b>{s?.label ?? c.key}</b>
                  <button type="button" className="underline" onClick={() => r && seek(r.start)}>{r ? `plays ${r.start.toFixed(2)}–${(r.start + r.duration).toFixed(2)} s` : "does not play (after the end)"}</button>
                  <Button type="button" size="sm" variant="outline" aria-label="Preview this clip" onClick={() => preview(c.key, c.trimIn, c.trimOut, c.volume)}><Play className="h-3.5 w-3.5" aria-hidden /></Button>
                  <Button type="button" size="sm" variant="outline" className="ml-auto" aria-label="Remove sound effect" disabled={!editable} onClick={() => change({ ...p, sfx: clips.filter((x) => x.id !== c.id) })} data-testid="sfx-remove"><Trash2 className="h-3.5 w-3.5" aria-hidden /></Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1">Follow
                    <SelectNative aria-label="Follow" className="h-7 w-auto text-xs" disabled={!editable} value={c.anchor ? `${c.anchor.kind}:${c.anchor.id}` : ""} onChange={(e) => setAnchor(c, e.target.value)}>
                      <option value="">Fixed time</option>
                      {anchors.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                    </SelectNative>
                  </label>
                  {c.anchor ? (
                    <label className="flex items-center gap-1">Offset (s)<Input type="number" step={0.05} min={-5} max={5} className="h-7 w-20 text-xs" disabled={!editable} value={c.offsetSec} onChange={(e) => setClip(c.id, { offsetSec: Number(e.target.value) })} /></label>
                  ) : (
                    <label className="flex items-center gap-1">At (s)<Input type="number" step={0.05} min={0} className="h-7 w-20 text-xs" disabled={!editable} value={c.start} onChange={(e) => setClip(c.id, { start: Number(e.target.value) })} /></label>
                  )}
                  <label className="flex items-center gap-1">Trim<Input type="number" step={0.05} min={0} aria-label="Trim start" className="h-7 w-16 text-xs" disabled={!editable} value={c.trimIn} onChange={(e) => setClip(c.id, { trimIn: Number(e.target.value) })} />–<Input type="number" step={0.05} aria-label="Trim end" className="h-7 w-16 text-xs" disabled={!editable} value={c.trimOut} onChange={(e) => setClip(c.id, { trimOut: Number(e.target.value) })} /></label>
                  <label className="flex items-center gap-1">Volume<Input type="number" step={0.1} min={0} max={1.5} className="h-7 w-16 text-xs" disabled={!editable} value={c.volume} onChange={(e) => setClip(c.id, { volume: Number(e.target.value) })} /></label>
                  <label className="flex items-center gap-1">Fade in/out<Input type="number" step={0.05} min={0} aria-label="Fade in" className="h-7 w-16 text-xs" disabled={!editable} value={c.fadeInSec} onChange={(e) => setClip(c.id, { fadeInSec: Number(e.target.value) })} /><Input type="number" step={0.05} min={0} aria-label="Fade out" className="h-7 w-16 text-xs" disabled={!editable} value={c.fadeOutSec} onChange={(e) => setClip(c.id, { fadeOutSec: Number(e.target.value) })} /></label>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
