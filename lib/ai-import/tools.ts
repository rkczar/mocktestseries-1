import "server-only";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Runs a local document tool (poppler, optional tesseract) as a bounded child
 * process: fixed binary path (no shell), argument array, low CPU priority,
 * an address-space limit, a wall-clock timeout and an output cap. A document
 * can never make the server run anything else.
 */

const BINARIES = {
  pdfinfo: "/usr/bin/pdfinfo",
  pdftotext: "/usr/bin/pdftotext",
  pdftoppm: "/usr/bin/pdftoppm",
  pdftohtml: "/usr/bin/pdftohtml",
  pdfimages: "/usr/bin/pdfimages",
  tesseract: "/usr/bin/tesseract",
} as const;
export type ToolName = keyof typeof BINARIES;

export class ToolError extends Error {
  constructor(
    message: string,
    readonly kind: "missing" | "timeout" | "failed" | "too_large"
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function toolAvailable(tool: ToolName): boolean {
  return existsSync(path.resolve(/* turbopackIgnore: true */ BINARIES[tool]));
}

export interface RunOptions {
  timeoutMs?: number;
  /** Max stdout bytes kept (default 32 MB). */
  maxOutput?: number;
  /** Address-space limit in MB (default 1024). */
  memoryMb?: number;
  cwd?: string;
}

export async function runTool(tool: ToolName, args: string[], opts: RunOptions = {}): Promise<Buffer> {
  const bin = BINARIES[tool];
  if (!existsSync(path.resolve(/* turbopackIgnore: true */ bin))) throw new ToolError(`${tool} is not installed on this server.`, "missing");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxOutput = opts.maxOutput ?? 32 * 1024 * 1024;
  const memKb = (opts.memoryMb ?? 1024) * 1024;
  // `nice` lowers CPU priority; `ulimit -v` caps memory. The tool path and
  // arguments are passed as positional parameters, never interpolated.
  const script = `ulimit -v ${memKb}; exec nice -n 10 "$0" "$@"`;
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", script, bin, ...args], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } as unknown as NodeJS.ProcessEnv });
    const chunks: Buffer[] = [];
    let size = 0;
    let killedFor: "timeout" | "too_large" | null = null;
    const timer = setTimeout(() => {
      killedFor = "timeout";
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxOutput) {
        killedFor = "too_large";
        child.kill("SIGKILL");
        return;
      }
      chunks.push(c);
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 2000) stderr += c.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ToolError(`${tool} could not start: ${e.message}`, "failed"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killedFor === "timeout") return reject(new ToolError(`${tool} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`, "timeout"));
      if (killedFor === "too_large") return reject(new ToolError(`${tool} produced too much output and was stopped.`, "too_large"));
      if (code !== 0) return reject(new ToolError(`${tool} failed (exit ${code}): ${stderr.replace(/\/[^\s:]+/g, "<path>").slice(0, 300)}`, "failed"));
      resolve(Buffer.concat(chunks));
    });
  });
}
