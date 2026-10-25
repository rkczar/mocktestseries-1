import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { MotionWorkspace, type MotionFrameRow } from "@/components/admin/video-studio/motion/motion-workspace";
import { getVoiceCatalog, voicesFor } from "@/lib/video-studio/voices";
import { getVideoSettings } from "@/lib/video-studio/settings";
import { readAssets } from "@/lib/video-studio/assets";
import { motionChecks } from "@/lib/video-studio/motion/jobs";
import type { MotionConfig, MotionVisual } from "@/lib/video-studio/motion/storyboard";
import type { QaCheck } from "@/lib/video-studio/motion/quality";

export const dynamic = "force-dynamic";

export default async function MotionJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-z0-9]{20,40}$/.test(id)) notFound();
  const job = await prisma.videoJob.findUnique({ where: { id }, include: { scenes: { orderBy: { index: "asc" } }, events: { orderBy: { createdAt: "desc" }, take: 40 } } });
  if (!job || job.kind !== "MOTION") notFound();
  const [canUse, catalog, settings, checks] = await Promise.all([hasPermission(PERMISSIONS.VIDEO_STUDIO_USE), getVoiceCatalog(), getVideoSettings(), motionChecks(job)]);
  const cfg = job.config as unknown as MotionConfig & { take?: { key: string; sec: number } | null; renderQa?: QaCheck[] };
  const e = (job.estimate ?? {}) as Record<string, unknown> & { motionVoicePending?: never; motionVoice?: { mode: "voice" | "silent"; model: string | null; voice: string | null; sync: string } };
  const stt = catalog.sttModels.find((m) => m.id === settings.transcriptionModel && m.perSecondUsd !== null);
  const frames: MotionFrameRow[] = job.scenes.map((s) => ({ id: s.id, index: s.index, sentence: s.narration, onScreen: s.onScreenText, visual: s.visual as unknown as MotionVisual, durationSec: s.durationSec, needsReview: s.needsReview, reviewNote: s.reviewNote }));
  return (
    <MotionWorkspace
      canUse={canUse}
      job={{
        id: job.id,
        title: job.title,
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
        actualInr: job.actualInr,
        unknownCostCalls: job.unknownCostCalls,
        scriptEstimate: job.status === "AWAITING_CONFIRMATION" ? ((job.estimate as never) ?? null) : null,
        voicePending: e.motionVoicePending ?? null,
        voice: e.motionVoice ? { mode: e.motionVoice.mode, model: e.motionVoice.model, voice: e.motionVoice.voice, sync: e.motionVoice.sync } : null,
        take: cfg.take ? { key: cfg.take.key, sec: cfg.take.sec } : null,
      }}
      cfg={cfg}
      frames={frames}
      checks={checks}
      renderQa={job.outputKey && Array.isArray(cfg.renderQa) ? cfg.renderQa : null}
      voiceModels={catalog.models.filter((m) => catalog.approvedModels.includes(m.id)).map((m) => ({ id: m.id, name: m.name, voices: voicesFor(m, cfg.language) })).filter((m) => m.voices.length)}
      sttModel={stt?.id ?? null}
      events={job.events.map((ev) => ({ id: ev.id, type: ev.type, message: ev.message, at: ev.createdAt.toISOString() }))}
      brand={{ wordmark: settings.brand.wordmark, examLabel: cfg.examLabel, showBranding: cfg.branding, cta: cfg.cta }}
      assets={readAssets(job)}
    />
  );
}
