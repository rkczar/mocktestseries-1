import "server-only";
import { createReadStream } from "node:fs";
import { NextResponse } from "next/server";

/**
 * Bounded-memory file → Web stream for downloads (64 KiB chunks, pull-based
 * so a slow client applies backpressure). `onComplete` fires only after the
 * last byte was handed to the client; a client disconnect cancels instead.
 * It only RECORDS the download — the file is never deleted here (a browser
 * can still lose the tail after the server sent it), so every download is
 * repeatable and an interrupted one can be resumed with a Range request.
 */
export function fileDownloadStream(file: string, onComplete?: () => Promise<void> | void, range?: ByteRange): ReadableStream<Uint8Array> {
  const rs = createReadStream(file, { highWaterMark: 64 * 1024, ...(range ? { start: range.start, end: range.end } : {}) });
  const iter = rs[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iter.next();
        if (done) {
          controller.close();
          await onComplete?.();
          return;
        }
        controller.enqueue(new Uint8Array(value as Buffer));
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      rs.destroy();
    },
  });
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * One "bytes=a-b", "bytes=a-" or "bytes=-n" range (what browsers and download managers send to resume).
 * null = serve the whole file; "invalid" = 416. Multi-range requests are answered with the whole file.
 */
export function parseRange(header: string | null, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return "invalid";
  return { start, end };
}

export function downloadHeaders(fileName: string, size: number, range?: ByteRange | null, etag?: string): HeadersInit {
  return {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    "Content-Length": String(range ? range.end - range.start + 1 : size),
    ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
    "Accept-Ranges": "bytes",
    ...(etag ? { ETag: `"${etag}"` } : {}),
    "Cache-Control": "private, no-store",
    // Stream straight through nginx instead of spooling multi-GB files to its temp dir.
    "X-Accel-Buffering": "no",
  };
}

/**
 * Full (200) or resumed (206) download of an integrity-checked file. `sha256` is the verified hash, sent as the
 * ETag so a resume (If-Range) only ever continues the same bytes. `onComplete` runs when the final byte was sent.
 */
export function downloadResponse(req: Request, file: string, fileName: string, size: number, sha256: string | null, onComplete?: () => Promise<void> | void): NextResponse {
  const ifRange = req.headers.get("if-range");
  const rangeAllowed = !ifRange || (sha256 !== null && ifRange.replace(/^W\//, "") === `"${sha256}"`);
  const range = rangeAllowed ? parseRange(req.headers.get("range"), size) : null;
  if (range === "invalid") return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" } });
  const reachesEnd = !range || range.end === size - 1;
  return new NextResponse(fileDownloadStream(file, reachesEnd ? onComplete : undefined, range ?? undefined), {
    status: range ? 206 : 200,
    headers: downloadHeaders(fileName, size, range, sha256 ?? undefined),
  });
}
