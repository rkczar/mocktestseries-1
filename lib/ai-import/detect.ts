import "server-only";
import { open } from "node:fs/promises";
import { ACCEPTED_EXTENSIONS, REFUSED_EXTENSIONS, type AcceptedExtension } from "@/lib/ai-import/config";
import { readZipDirectory } from "@/lib/ai-import/zip-peek";

/**
 * File type is decided by CONTENT (magic bytes / container layout), never by
 * the extension alone: the extension must agree with the detected type.
 */

export type DetectedKind = "pdf" | "png" | "jpeg" | "docx" | "xlsx" | "csv";

export interface Detection {
  ok: boolean;
  kind?: DetectedKind;
  mime?: string;
  reason?: string;
}

const MIME: Record<DetectedKind, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
};

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

/** Upload-time check of the NAME (before any bytes arrive). */
export function checkFilename(name: string): { ok: true; ext: AcceptedExtension } | { ok: false; reason: string } {
  const ext = extensionOf(name);
  if (REFUSED_EXTENSIONS[ext]) return { ok: false, reason: REFUSED_EXTENSIONS[ext] };
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) return { ok: false, reason: `".${ext || "?"}" files are not supported. Upload PDF, PNG, JPG, DOCX, XLSX or CSV.` };
  if (name.length > 200 || /[\u0000-\u001f]/.test(name)) return { ok: false, reason: "The file name is too long or contains control characters." };
  return { ok: true, ext: ext as AcceptedExtension };
}

async function head(full: string, n: number): Promise<Buffer> {
  const fh = await open(full, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

const expected: Record<AcceptedExtension, DetectedKind> = { pdf: "pdf", png: "png", jpg: "jpeg", jpeg: "jpeg", docx: "docx", xlsx: "xlsx", csv: "csv" };

/** Detects the real type of an assembled upload and checks it agrees with its extension. */
export async function detectFile(full: string, ext: AcceptedExtension): Promise<Detection> {
  const h = await head(full, 4096);
  let kind: DetectedKind | null = null;
  if (h.subarray(0, 5).toString("latin1") === "%PDF-") kind = "pdf";
  else if (h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) kind = "png";
  else if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) kind = "jpeg";
  else if (h.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
    return { ok: false, reason: "This is an old binary Office file (.doc/.xls). It is refused because it can carry macros. Save it as .docx/.xlsx or PDF." };
  } else if (h.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    let names: string[];
    try {
      names = (await readZipDirectory(full)).map((e) => e.name);
    } catch (e) {
      return { ok: false, reason: `The Office file is damaged or not a valid document (${e instanceof Error ? e.message : "unreadable"}).` };
    }
    if (names.some((n) => /vbaProject\.bin$/i.test(n) || /activeX/i.test(n))) {
      return { ok: false, reason: "The document contains macros or ActiveX controls and is refused. Save a copy without macros." };
    }
    if (names.includes("word/document.xml")) kind = "docx";
    else if (names.includes("xl/workbook.xml")) kind = "xlsx";
    else return { ok: false, reason: "The ZIP container is not a Word or Excel document." };
  } else if (ext === "csv") {
    // CSV: must be text (no NUL bytes, valid UTF-8 for the sampled head).
    if (h.includes(0)) return { ok: false, reason: "The CSV file contains binary data." };
    const text = h.toString("utf8");
    if (text.includes("�") && h.length < 4096) return { ok: false, reason: "The CSV file is not UTF-8 text." };
    kind = "csv";
  }
  if (!kind) return { ok: false, reason: "The file content does not match any supported type (PDF, PNG, JPG, DOCX, XLSX, CSV)." };
  if (expected[ext] !== kind) return { ok: false, reason: `The file is named .${ext} but its content is ${kind.toUpperCase()}. Rename it correctly and upload again.` };
  return { ok: true, kind, mime: MIME[kind] };
}
