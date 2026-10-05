/**
 * Synthetic scientific test images for the Phase 2 media suites — drawn here
 * as SVG and rasterized by sharp, so no real exam material is used. All are
 * black line art on a TRANSPARENT background with small labels (the case that
 * breaks in dark mode and under lossy compression).
 */
import sharp from "sharp";
import { crc32 } from "node:zlib";

const svg = (w: number, h: number, body: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g fill="none" stroke="#000" stroke-width="2" font-family="DejaVu Sans, sans-serif" font-size="14">${body}</g></svg>`
  );
const text = (x: number, y: number, s: string, size = 14) => `<text x="${x}" y="${y}" fill="#000" stroke="none" font-size="${size}">${s}</text>`;

const DRAWINGS = {
  circuit: () =>
    svg(
      640,
      360,
      `<path d="M80 80 H560 V280 H80 Z"/>
       <path d="M80 160 V200"/><path d="M68 170 H92"/><path d="M74 186 H86" stroke-width="4"/>${text(20, 185, "12 V")}
       <rect x="200" y="68" width="90" height="24" fill="#fff"/>${text(230, 60, "R1 = 4 Ω")}
       <path d="M400 80 V120"/><path d="M360 120 H440"/><path d="M360 120 V240"/><path d="M440 120 V240"/><path d="M360 240 H440"/><path d="M400 240 V280"/>
       <rect x="348" y="150" width="24" height="60" fill="#fff"/>${text(300, 185, "R2 = 6 Ω")}
       <rect x="428" y="150" width="24" height="60" fill="#fff"/>${text(458, 185, "R3 = 3 Ω")}
       ${text(470, 105, "I")}<path d="M490 100 l12 0 l-6 -5 M502 100 l-6 5"/>`
    ),
  graph: () =>
    svg(
      640,
      400,
      `<path d="M70 340 H600 M70 340 V30"/><path d="M600 340 l-10 -5 M600 340 l-10 5 M70 30 l-5 10 M70 30 l5 10"/>
       ${text(580, 365, "t (s)")}${text(20, 40, "v (m/s)")}
       <path d="M70 340 L250 120 L430 120 L560 340" stroke-width="2.5"/>
       <path d="M250 120 V340 M430 120 V340" stroke-dasharray="5 5" stroke-width="1"/>
       ${text(240, 360, "4")}${text(420, 360, "10")}${text(545, 360, "14")}${text(40, 125, "20")}
       ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((i) => `<path d="M${70 + i * 40} 340 v6" stroke-width="1"/>`).join("")}`
    ),
  ray: () =>
    svg(
      720,
      360,
      `<path d="M20 180 H700" stroke-dasharray="8 4" stroke-width="1"/>
       <path d="M360 40 Q395 180 360 320 Q325 180 360 40 Z"/>
       <circle cx="240" cy="180" r="3" fill="#000"/>${text(232, 205, "F")}<circle cx="480" cy="180" r="3" fill="#000"/>${text(472, 205, "F′")}
       <path d="M140 180 V100" stroke-width="3"/><path d="M140 100 l-6 10 M140 100 l6 10"/>${text(120, 95, "Object")}
       <path d="M140 100 H360 L620 300"/><path d="M140 100 L620 300" stroke-width="1.5"/>
       <path d="M620 180 V300" stroke-width="3" stroke-dasharray="6 3"/>${text(600, 325, "Image")}`
    ),
  biology: () =>
    svg(
      560,
      620,
      `<path d="M280 590 C120 470 40 330 70 210 C100 90 230 80 280 170 C330 80 460 90 490 210 C520 330 440 470 280 590 Z" stroke-width="3"/>
       <path d="M280 170 V560" stroke-width="1.5"/><path d="M90 300 H470" stroke-width="1.5"/>
       <path d="M250 150 C250 60 330 40 360 90" stroke-width="5"/>
       ${[
         [180, 240, 40, 200, "Right atrium"],
         [380, 240, 430, 160, "Left atrium"],
         [180, 420, 30, 470, "Right ventricle"],
         [390, 420, 430, 500, "Left ventricle"],
         [350, 85, 420, 40, "X"],
       ]
         .map(([x1, y1, x2, y2, label]) => `<path d="M${x1} ${y1} L${x2} ${y2}" stroke-width="1"/>${text(Number(x2) + 4, Number(y2) - 4, String(label), 13)}`)
         .join("")}`
    ),
  benzene: () =>
    svg(
      320,
      320,
      `<path d="M160 60 L246 110 L246 210 L160 260 L74 210 L74 110 Z" stroke-width="3"/>
       <path d="M160 82 L227 121 M227 199 L160 238 M93 199 L93 121" stroke-width="2"/>
       <path d="M160 60 V20" stroke-width="3"/>${text(146, 16, "OH", 18)}`
    ),
  reaction: () =>
    svg(
      860,
      260,
      `<path d="M60 130 L110 100 L160 130 L210 100" stroke-width="3"/>${text(212, 104, "OH", 18)}${text(40, 200, "ethanol", 13)}
       <path d="M290 130 H520" stroke-width="2.5"/><path d="M520 130 l-14 -7 M520 130 l-14 7" stroke-width="2.5"/>
       ${text(330, 115, "conc. H₂SO₄", 15)}${text(370, 160, "443 K", 15)}
       <path d="M600 130 L660 100" stroke-width="3"/><path d="M604 138 L664 108" stroke-width="3"/>${text(600, 200, "ethene", 13)}
       ${text(700, 135, "+ H₂O", 18)}`
    ),
  ethene: () => svg(260, 160, `<path d="M70 80 L190 80 M70 92 L190 92" stroke-width="3"/>${text(30, 92, "H₂C", 16)}${text(196, 92, "CH₂", 16)}`),
  ethanal: () => svg(260, 160, `<path d="M40 110 L110 70 L180 110" stroke-width="3"/><path d="M110 70 V20 M120 70 V20" stroke-width="3"/>${text(100, 16, "O", 16)}${text(186, 116, "H", 16)}`),
  ether: () => svg(260, 160, `<path d="M20 100 L70 70 L120 100 L170 70 L220 100" stroke-width="3"/><rect x="108" y="88" width="24" height="26" fill="#fff" stroke="none"/>${text(112, 108, "O", 16)}`),
  acid: () =>
    svg(260, 160, `<path d="M40 110 L110 70 L180 110" stroke-width="3"/><path d="M110 70 V20 M120 70 V20" stroke-width="3"/>${text(100, 16, "O", 16)}${text(186, 116, "OH", 16)}`),
  snell: () =>
    svg(
      480,
      360,
      `<path d="M20 180 H460" stroke-width="2"/>${text(30, 170, "air (n = 1)")}${text(30, 210, "glass (n = 1.5)")}<path d="M240 20 V340" stroke-dasharray="6 4" stroke-width="1"/>
       <path d="M120 330 L240 180 L440 172" stroke-width="2.5"/>${text(250, 240, "C", 16)}`
    ),
  tir: () => svg(480, 360, `<path d="M20 180 H460" stroke-width="2"/><path d="M240 20 V340" stroke-dasharray="6 4" stroke-width="1"/><path d="M100 330 L240 180 L380 330" stroke-width="2.5"/>${text(250, 250, "θ > C", 16)}`),
};

export type DrawingName = keyof typeof DRAWINGS;
export const DRAWING_NAMES = Object.keys(DRAWINGS) as DrawingName[];

/** Transparent PNG of a synthetic diagram (scale 1 = the SVG size). */
export function diagramPng(name: DrawingName, scale = 1): Promise<Buffer> {
  return sharp(DRAWINGS[name](), { density: 72 * scale }).png().toBuffer();
}

export async function diagramAs(name: DrawingName, format: "png" | "jpeg" | "webp" | "avif", scale = 1): Promise<Buffer> {
  const s = sharp(await diagramPng(name, scale));
  if (format === "jpeg") return s.flatten({ background: "#fff" }).jpeg({ quality: 92 }).toBuffer();
  if (format === "webp") return s.webp({ quality: 90 }).toBuffer();
  if (format === "avif") return s.avif({ quality: 60 }).toBuffer();
  return s.png().toBuffer();
}

/** A photographic JPEG (noise + gradient) carrying EXIF orientation 6 and GPS — must come out rotated and stripped. */
export async function photoWithExif(): Promise<Buffer> {
  const w = 600;
  const h = 400;
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    raw[i * 3] = (i % w) % 256;
    raw[i * 3 + 1] = (Math.floor(i / w) * 7) % 256;
    raw[i * 3 + 2] = (i * 2654435761) % 256;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 90 })
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD0: { Make: "FixtureCam", Model: "Secret Device" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "26/1 54/1 0/1" } })
    .toBuffer();
}

/** Photographic noise PNG: lossless WebP of it is huge, so the pipeline must fall back to lossy. */
export async function noisePng(w = 1500, h = 1500): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  let x = 123456789;
  for (let i = 0; i < raw.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    raw[i] = x & 255;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
}

/**
 * Decompression-bomb shape: a small valid PNG whose IHDR claims side × side
 * pixels (CRC fixed up). A safe decoder must refuse it from the header alone.
 */
export async function bombPng(side = 20000): Promise<Buffer> {
  const png = Buffer.from(await sharp({ create: { width: 64, height: 64, channels: 3, background: "#000" } }).png().toBuffer());
  png.writeUInt32BE(side, 16);
  png.writeUInt32BE(side, 20);
  png.writeUInt32BE(crc32(png.subarray(12, 29)) >>> 0, 29);
  return png;
}

export async function solidPng(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: svg(w, h, `<path d="M0 0 L${w} ${h}" stroke-width="3"/>`), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

export async function animatedWebp(): Promise<Buffer> {
  const frame = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#f00" } }).png().toBuffer();
  const frame2 = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#00f" } }).png().toBuffer();
  return sharp([frame, frame2], { join: { animated: true } }).webp().toBuffer();
}
