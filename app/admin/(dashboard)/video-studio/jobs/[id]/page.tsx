import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { JobWorkspace } from "@/components/admin/video-studio/job-workspace";
import { getVoiceCatalog, voicesFor } from "@/lib/video-studio/voices";
import { getVideoSettings } from "@/lib/video-studio/settings";
import type { VideoConfig, VideoSource } from "@/lib/video-studio/types";
import type { JobEstimate } from "@/lib/video-studio/jobs";
import { readAssets } from "@/lib/video-studio/assets";
import { EditorWorkspace } from "@/components/admin/video-studio/editor/editor-workspace";
import type { EditProject } from "@/lib/video-studio/editor-model";
import type { SceneVisual } from "@/lib/video-studio/template";

export const dynamic = "force-dynamic";

export default async function VideoJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-z0-9]{20,40}$/.test(id)) notFound();
  const job = await prisma.videoJob.findUnique({
    where: { id },
    include: { scenes: { orderBy: { index: "asc" } }, events: { orderBy: { createdAt: "desc" }, take: 30 } },
  });
  if (!job) notFound();
  if (job.kind === "MOTION") redirect(`/admin/video-studio/motion/${job.id}`);
  const [canUse, catalog, settings, exams] = await Promise.all([
    hasPermission(PERMISSIONS.VIDEO_STUDIO_USE),
    getVoiceCatalog(),
    getVideoSettings(),
    prisma.exam.findMany({ where: { isActive: true }, orderBy: [{ order: "asc" }, { name: "asc" }], select: { name: true } }),
  ]);
  const assets = readAssets(job);
  const estimate = (job.estimate ?? {}) as Record<string, unknown> & { voice?: { mode: "voice" | "silent"; model: string | null; voice: string | null; estInr: number }; voicePending?: unknown; transcribePending?: unknown; transcribe?: unknown };
  const base = {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progressPct: job.progressPct,
    failedStage: job.failedStage,
    errorMessage: job.errorMessage,
    outputKey: job.outputKey,
    outputBytes: job.outputBytes === null ? null : Number(job.outputBytes),
    outputSec: job.outputSec,
    renderMs: job.renderMs,
    mediaDeleted: Boolean(job.mediaDeletedAt),
  };
  if (job.kind === "EDIT") {
    return (
      <EditorWorkspace
        canUse={canUse}
        job={{ ...base, title: job.title, actualInr: job.actualInr, unknownCostCalls: job.unknownCostCalls, transcribePending: (estimate.transcribePending as never) ?? null, transcript: ((job.config as { transcript?: string } | null)?.transcript ?? null) }}
        project={(job.edit as unknown as EditProject | null) ?? null}
        assets={assets}
        events={job.events.map((e) => ({ id: e.id, type: e.type, message: e.message, at: e.createdAt.toISOString() }))}
        sttModels={catalog.sttModels.filter((m) => m.perSecondUsd !== null).map((m) => ({ id: m.id, name: m.name, perSecondUsd: m.perSecondUsd! }))}
        defaultSttModel={settings.transcriptionModel}
        wordmark={settings.brand.wordmark}
      />
    );
  }
  const cfg = job.config as unknown as VideoConfig | null;
  const voiceModels = catalog.models
    .filter((m) => catalog.approvedModels.includes(m.id))
    .map((m) => ({ id: m.id, name: m.name, voices: cfg ? voicesFor(m, cfg.language) : [] }))
    .filter((m) => m.voices.length);
  return (
    <JobWorkspace
      canUse={canUse}
      job={{
        id: job.id,
        title: job.title,
        status: job.status,
        source: job.source as unknown as VideoSource,
        customPrompt: job.customPrompt ?? "",
        config: cfg,
        estimate: job.estimate as unknown as JobEstimate | null,
        actualInr: job.actualInr,
        unknownCostCalls: job.unknownCostCalls,
        createdAt: job.createdAt.toISOString(),
        confirmedAt: job.confirmedAt?.toISOString() ?? null,
        errorMessage: job.errorMessage,
        mediaDeletedAt: job.mediaDeletedAt?.toISOString() ?? null,
      }}
      scenes={job.scenes.map((s) => ({ id: s.id, index: s.index, narration: s.narration, onScreenText: s.onScreenText, durationSec: s.durationSec, needsReview: s.needsReview, reviewNote: s.reviewNote, visual: s.visual }))}
      events={job.events.map((e) => ({ id: e.id, type: e.type, message: e.message, at: e.createdAt.toISOString() }))}
      voiceModels={voiceModels}
      examNames={exams.map((e) => e.name)}
      brand={settings.brand}
      assets={assets}
      prod={{
        ...base,
        voice: estimate.voice ? { mode: estimate.voice.mode, model: estimate.voice.model, voice: estimate.voice.voice, estInr: estimate.voice.estInr } : null,
        voicePending: (estimate.voicePending as never) ?? null,
        music: { on: Boolean((cfg as { music?: boolean } | null)?.music), key: (cfg as { musicKey?: string | null } | null)?.musicKey ?? null },
        aspect: cfg?.aspect ?? "9:16",
      }}
      prodScenes={job.scenes.map((s) => ({ id: s.id, index: s.index, narration: s.narration, onScreenText: s.onScreenText, durationSec: s.durationSec, needsReview: s.needsReview, reviewNote: s.reviewNote, visual: s.visual as unknown as SceneVisual | null, audioKey: s.audioKey, audioSec: s.audioSec, regenPending: Boolean(s.regenQuoteId) }))}
    />
  );
}
