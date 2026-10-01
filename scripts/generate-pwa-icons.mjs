/**
 * Renders the installable-app (PWA) icons into public/icons/. The artwork is
 * the existing in-app mark — the student header's white lucide GraduationCap
 * on the --color-primary blue tile (components/student/header.tsx) — so the
 * home-screen icon matches what students already see; it is not a new logo.
 *
 *   node scripts/generate-pwa-icons.mjs
 *
 * Re-run only when the mark changes, then bump CACHE_VERSION in
 * app/sw.js/route.ts so installed apps fetch the new files.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const BLUE = "#3B82F6";
const OUT = path.join(process.cwd(), "public/icons");

// lucide-react graduation-cap (ISC), 24×24 viewBox, stroke-only.
const CAP = `
  <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/>
  <path d="M22 10v6"/>
  <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>`;

/**
 * `glyph` is the cap's share of the icon width. Maskable icons keep it well
 * inside the 80% safe zone so any launcher mask (circle, squircle) never
 * clips it; `radius` 0 means a full-bleed square for masks and iOS.
 */
function svg({ size, glyph, radius }) {
  const g = size * glyph;
  const offset = (size - g) / 2;
  const scale = g / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * radius}" fill="${BLUE}"/>
  <g transform="translate(${offset} ${offset + g * 0.02}) scale(${scale})" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${CAP}
  </g>
</svg>`;
}

const ICONS = [
  { file: "icon-192.png", size: 192, glyph: 0.62, radius: 0.22 },
  { file: "icon-512.png", size: 512, glyph: 0.62, radius: 0.22 },
  { file: "maskable-192.png", size: 192, glyph: 0.5, radius: 0 },
  { file: "maskable-512.png", size: 512, glyph: 0.5, radius: 0 },
  { file: "apple-touch-icon.png", size: 180, glyph: 0.56, radius: 0 },
];

await mkdir(OUT, { recursive: true });
for (const icon of ICONS) {
  await sharp(Buffer.from(svg(icon))).png({ compressionLevel: 9 }).toFile(path.join(OUT, icon.file));
  console.log(`public/icons/${icon.file}`);
}
