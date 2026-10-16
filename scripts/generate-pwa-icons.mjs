/**
 * Renders the site icons: the installable-app (PWA) icons into public/icons/
 * and the browser favicon into app/favicon.ico. The artwork is the owner-
 * approved MTS monogram (2026-10-16, "Option 3"): a green M and white TS in
 * Poppins ExtraBold on black, the same split as the MockTestSeries.in
 * wordmark, with a thin green border on the rounded app icons.
 *
 *   node scripts/generate-pwa-icons.mjs
 *
 * The letters are fixed outlines (Poppins ExtraBold, SIL Open Font License,
 * 100 px em, baseline y=0, -0.02em tracking) so the output never depends on
 * fonts installed on the machine. Re-run only when the mark changes, then
 * bump CACHE_VERSION in app/sw.js/route.ts so installed apps fetch the new files.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const GREEN = "#008209";
const BLACK = "#000000";
const OUT = path.join(process.cwd(), "public/icons");
const FAVICON = path.join(process.cwd(), "app/favicon.ico");

const M_PATH = "M64.3-70.5L87.9-70.5L87.9 0L68.3 0L68.3-38.9L55 0L38.6 0L25.2-39.2L25.2 0L5.6 0L5.6-70.5L29.3-70.5L47-24.7L64.3-70.5Z";
const TS_PATH = "M93.2-70.5L150.2-70.5L150.2-54.9L131.4-54.9L131.4 0L111.8 0L111.8-54.9L93.2-54.9L93.2-70.5ZM182.1 0.7Q169.8 0.7 161.9-5.2Q154-11 153.4-21.9L153.4-21.9L174.3-21.9Q174.6-18.2 176.5-16.5Q178.4-14.8 181.4-14.8L181.4-14.8Q184.1-14.8 185.9-16.2Q187.6-17.5 187.6-19.9L187.6-19.9Q187.6-23 184.7-24.7Q181.8-26.4 175.3-28.5L175.3-28.5Q168.4-30.8 164.2-33.0Q159.9-35.1 156.8-39.3Q153.6-43.4 153.6-50.1L153.6-50.1Q153.6-56.9 157-61.8Q160.4-66.6 166.4-69.1Q172.4-71.6 180-71.6L180-71.6Q192.3-71.6 199.7-65.9Q207-60.1 207.5-49.7L207.5-49.7L186.2-49.7Q186.1-52.9 184.3-54.5Q182.4-56.1 179.5-56.1L179.5-56.1Q177.3-56.1 175.9-54.8Q174.5-53.5 174.5-51.1L174.5-51.1Q174.5-49.1 176.1-47.7Q177.6-46.2 179.9-45.2Q182.2-44.1 186.7-42.5L186.7-42.5Q193.4-40.2 197.8-38.0Q202.1-35.7 205.3-31.7Q208.4-27.6 208.4-21.4L208.4-21.4Q208.4-15.1 205.3-10.1Q202.1-5.1 196.2-2.2Q190.2 0.7 182.1 0.7L182.1 0.7Z";
/** Outline bounds of "MTS" in the paths' own units. */
const BOX = { x1: 5.6, y1: -71.6, x2: 208.4, y2: 0.7 };

/**
 * `text` is the monogram's share of the icon width. `radius` 0 = a full-bleed
 * square (maskable icons and iOS apply their own mask; maskable keeps the
 * letters inside the 80% safe zone). `border` = the green rim's share of the
 * width (only on the rounded "any" icons, where nothing crops it).
 */
function svg({ size, text, radius, border = 0 }) {
  const scale = (size * text) / (BOX.x2 - BOX.x1);
  const tx = (size - (BOX.x2 - BOX.x1) * scale) / 2 - BOX.x1 * scale;
  const ty = (size - (BOX.y2 - BOX.y1) * scale) / 2 - BOX.y1 * scale;
  const b = size * border;
  const rim = b
    ? `<rect x="${b / 2}" y="${b / 2}" width="${size - b}" height="${size - b}" rx="${size * radius - b / 2}" fill="none" stroke="${GREEN}" stroke-width="${b}"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * radius}" fill="${BLACK}"/>${rim}
  <g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})">
    <path d="${M_PATH}" fill="${GREEN}"/>
    <path d="${TS_PATH}" fill="#FFFFFF"/>
  </g>
</svg>`;
}

const ICONS = [
  { file: "icon-192.png", size: 192, text: 0.66, radius: 0.22, border: 0.02 },
  { file: "icon-512.png", size: 512, text: 0.66, radius: 0.22, border: 0.02 },
  { file: "maskable-192.png", size: 192, text: 0.56, radius: 0 },
  { file: "maskable-512.png", size: 512, text: 0.56, radius: 0 },
  { file: "apple-touch-icon.png", size: 180, text: 0.66, radius: 0 },
];

// Browser tab sizes: no rim (it would eat the few pixels the letters have).
const FAVICON_SIZES = [16, 32, 48];
const favicon = (size) => svg({ size, text: 0.86, radius: 0.2 });

const png = (markup) => sharp(Buffer.from(markup)).png({ compressionLevel: 9 }).toBuffer();

/** ICO container with PNG-encoded entries (supported by every current browser). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((img) => img.data)]);
}

await mkdir(OUT, { recursive: true });
for (const icon of ICONS) {
  await writeFile(path.join(OUT, icon.file), await png(svg(icon)));
  console.log(`public/icons/${icon.file}`);
}
await writeFile(FAVICON, ico(await Promise.all(FAVICON_SIZES.map(async (size) => ({ size, data: await png(favicon(size)) })))));
console.log(`app/favicon.ico (${FAVICON_SIZES.join(", ")} px)`);
