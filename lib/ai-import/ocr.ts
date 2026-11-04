import "server-only";
import { runTool, toolAvailable, ToolError } from "@/lib/ai-import/tools";
import type { OcrPage } from "@/lib/ai-import/ocr-layout";

/**
 * Local OCR of one page (ops/ocr/rapidocr_page.py, RapidOCR on ONNX Runtime) — no AI, no network, no cost.
 * The original file is only read. Turned off with AI_IMPORT_OCR=off, or when the OCR environment is not installed.
 */

/** Render resolution for OCR; low-confidence lines are read again at 400 dpi by the script. */
export const OCR_DPI = 200;

export function ocrAvailable(): boolean {
  return process.env.AI_IMPORT_OCR !== "off" && toolAvailable("ocr");
}

function parse(out: Buffer): OcrPage {
  let v: unknown;
  try {
    v = JSON.parse(out.toString("utf8"));
  } catch {
    throw new ToolError("The OCR result could not be read.", "failed");
  }
  const o = v as Partial<OcrPage> & { error?: string };
  if (o.error) throw new ToolError(`OCR failed: ${String(o.error).slice(0, 200)}`, "failed");
  if (!o || typeof o.width !== "number" || typeof o.height !== "number" || !Array.isArray(o.lines)) throw new ToolError("The OCR result is incomplete.", "failed");
  const lines = o.lines.filter((l) => l && typeof l.text === "string" && typeof l.score === "number" && Array.isArray(l.box) && l.box.length === 4);
  return { engine: String(o.engine ?? "rapidocr"), width: o.width, height: o.height, dpi: o.dpi ?? null, ink: typeof o.ink === "number" ? o.ink : 0, rereads: o.rereads ?? 0, seconds: o.seconds ?? 0, lines };
}

const LIMITS = { timeoutMs: 240_000, memoryMb: 2048, maxOutput: 16 * 1024 * 1024 };

export async function ocrPdfPage(file: string, page: number): Promise<OcrPage> {
  return parse(await runTool("ocr", ["--pdf", file, "--page", String(page), "--dpi", String(OCR_DPI)], LIMITS));
}

export async function ocrImageFile(file: string): Promise<OcrPage> {
  return parse(await runTool("ocr", ["--image", file], LIMITS));
}
