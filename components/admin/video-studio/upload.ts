"use client";

/**
 * Chunked upload of one file to a video job (≤ 8 MB parts — below the nginx
 * body limit). Each part is retried up to 3 times; the server validates the
 * assembled file by its content when the upload completes.
 */
export async function uploadToJob(jobId: string, file: File, onProgress?: (pct: number) => void): Promise<{ key: string; kind: string; name: string }> {
  const start = await fetch(`/api/admin/video-studio/jobs/${jobId}/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, size: file.size }),
  });
  const plan = (await start.json().catch(() => ({}))) as { uploadId?: string; chunkBytes?: number; chunks?: number; error?: string };
  if (!start.ok || !plan.uploadId || !plan.chunkBytes || !plan.chunks) throw new Error(plan.error ?? "Could not start the upload.");
  for (let i = 0; i < plan.chunks; i++) {
    const part = file.slice(i * plan.chunkBytes, Math.min(file.size, (i + 1) * plan.chunkBytes));
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`/api/admin/video-studio/jobs/${jobId}/uploads/${plan.uploadId}/chunks/${i}`, { method: "PUT", body: part }).catch(() => null);
      if (r?.ok) {
        lastError = "";
        break;
      }
      lastError = ((await r?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Network error";
      if (r && r.status < 500 && r.status !== 429) break;
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    }
    if (lastError) throw new Error(`Upload failed: ${lastError}`);
    onProgress?.(Math.round(((i + 1) / plan.chunks) * 100));
  }
  const done = await fetch(`/api/admin/video-studio/jobs/${jobId}/uploads/${plan.uploadId}/complete`, { method: "POST" });
  const body = (await done.json().catch(() => ({}))) as { asset?: { key: string; kind: string; name: string }; error?: string };
  if (!done.ok || !body.asset) throw new Error(body.error ?? "The file could not be processed.");
  return body.asset;
}

export function mediaUrl(jobId: string, key: string, download = false): string {
  return `/api/admin/video-studio/jobs/${jobId}/media?key=${encodeURIComponent(key)}${download ? "&download=1" : ""}`;
}
