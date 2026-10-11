import { plainText } from "@/lib/instagram/layout";
import { MEDICAL_IMAGE_LIMITS, type PostContent, type SourceSnapshot } from "@/lib/instagram/types";

/**
 * Optional Medical Image slide — pure helpers (prompt, defaults, licence rules).
 * The image never carries text: the title and memory tip are drawn by the
 * slide renderer from the post's existing (reviewed) content, so an image
 * model can never invent anatomy labels or clinical findings on a slide.
 */

export const IMAGE_PROMPT_VERSION = "ig-image-v1";

/** Gemini image models, best first; the first one this API key lists (AI Providers → Refresh models) is used. */
export const GEMINI_IMAGE_MODELS = ["gemini-3.1-flash-image", "gemini-2.5-flash-image", "gemini-3-pro-image", "gemini-3.1-flash-image-preview"] as const;

export function pickImageModel(available: readonly string[]): string | null {
  return GEMINI_IMAGE_MODELS.find((m) => available.includes(m)) ?? null;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Default slide title: the diagram title, else topic, else subject (all existing metadata). */
export function defaultImageTitle(snapshot: SourceSnapshot, content: Pick<PostContent, "diagram">): string {
  const t = content.diagram?.title?.trim() || snapshot.topicName?.trim() || snapshot.subjectName.trim();
  return cut(t, MEDICAL_IMAGE_LIMITS.title);
}

/** Default memory tip: the post's existing Memory Trick (already reviewed text, never new AI text). */
export function defaultMemoryTip(content: Pick<PostContent, "memoryTrick">): string {
  return cut(content.memoryTrick.trim(), MEDICAL_IMAGE_LIMITS.memoryTip);
}

/** A short prompt built only from the question's metadata — no conversation history, no large context. */
export function buildImagePrompt(params: { snapshot: SourceSnapshot; title: string; instruction?: string }): string {
  const s = params.snapshot;
  const answer = s.options
    .filter((o) => o.isCorrect)
    .map((o) => plainText(o.text))
    .join("; ");
  return [
    "Create one original educational medical illustration for a medical exam revision slide (Instagram, landscape 4:3).",
    `Concept: ${params.title}. Subject: ${s.subjectName}${s.topicName ? ` / ${s.topicName}` : ""}.`,
    `Context only (do not write it in the image): ${cut(plainText(s.text), 240)} Answer: ${cut(answer, 120)}.`,
    "Style: clean flat textbook-style diagram, white or very light background, clear shapes and colours, anatomically and physiologically correct, schematic rather than photographic, no gore, no real patient faces.",
    "Strictly no text of any kind in the image: no words, letters, numbers, labels, arrows with text, captions, watermarks or logos.",
    params.instruction ? `Admin instruction: ${params.instruction.trim().slice(0, 300)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- Wikimedia Commons reference images (free licences only) ---------------------------------

/** Licences that allow reuse on a commercial social account with attribution. NC / ND / fair use are refused. */
export function licenseAllowed(shortName: string): boolean {
  const l = shortName.trim().toLowerCase();
  if (!l || /\bnc\b|non-?commercial|\bnd\b|no-?deriv|fair use/.test(l)) return false;
  return /^(public domain|pd\b|pd-|cc0|cc[- ]by(-sa)?\b)/.test(l);
}

export function stripHtml(s: string): string {
  return plainText(s).slice(0, 120);
}

export interface ReferenceImageResult {
  /** Commons file title ("File:….png") — the only thing the client sends back. */
  fileTitle: string;
  thumbUrl: string;
  pageUrl: string;
  author: string;
  license: string;
  licenseUrl: string;
  width: number;
  height: number;
}

interface CommonsPage {
  title?: string;
  imageinfo?: {
    thumburl?: string;
    url?: string;
    descriptionurl?: string;
    mime?: string;
    width?: number;
    height?: number;
    extmetadata?: Record<string, { value?: string } | undefined>;
  }[];
}

/** Parses a Commons API `query.pages` answer into allowed (free-licence, JPEG/PNG) results. */
export function parseCommonsPages(pages: unknown): (ReferenceImageResult & { downloadUrl: string })[] {
  if (!Array.isArray(pages)) return [];
  const out: (ReferenceImageResult & { downloadUrl: string })[] = [];
  for (const p of pages as CommonsPage[]) {
    const ii = p.imageinfo?.[0];
    if (!p.title || !ii?.descriptionurl || !(ii.thumburl || ii.url)) continue;
    if (ii.mime !== "image/jpeg" && ii.mime !== "image/png") continue;
    const meta = ii.extmetadata ?? {};
    const license = stripHtml(meta.LicenseShortName?.value ?? "");
    if (!licenseAllowed(license)) continue;
    const downloadUrl = ii.thumburl || ii.url!;
    if (!isCommonsUploadUrl(downloadUrl) || !ii.descriptionurl.startsWith("https://commons.wikimedia.org/")) continue;
    out.push({
      fileTitle: p.title,
      thumbUrl: downloadUrl.replace(/\/\d+px-/, "/320px-"),
      downloadUrl,
      pageUrl: ii.descriptionurl,
      author: stripHtml(meta.Artist?.value ?? "") || "Unknown author",
      license,
      licenseUrl: (meta.LicenseUrl?.value ?? "").slice(0, 200),
      width: ii.width ?? 0,
      height: ii.height ?? 0,
    });
  }
  return out;
}

export function isCommonsUploadUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "upload.wikimedia.org";
  } catch {
    return false;
  }
}
