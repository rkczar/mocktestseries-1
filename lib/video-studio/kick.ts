import "server-only";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";

/**
 * Starts the video worker right away (instead of waiting for the next cron
 * minute). Same flock as the cron entry, so at most one worker ever runs; when
 * one is already running this is a no-op. A separate low-priority process —
 * never inside a web request.
 */
export function kickVideoWorker(): void {
  if (process.env.VIDEO_STUDIO_DISABLE_KICK === "1") return;
  try {
    const cwd = process.cwd();
    const script = path.join(/* turbopackIgnore: true */ cwd, "scripts", "video-worker.ts");
    const tsx = path.join(/* turbopackIgnore: true */ cwd, "node_modules", ".bin", "tsx");
    if (!existsSync(script) || !existsSync(tsx) || !existsSync(path.resolve(/* turbopackIgnore: true */ "/usr/bin/flock"))) return;
    const lock = process.env.VIDEO_WORKER_LOCK || "/run/mocktestseries-video.lock";
    const logFile = process.env.VIDEO_WORKER_LOG || "/var/log/mocktestseries/video-worker.log";
    const out = existsSync(path.dirname(/* turbopackIgnore: true */ logFile)) ? openSync(path.resolve(/* turbopackIgnore: true */ logFile), "a", 0o640) : "ignore";
    const child = spawn("/usr/bin/flock", ["-n", lock, "/usr/bin/nice", "-n", "10", tsx, script], {
      cwd,
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" },
    });
    child.unref();
    if (typeof out === "number") closeSync(out);
  } catch {
    // The cron entry picks the job up within a minute.
  }
}
