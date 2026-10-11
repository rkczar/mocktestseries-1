import "server-only";
import sharp, { type OutputInfo } from "sharp";
import { assertAiGenerationOpen } from "@/lib/ai-provider";
import { getGeminiApiKey, getGeminiConfig } from "@/lib/gemini-config";
import { mediaStorage, sha256Hex, storageKeyFor } from "@/lib/media-storage";
import { StudioError } from "@/lib/instagram/posts";
import {
  IMAGE_PROMPT_VERSION,
  buildImagePrompt,
  defaultImageTitle,
  defaultMemoryTip,
  parseCommonsPages,
  pickImageModel,
  isCommonsUploadUrl,
  type ReferenceImageResult,
} from "@/lib/instagram/medical-image-core";
import type { MedicalImage, MedicalImageSource, PostContent, SourceSnapshot } from "@/lib/instagram/types";

/**
 * Optional Medical Image slide — server side. Generates an original image with
 * a configured Gemini image model, or imports a free-licence reference image
 * from Wikimedia Commons. Only ever runs when the admin clicks; the result is
 * stored once in the existing content-addressed media store (lib/media-storage.ts,
 * served at /media/) and cached on the post as `imageCandidate`, so a page
 * load never regenerates anything. Nothing here touches the Question Bank.
 */

const GEMINI_TIMEOUT_MS = 90_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const MAX_EDGE = 1600;
const COMMONS_UA = "MockTestSeries.in Instagram Studio (https://mocktestseries.in; admin reference-image search)";

/** Loopback-only overrides for the test suites (production always calls the real hosts). */
function testBase(name: string): string | null {
  const raw = process.env[name] ?? "";
  return /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(raw) ? raw : null;
}

/** Re-encodes (strips metadata, bounds size) and stores the bytes; returns the media key + size. */
async function storeImage(bytes: Buffer): Promise<{ key: string; width: number; height: number }> {
  let out: { data: Buffer; info: OutputInfo };
  try {
    out = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new StudioError("The image file could not be read. Nothing was changed.");
  }
  const key = storageKeyFor(sha256Hex(out.data), "jpg");
  await mediaStorage().put(key, out.data);
  return { key, width: out.info.width, height: out.info.height };
}

function candidate(stored: { key: string; width: number; height: number }, snapshot: SourceSnapshot, content: PostContent, source: MedicalImageSource): MedicalImage {
  // Keep the admin's edited title / tip when an image is regenerated.
  const prev = content.imageCandidate ?? content.medicalImage;
  return {
    ...stored,
    title: prev?.title.trim() || defaultImageTitle(snapshot, content),
    memoryTip: prev?.memoryTip.trim() || defaultMemoryTip(content),
    source,
  };
}

/** Is an image generation provider usable? (For the editor: shown before the admin clicks.) */
export async function imageGenerationStatus(): Promise<{ available: boolean; model: string | null; message: string }> {
  const config = await getGeminiConfig();
  if (!config.configured || !config.enabled) {
    return { available: false, model: null, message: "No image generation provider is configured. Add and enable a Google Gemini API key in Admin → AI Solutions → AI Providers." };
  }
  const model = pickImageModel(config.availableModels.map((m) => m.id));
  if (!model) {
    return { available: false, model: null, message: "The Gemini key has no image model listed. Click Refresh Available Models in AI Providers; image generation needs a Gemini image model." };
  }
  return { available: true, model, message: `Google Gemini · ${model}` };
}

export async function generateMedicalImage(params: { snapshot: SourceSnapshot; content: PostContent; instruction?: string }): Promise<{ image: MedicalImage; summary: string }> {
  await assertAiGenerationOpen();
  const status = await imageGenerationStatus();
  const apiKey = await getGeminiApiKey();
  if (!status.available || !status.model || !apiKey) throw new StudioError(`${status.message} No image was generated.`);
  const model = status.model;

  const title = defaultImageTitle(params.snapshot, params.content);
  const prompt = buildImagePrompt({ snapshot: params.snapshot, title: params.content.imageCandidate?.title || params.content.medicalImage?.title || title, instruction: params.instruction });
  const base = testBase("GEMINI_TEST_BASE_URL") ?? "https://generativelanguage.googleapis.com";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "4:3" } },
      }),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    throw new StudioError(timedOut ? "Image generation timed out. Nothing was changed — try again." : "Could not reach Google Gemini. Nothing was changed.");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const msg = (body.error?.message ?? "").replace(/AIza[0-9A-Za-z_-]{20,}/g, "[key]").slice(0, 160);
    throw new StudioError(`Gemini image generation failed (${res.status})${msg ? `: ${msg}` : "."} Nothing was changed.`);
  }
  const data = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] }; finishReason?: string }[] };
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data && /^image\/(png|jpeg|webp)$/.test(p.inlineData.mimeType ?? ""));
  if (!part?.inlineData?.data) {
    const reason = data.candidates?.[0]?.finishReason;
    throw new StudioError(`Gemini returned no image${reason ? ` (${reason})` : ""}. Nothing was changed — try again or add an instruction.`);
  }
  const stored = await storeImage(Buffer.from(part.inlineData.data, "base64"));
  const image = candidate(stored, params.snapshot, params.content, { kind: "ai", provider: "gemini", model, promptVersion: IMAGE_PROMPT_VERSION, createdAt: new Date().toISOString() });
  return { image, summary: "Medical image generated. Check the preview, then Add to Carousel or Skip." };
}

// ---- Wikimedia Commons ---------------------------------------------------------------------

async function commonsQuery(params: Record<string, string>): Promise<unknown> {
  const base = testBase("WIKIMEDIA_TEST_BASE_URL") ?? "https://commons.wikimedia.org";
  const url = new URL(`${base}/w/api.php`);
  const all: Record<string, string> = {
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "imageinfo",
    iiprop: "url|mime|size|extmetadata",
    iiurlwidth: "1200",
    iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist",
    ...params,
  };
  for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": COMMONS_UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new StudioError("Could not reach Wikimedia Commons. Try again.");
  }
  if (!res.ok) throw new StudioError(`Wikimedia Commons answered ${res.status}. Try again later.`);
  const json = (await res.json().catch(() => null)) as { query?: { pages?: unknown } } | null;
  return json?.query?.pages ?? [];
}

/** Free-licence (public domain / CC0 / CC BY / CC BY-SA) JPEG/PNG files only. */
export async function searchReferenceImages(query: string): Promise<ReferenceImageResult[]> {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 100);
  if (q.length < 3) throw new StudioError("Type at least 3 characters to search.");
  const pages = await commonsQuery({ generator: "search", gsrsearch: `${q} filetype:bitmap`, gsrnamespace: "6", gsrlimit: "20" });
  return parseCommonsPages(pages)
    .slice(0, 12)
    .map((r) => ({ fileTitle: r.fileTitle, thumbUrl: r.thumbUrl, pageUrl: r.pageUrl, author: r.author, license: r.license, licenseUrl: r.licenseUrl, width: r.width, height: r.height }));
}

/** Re-reads the file's licence from Commons (never trusts the browser), downloads it and stores it as the candidate. */
export async function importReferenceImage(params: { snapshot: SourceSnapshot; content: PostContent; fileTitle: string }): Promise<{ image: MedicalImage; summary: string }> {
  const title = params.fileTitle.trim();
  if (!/^File:[^|#<>[\]{}]{1,240}$/.test(title)) throw new StudioError("Invalid reference image.");
  const [found] = parseCommonsPages(await commonsQuery({ titles: title }));
  if (!found) throw new StudioError("That image is not available under a free licence (public domain, CC0, CC BY or CC BY-SA). Choose another one.");
  if (!isCommonsUploadUrl(found.downloadUrl)) throw new StudioError("Invalid reference image source.");
  let res: Response;
  try {
    // Tests only: the loopback Commons mock also serves the file bytes.
    const testHost = testBase("WIKIMEDIA_TEST_BASE_URL");
    const downloadUrl = testHost ? found.downloadUrl.replace("https://upload.wikimedia.org", testHost) : found.downloadUrl;
    res = await fetch(downloadUrl, { headers: { "user-agent": COMMONS_UA }, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new StudioError("Could not download the image from Wikimedia Commons. Try again.");
  }
  if (!res.ok) throw new StudioError(`Wikimedia Commons answered ${res.status} for the image.`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new StudioError("The image file is too large.");
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new StudioError("The image file is too large.");
  const stored = await storeImage(bytes);
  const image = candidate(stored, params.snapshot, params.content, {
    kind: "reference",
    provider: "wikimedia",
    pageUrl: found.pageUrl,
    author: found.author,
    license: found.license,
    ...(found.licenseUrl ? { licenseUrl: found.licenseUrl } : {}),
    createdAt: new Date().toISOString(),
  });
  return { image, summary: `Reference image ready (${found.license}, ${found.author}). The credit line is printed on the slide. Check the preview, then Add to Carousel or Skip.` };
}
