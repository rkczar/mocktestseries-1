import "server-only";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { runTool, ToolError } from "@/lib/ai-import/tools";

/**
 * Local PDF reading with poppler (no AI, no network): page count, per-page
 * text lines WITH positions, embedded images WITH positions and their exact
 * pixels, and page renders. All boxes are normalized to 0..1 of the page.
 */

export interface PdfInfo {
  pages: number;
  encrypted: boolean;
  javascript: boolean;
  widthPt: number | null;
  heightPt: number | null;
}

export async function pdfInfo(file: string): Promise<PdfInfo> {
  const out = (await runTool("pdfinfo", [file], { timeoutMs: 30_000, maxOutput: 1024 * 1024 })).toString("utf8");
  const get = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(out)?.[1]?.trim() ?? "";
  const size = /([\d.]+) x ([\d.]+) pts/.exec(get("Page size"));
  return {
    pages: Number.parseInt(get("Pages"), 10) || 0,
    encrypted: /^yes/i.test(get("Encrypted")),
    javascript: /^yes/i.test(get("JavaScript")),
    widthPt: size ? Number(size[1]) : null,
    heightPt: size ? Number(size[2]) : null,
  };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextLine {
  text: string;
  box: Box;
}

export interface PageImage {
  box: Box;
  bytes: Buffer;
  ext: "png" | "jpg";
}

export interface PageLayout {
  width: number;
  height: number;
  lines: TextLine[];
  images: PageImage[];
}

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const attr = (tag: string, name: string) => Number(new RegExp(`\\b${name}="(-?[\\d.]+)"`).exec(tag)?.[1] ?? NaN);

/**
 * Text lines and embedded images of ONE page (pdftohtml -xml). `work` is a
 * private scratch directory; it is emptied afterwards.
 */
export async function pageLayout(file: string, page: number, work: string): Promise<PageLayout> {
  const dir = path.join(work, `layout-${page}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await runTool("pdftohtml", ["-xml", "-q", "-f", String(page), "-l", String(page), "-zoom", "1.5", "-fmt", "png", file, path.join(dir, "p")], { timeoutMs: 60_000, maxOutput: 1024 * 1024 });
    const xml = await readFile(path.join(dir, "p.xml"), "utf8");
    const pageTag = /<page [^>]*>/.exec(xml)?.[0] ?? "";
    const width = attr(pageTag, "width");
    const height = attr(pageTag, "height");
    if (!(width > 0 && height > 0)) throw new ToolError("Could not read the page layout.", "failed");
    const norm = (tag: string): Box => ({ x: attr(tag, "left") / width, y: attr(tag, "top") / height, w: attr(tag, "width") / width, h: attr(tag, "height") / height });
    const lines: TextLine[] = [];
    for (const m of xml.matchAll(/<text ([^>]*)>([\s\S]*?)<\/text>/g)) {
      const text = decode(m[2]).replace(/\s+/g, " ").trim();
      if (text) lines.push({ text, box: norm(m[1]) });
    }
    const images: PageImage[] = [];
    const files = new Set(await readdir(dir));
    for (const m of xml.matchAll(/<image ([^>]*)\/?>/g)) {
      const src = /src="([^"]+)"/.exec(m[1])?.[1];
      const base = src ? path.basename(src) : null;
      if (!base || !files.has(base) || !/^p-\d+_\d+\.(png|jpg)$/.test(base)) continue;
      const box = norm(m[1]);
      if (!(box.w > 0.01 && box.h > 0.01)) continue; // hairlines, rules, invisible masks
      images.push({ box, bytes: await readFile(path.join(dir, base)), ext: base.endsWith(".jpg") ? "jpg" : "png" });
    }
    return { width, height, lines, images };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Plain text of one page in reading layout (pdftotext -layout). */
export async function pageText(file: string, page: number): Promise<string> {
  return (await runTool("pdftotext", ["-layout", "-enc", "UTF-8", "-f", String(page), "-l", String(page), file, "-"], { timeoutMs: 60_000, maxOutput: 4 * 1024 * 1024 })).toString("utf8");
}

/** Number of embedded raster images per page (pdfimages -list), for the analysis report. */
export async function imagesPerPage(file: string, maxPages: number): Promise<Map<number, number>> {
  const out = (await runTool("pdfimages", ["-list", "-l", String(maxPages), file], { timeoutMs: 60_000, maxOutput: 8 * 1024 * 1024 })).toString("utf8");
  const counts = new Map<number, number>();
  for (const line of out.split("\n").slice(2)) {
    const m = /^\s*(\d+)\s+\d+\s+(image|mask|smask|stencil)\s+(\d+)\s+(\d+)/.exec(line);
    if (!m || m[2] !== "image") continue;
    if (Number(m[3]) < 16 || Number(m[4]) < 16) continue;
    counts.set(Number(m[1]), (counts.get(Number(m[1])) ?? 0) + 1);
  }
  return counts;
}

/**
 * Renders one page to PNG. The long side is fixed from `dpi` for an A4/Letter
 * page (150 dpi ≈ 1750 px) so an oversized page can never exhaust memory.
 */
export async function renderPage(file: string, page: number, dpi: number): Promise<Buffer> {
  const longSide = Math.min(2600, Math.max(1200, Math.round(dpi * 11.7)));
  return runTool("pdftoppm", ["-png", "-scale-to", String(longSide), "-f", String(page), "-l", String(page), "-singlefile", file], {
    timeoutMs: 90_000,
    maxOutput: 64 * 1024 * 1024,
    memoryMb: 1536,
  });
}
