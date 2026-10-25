import "server-only";
import { spawn } from "node:child_process";
import { chown, lstat, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { ensureJobDir, JOB_ID } from "@/lib/video-studio/storage";

/**
 * Host side of the isolated render container (ops/video-worker/). Called ONLY
 * by the video worker process (scripts/video-worker.ts), never from a web
 * request. Each task runs in a fresh container:
 *
 *   --network none        nothing inside can reach any network
 *   --read-only           root filesystem read-only; /tmp is a small tmpfs
 *   --cap-drop ALL, --security-opt no-new-privileges, non-root uid
 *   --cpus / --cpu-shares / --memory / --pids-limit   bounded resources; the
 *                         web app wins CPU contention (low cpu-shares)
 *   mounts: the job folder (rw), the fonts (ro), render.mjs (ro) — nothing else.
 *
 * Arguments are an array (no shell). The task file, its progress and result
 * files live inside the job folder; paths in a task are relative to it and
 * re-validated inside the container.
 */

export const RENDER_IMAGE = process.env.VIDEO_RENDER_IMAGE || "mts-video-render:1";
const DOCKER = "/usr/bin/docker";
/** Unprivileged uid/gid the container runs as; the job folder is handed to it before a task. */
export const RENDER_UID = 10001;

export class RenderError extends Error {
  constructor(
    message: string,
    readonly kind: "unavailable" | "failed" | "timeout" | "cancelled"
  ) {
    super(message);
    this.name = "RenderError";
  }
}

export interface RenderLimits {
  cpus: number;
  memoryMb: number;
}

export interface RenderProgress {
  stage: string;
  pct: number;
  [k: string]: unknown;
}

function appRoot(): string {
  return process.cwd();
}

function dockerArgs(name: string, dir: string, taskRel: string, limits: RenderLimits): string[] {
  const root = appRoot();
  return [
    "run", "--rm", "--name", name,
    "--network", "none",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=768m", "--shm-size", "256m",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", `${RENDER_UID}:${RENDER_UID}`,
    "--cpus", String(limits.cpus), "--cpu-shares", "256",
    "--memory", `${limits.memoryMb}m`, "--memory-swap", `${limits.memoryMb}m`, "--pids-limit", "512",
    "--label", "mts.video=1",
    "-v", `${dir}:/work:rw`,
    "-v", `${path.join(/* turbopackIgnore: true */ root, "public/video-studio/fonts")}:/fonts:ro`,
    "-v", `${path.join(/* turbopackIgnore: true */ root, "ops/video-worker/render.mjs")}:/opt/render/render.mjs:ro`,
    RENDER_IMAGE,
    taskRel,
  ];
}

function exec(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(DOCKER, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-8000)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-8000)));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: "docker could not be started" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Is the render image present? Returns tool versions recorded in the worker heartbeat. */
export async function renderToolchain(): Promise<{ ok: boolean; image: string; ffmpeg: string | null; chromium: string | null; error: string | null }> {
  if (!existsSync(path.resolve(/* turbopackIgnore: true */ DOCKER))) return { ok: false, image: RENDER_IMAGE, ffmpeg: null, chromium: null, error: "Docker is not installed." };
  const r = await exec(["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--user", `${RENDER_UID}:${RENDER_UID}`, "--entrypoint", "sh", RENDER_IMAGE, "-c", "ffmpeg -hide_banner -version | head -1; chromium --version"], 60_000);
  if (r.code !== 0) return { ok: false, image: RENDER_IMAGE, ffmpeg: null, chromium: null, error: /No such image|Unable to find image/i.test(r.stderr) ? `Render image ${RENDER_IMAGE} is not built.` : "Render container could not start." };
  const lines = r.stdout.split("\n");
  const ff = /ffmpeg version (\S+)/.exec(lines[0] ?? "")?.[1] ?? null;
  const ch = /Chromium (\S+)/.exec(lines[1] ?? "")?.[1] ?? null;
  return { ok: !!ff && !!ch, image: RENDER_IMAGE, ffmpeg: ff, chromium: ch, error: ff && ch ? null : "Render toolchain incomplete." };
}

/** Hands a job folder (recursively) to the container's unprivileged uid. Refuses symlinks. */
async function handOver(dir: string): Promise<void> {
  const walk = async (p: string) => {
    const st = await lstat(p);
    if (st.isSymbolicLink()) throw new RenderError("Symlink in job folder.", "failed");
    await chown(p, RENDER_UID, RENDER_UID);
    if (st.isDirectory()) for (const e of await readdir(p)) await walk(path.join(/* turbopackIgnore: true */ p, e));
  };
  await walk(dir);
}

export interface RunOptions {
  limits: RenderLimits;
  timeoutSec: number;
  onProgress?: (p: RenderProgress) => Promise<void> | void;
  /** Polled every 2 s; true = kill the container (job cancelled / Live CBT starting). */
  shouldStop?: () => Promise<"cancel" | null>;
}

/**
 * Runs one task in a fresh container and returns its result object.
 * `name` is a short task name ("probe", "render", …) — the files are
 * render/<name>.task.json, .progress.json, .result.json inside the job folder.
 */
export async function runRenderTask<T = Record<string, unknown>>(jobId: string, name: string, task: Record<string, unknown>, opts: RunOptions): Promise<T> {
  if (!JOB_ID.test(jobId) || !/^[a-z0-9-]{1,30}$/.test(name)) throw new RenderError("Invalid render task.", "failed");
  const dir = await ensureJobDir(jobId);
  await mkdir(path.join(/* turbopackIgnore: true */ dir, "render"), { recursive: true });
  const taskRel = `render/${name}.task.json`;
  const resultRel = `render/${name}.result.json`;
  const progressRel = `render/${name}.progress.json`;
  const abs = (r: string) => path.join(/* turbopackIgnore: true */ dir, r);
  await rm(abs(resultRel), { force: true });
  await rm(abs(progressRel), { force: true });
  await writeFile(abs(taskRel), JSON.stringify({ ...task, result: resultRel, progress: progressRel }));
  await handOver(dir);

  const container = `mtsvr-${jobId.slice(-12)}-${crypto.randomBytes(3).toString("hex")}`;
  const timeoutMs = opts.timeoutSec * 1000;
  let stopped: "cancel" | "timeout" | null = null;
  const run = exec(dockerArgs(container, dir, taskRel, opts.limits), timeoutMs + 30_000);
  const started = Date.now();
  let lastPct = -1;
  const poll = setInterval(async () => {
    try {
      if (opts.onProgress) {
        const raw = await readFile(abs(progressRel), "utf8").catch(() => null);
        if (raw) {
          const p = JSON.parse(raw) as RenderProgress;
          if (p.pct !== lastPct) {
            lastPct = p.pct;
            await opts.onProgress(p);
          }
        }
      }
      if (!stopped && Date.now() - started > timeoutMs) stopped = "timeout";
      if (!stopped && opts.shouldStop) stopped = await opts.shouldStop();
      if (stopped) await exec(["kill", container], 20_000);
    } catch {
      // A malformed progress file is ignored; the result decides.
    }
  }, 2000);
  const r = await run;
  clearInterval(poll);
  if (stopped === "cancel") throw new RenderError("Stopped.", "cancelled");
  if (stopped === "timeout") throw new RenderError(`The render took longer than ${Math.round(opts.timeoutSec / 60)} min and was stopped.`, "timeout");
  const raw = await readFile(abs(resultRel), "utf8").catch(() => null);
  if (!raw) {
    if (r.code === 137) throw new RenderError("The render container ran out of memory or was killed.", "failed");
    throw new RenderError(/No such image|Unable to find image/i.test(r.stderr) ? `Render image ${RENDER_IMAGE} is not built.` : `The render container failed (exit ${r.code}).`, /No such image|Unable to find image/i.test(r.stderr) ? "unavailable" : "failed");
  }
  const result = JSON.parse(raw) as { ok: boolean; error?: string } & T;
  if (!result.ok) throw new RenderError(result.error ?? "Render failed.", "failed");
  return result;
}

/** Containers left by a crashed worker (label mts.video=1) — killed by the next worker run. */
export async function killStrayContainers(): Promise<number> {
  const r = await exec(["ps", "-q", "--filter", "label=mts.video=1"], 20_000);
  const ids = r.stdout.split("\n").map((s) => s.trim()).filter((s) => /^[a-f0-9]{6,64}$/.test(s));
  for (const id of ids) await exec(["kill", id], 20_000);
  return ids.length;
}

/** The render image's id (no container started) — null when the image is missing. */
export async function renderImageId(): Promise<string | null> {
  if (!existsSync(path.resolve(/* turbopackIgnore: true */ DOCKER))) return null;
  const r = await exec(["image", "inspect", "--format", "{{.Id}}", RENDER_IMAGE], 20_000);
  const id = r.stdout.trim();
  return r.code === 0 && /^sha256:[a-f0-9]{64}$/.test(id) ? id : null;
}
