import { ACCEPTED_EXTENSIONS, CHUNK_BYTES, REFUSED_EXTENSIONS } from "@/lib/ai-import/config";

/**
 * Browser side of the importer uploads (question paper, answer key, reference paper). Every file goes up in
 * CHUNK_BYTES parts, so no request comes near nginx's 20 MB limit. Errors name the stage they happened in and
 * never fall back to a bare "refused": a non-JSON reply (nginx's own HTML error page) is explained by its status.
 */

export type UploadStage = "validation" | "upload" | "reading" | "analysis";
export const STAGE_LABEL: Record<UploadStage, string> = { validation: "Validation", upload: "Upload", reading: "File check", analysis: "Analysis" };
export const SUPPORTED_LABEL = "PDF, Word (.docx), JPG, PNG, Excel (.xlsx) or CSV";
export const ACCEPT = ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(",");

export type UploadResult = { ok: true; note: string } | { ok: false; error: string; stage: UploadStage; aborted?: boolean };

/** Checks a chosen file before anything is sent (the server repeats every check on the content). */
export function checkLocalFile(file: File, maxFileMb: number): string | null {
  const ext = /\.([A-Za-z0-9]{1,6})$/.exec(file.name.trim())?.[1]?.toLowerCase() ?? "";
  if (REFUSED_EXTENSIONS[ext]) return REFUSED_EXTENSIONS[ext];
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) return `".${ext || "?"}" files are not supported. Supported: ${SUPPORTED_LABEL}.`;
  if (!file.size) return "The file is empty.";
  if (file.size > maxFileMb * 1024 * 1024) return `The file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${maxFileMb} MB per file.`;
  return null;
}

/** A readable reason for a failed response, also when the body is not the app's JSON. */
export async function responseError(r: Response, fallbackStage: UploadStage): Promise<{ error: string; stage: UploadStage }> {
  const d = (await r.json().catch(() => null)) as { error?: string; reason?: string; stage?: UploadStage } | null;
  const stage = d?.stage ?? fallbackStage;
  if (d?.reason || d?.error) return { error: (d.reason ?? d.error)!, stage };
  if (r.status === 413) return { error: "The web server refused the request as too large (over its 20 MB request limit). Reload the page and try again — files are sent in parts.", stage };
  if (r.status === 401 || r.status === 403 || r.redirected) return { error: "Your admin session has expired. Sign in again in another tab, then retry.", stage };
  if (r.status === 502 || r.status === 503 || r.status === 504) return { error: `The server is unreachable or restarting (HTTP ${r.status}). Wait a moment, then retry.`, stage };
  return { error: `The server answered HTTP ${r.status} without a reason. Retry; if it repeats, check the server log.`, stage };
}

function aborted(e: unknown) {
  return e instanceof DOMException && e.name === "AbortError";
}

/** Sends `file` in parts to `chunkUrl(i)` with up to 3 tries per part; reports 0–95 %. */
async function sendParts(file: File, chunks: number, chunkUrl: (i: number) => string, onPct: (pct: number) => void, signal?: AbortSignal): Promise<UploadResult | null> {
  for (let c = 0; c < chunks; c++) {
    const blob = file.slice(c * CHUNK_BYTES, Math.min(file.size, (c + 1) * CHUNK_BYTES));
    let last: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await fetch(chunkUrl(c), { method: "PUT", body: blob, signal }).catch((e) => {
        if (aborted(e)) throw e;
        return null;
      });
      if (last?.ok) break;
      if (last && last.status < 500) return { ok: false, ...(await responseError(last, "upload")) };
    }
    if (!last?.ok) return { ok: false, error: `Part ${c + 1} of ${chunks} could not be uploaded after 3 tries. Check the connection and retry.`, stage: "upload" };
    onPct(Math.round(((c + 1) / Math.max(1, chunks)) * 95));
  }
  return null;
}

async function guard(run: () => Promise<UploadResult>): Promise<UploadResult> {
  try {
    return await run();
  } catch (e) {
    if (aborted(e)) return { ok: false, error: "Upload cancelled.", stage: "upload", aborted: true };
    return { ok: false, error: "The server could not be reached. Check the connection and retry.", stage: "upload" };
  }
}

/** Question paper or answer key: the importer's file API (stored as a file of the job). */
export function uploadJobFile(jobId: string, file: File, role: "PAPER" | "ANSWER_KEY", onPct: (pct: number) => void, signal?: AbortSignal): Promise<UploadResult> {
  return guard(async () => {
    const start = await fetch("/api/admin/ai-importer/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId, name: file.name, size: file.size, role, paperFileId: null }), signal });
    if (!start.ok) return { ok: false, ...(await responseError(start, "validation")) };
    const s = (await start.json()) as { fileId: string; chunks: number };
    const failed = await sendParts(file, s.chunks, (c) => `/api/admin/ai-importer/files/${s.fileId}/chunks/${c}`, onPct, signal);
    if (failed) return failed;
    const done = await fetch(`/api/admin/ai-importer/files/${s.fileId}/complete`, { method: "POST", signal });
    const d = (await done.clone().json().catch(() => ({}))) as { ok?: boolean; kind?: string; pageCount?: number; reason?: string };
    if (!done.ok || !d.ok) return { ok: false, ...(await responseError(done, "reading")) };
    onPct(100);
    return { ok: true, note: `${String(d.kind).toUpperCase()}${d.pageCount ? ` · ${d.pageCount} page(s)` : ""}` };
  });
}

/** Reference paper: chunked like the paper, then read locally on the server (never sent to AI). */
export function uploadReferenceFile(jobId: string, file: File, onPct: (pct: number) => void, signal?: AbortSignal): Promise<UploadResult> {
  return guard(async () => {
    const start = await fetch("/api/admin/ai-importer/references/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId, name: file.name, size: file.size }), signal });
    if (!start.ok) return { ok: false, ...(await responseError(start, "validation")) };
    const s = (await start.json()) as { uploadId: string; chunks: number };
    try {
      const failed = await sendParts(file, s.chunks, (c) => `/api/admin/ai-importer/references/uploads/${s.uploadId}/chunks/${c}`, onPct, signal);
      if (failed) return failed;
    } catch (e) {
      // Cancelled: drop the parts already on the server (best effort).
      void fetch(`/api/admin/ai-importer/references/uploads/${s.uploadId}`, { method: "DELETE" }).catch(() => undefined);
      throw e;
    }
    const done = await fetch(`/api/admin/ai-importer/references/uploads/${s.uploadId}/complete`, { method: "POST", signal });
    if (!done.ok) return { ok: false, ...(await responseError(done, "reading")) };
    const d = (await done.json()) as { kind: string; pageCount: number | null; questions: number; key: number; note: string | null };
    onPct(100);
    return { ok: true, note: `${d.kind.toUpperCase()}${d.pageCount ? ` · ${d.pageCount} page(s)` : ""} · ${d.questions} question(s)${d.key ? `, ${d.key} answer-key entries` : ""} read${d.note ? ` — ${d.note}` : ""}` };
  });
}
