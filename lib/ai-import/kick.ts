import "server-only";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import path from "node:path";

/**
 * Starts the importer worker right away (instead of waiting for the next
 * cron minute). It runs under the same `flock` as the cron entry, so at most
 * one worker ever runs; when one is already running this is a no-op. The
 * worker is a separate, low-priority process — never inside a web request.
 */
export function kickWorker(): void {
  if (process.env.AI_IMPORT_DISABLE_KICK === "1") return;
  try {
    const cwd = process.cwd();
    const script = path.join(cwd, "scripts", "ai-import-worker.ts");
    const tsx = path.join(cwd, "node_modules", ".bin", "tsx");
    if (!existsSync(script) || !existsSync(tsx) || !existsSync("/usr/bin/flock")) return;
    const lock = process.env.AI_IMPORT_LOCK || "/run/mocktestseries-ai-import.lock";
    const logFile = process.env.AI_IMPORT_LOG || "/var/log/mocktestseries/ai-import-worker.log";
    const out = existsSync(path.dirname(logFile)) ? openSync(logFile, "a", 0o640) : "ignore";
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
