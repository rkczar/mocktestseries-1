import "server-only";
import { createReadStream } from "node:fs";

/**
 * Bounded-memory file → Web stream for downloads (64 KiB chunks, pull-based
 * so a slow client applies backpressure). `onComplete` fires only after the
 * last byte was handed to the client; a client disconnect cancels instead.
 */
export function fileDownloadStream(file: string, onComplete?: () => Promise<void> | void): ReadableStream<Uint8Array> {
  const rs = createReadStream(file, { highWaterMark: 64 * 1024 });
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

export function downloadHeaders(fileName: string, size: number): HeadersInit {
  return {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    "Content-Length": String(size),
    "Cache-Control": "private, no-store",
    // Stream straight through nginx instead of spooling multi-GB files to its temp dir.
    "X-Accel-Buffering": "no",
  };
}
