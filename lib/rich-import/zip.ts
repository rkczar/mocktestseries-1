import { open } from "node:fs/promises";
import { crc32, inflateRaw } from "node:zlib";
import { promisify } from "node:util";

/**
 * Minimal, defensive ZIP reader for rich-import image bundles (NEET Phase 3).
 *
 * Nothing is ever extracted to disk. The central directory is parsed and
 * vetted up front (`readZipDirectory`), then single entries are read on
 * demand (`readZipEntry`) into a bounded buffer and verified against their
 * declared size and CRC-32. The archive file itself lives in private staging
 * storage (lib/rich-import/bundle.ts).
 *
 * Refused outright (the whole archive is rejected — these are hostile or
 * broken archives, not authoring mistakes): multi-disk / ZIP64, encrypted
 * entries, absolute or `..` paths, backslashes, drive letters, control
 * characters, symlinks, duplicate names, overlapping entries, executable /
 * script / markup / nested-archive files, too many entries, too much
 * expanded data, and suspicious compression ratios (zip bombs).
 *
 * Reported per entry (an authoring problem the admin can fix): unsupported
 * file types (gif, bmp, pdf, …), unsupported compression methods, entries
 * larger than the per-image limit.
 */

const inflateRawAsync = promisify(inflateRaw) as (buf: Buffer, opts: { maxOutputLength: number }) => Promise<Buffer>;

export const ZIP_LIMITS = {
  /** Uploaded archive size. A 180-question paper with diagrams is typically 10–60 MB. */
  maxArchiveBytes: 200 * 1024 * 1024,
  maxEntries: 2000,
  /** Per-image size; matches the media engine's upload limit (lib/media-processing.ts). */
  maxEntryBytes: 8 * 1024 * 1024,
  /** Sum of declared uncompressed sizes. */
  maxExpandedBytes: 1024 * 1024 * 1024,
  /** Compression ratio above which a non-trivial entry is treated as a bomb. */
  maxRatio: 100,
  maxNameLength: 200,
  maxDepth: 4,
  maxCentralDirectoryBytes: 4 * 1024 * 1024,
} as const;

export class ZipSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipSecurityError";
  }
}

export type ZipEntryKind = "IMAGE" | "IGNORED" | "UNSUPPORTED" | "DIRECTORY";

export interface ZipEntryInfo {
  /** Full path inside the archive (validated, forward slashes). */
  name: string;
  /** Last path segment — what XLSX image references match against. */
  basename: string;
  kind: ZipEntryKind;
  /** Why an entry is UNSUPPORTED / IGNORED (null for usable images). */
  note: string | null;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
}

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "avif"]);

/** Executables, scripts, markup that can carry script, and archives (no archive-in-archive). */
const FORBIDDEN_EXTENSIONS = new Set([
  "exe", "dll", "so", "dylib", "bin", "com", "scr", "msi", "msp", "app", "apk", "dmg", "iso", "deb", "rpm",
  "sh", "bash", "zsh", "csh", "ksh", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "wsf", "wsh", "hta", "lnk", "reg",
  "js", "mjs", "cjs", "ts", "jar", "class", "py", "pyc", "pl", "rb", "php", "phtml", "asp", "aspx", "jsp", "cgi",
  "html", "htm", "xhtml", "shtml", "svg", "svgz", "xml", "xsl", "swf",
  "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "cab", "lz", "lzma", "jar", "war",
  "xlsm", "xlsb", "docm", "pptm",
]);

/** OS junk that zip tools add; skipped silently (reported as IGNORED). */
function isJunk(name: string, base: string): boolean {
  return name.startsWith("__MACOSX/") || base === ".DS_Store" || base === "Thumbs.db" || base === "desktop.ini" || base.startsWith("._");
}

export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Validates an entry path; throws ZipSecurityError for anything that could escape or confuse. */
export function checkEntryName(name: string): void {
  if (!name) throw new ZipSecurityError("The archive contains an entry with an empty name.");
  if (name.length > ZIP_LIMITS.maxNameLength) throw new ZipSecurityError(`Entry name too long: "${name.slice(0, 60)}…"`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new ZipSecurityError("The archive contains an entry name with control characters.");
  if (name.includes("\\")) throw new ZipSecurityError(`Entry "${name}" uses backslashes — refused (possible path traversal).`);
  if (name.startsWith("/")) throw new ZipSecurityError(`Entry "${name}" is an absolute path — refused.`);
  if (/^[a-zA-Z]:/.test(name)) throw new ZipSecurityError(`Entry "${name}" has a drive letter — refused.`);
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  const segments = trimmed.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw new ZipSecurityError(`Entry "${name}" contains an empty, "." or ".." path segment — refused (path traversal).`);
  if (segments.length > ZIP_LIMITS.maxDepth + 1) throw new ZipSecurityError(`Entry "${name}" is nested too deeply (max ${ZIP_LIMITS.maxDepth} folders).`);
}

function classify(name: string, isDir: boolean): { kind: ZipEntryKind; note: string | null } {
  const base = name.slice(name.lastIndexOf("/", name.length - 2) + 1).replace(/\/$/, "");
  if (isDir) return { kind: "DIRECTORY", note: null };
  if (isJunk(name, base)) return { kind: "IGNORED", note: "Operating-system metadata file — ignored." };
  const ext = extensionOf(name);
  if (FORBIDDEN_EXTENSIONS.has(ext)) {
    throw new ZipSecurityError(`The archive contains "${name}" — executable, script, markup (including SVG) and nested archive files are not accepted. Remove it and upload images only.`);
  }
  if (base.startsWith(".")) return { kind: "IGNORED", note: "Hidden (dot) file — ignored." };
  if (!IMAGE_EXTENSIONS.has(ext)) return { kind: "UNSUPPORTED", note: `Unsupported file type ".${ext || "(none)"}" — only PNG, JPEG, WebP or AVIF images are accepted.` };
  return { kind: "IMAGE", note: null };
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

/** Parses and vets the central directory of the archive at `filePath`. */
export async function readZipDirectory(filePath: string): Promise<ZipEntryInfo[]> {
  const fh = await open(filePath, "r");
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new ZipSecurityError("The file is not a ZIP archive (too small).");
    if (size > ZIP_LIMITS.maxArchiveBytes) throw new ZipSecurityError(`The archive is larger than ${ZIP_LIMITS.maxArchiveBytes / 1024 / 1024} MB.`);

    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) === tailLen) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipSecurityError("The file is not a valid ZIP archive (no end-of-central-directory record).");
    const diskNo = tail.readUInt16LE(eocd + 4);
    const cdDisk = tail.readUInt16LE(eocd + 6);
    const entriesOnDisk = tail.readUInt16LE(eocd + 8);
    const totalEntries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (diskNo !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) throw new ZipSecurityError("Multi-part (spanned) ZIP archives are not supported.");
    if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipSecurityError("ZIP64 archives are not supported. Re-create the bundle with a standard ZIP tool.");
    if (totalEntries > ZIP_LIMITS.maxEntries) throw new ZipSecurityError(`The archive has ${totalEntries} entries (max ${ZIP_LIMITS.maxEntries}).`);
    if (cdSize > ZIP_LIMITS.maxCentralDirectoryBytes) throw new ZipSecurityError("The archive's directory is unreasonably large.");
    const eocdAbs = size - tailLen + eocd;
    if (cdOffset + cdSize > eocdAbs) throw new ZipSecurityError("The ZIP directory is corrupt (points outside the archive).");

    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    const out: ZipEntryInfo[] = [];
    const seen = new Set<string>();
    let p = 0;
    let expanded = 0;
    for (let n = 0; n < totalEntries; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CEN) throw new ZipSecurityError("The ZIP directory is corrupt.");
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const diskStart = cd.readUInt16LE(p + 34);
      const extAttr = cd.readUInt32LE(p + 38);
      const lho = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new ZipSecurityError("The ZIP directory is corrupt.");
      const rawName = cd.subarray(p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;

      if (diskStart !== 0) throw new ZipSecurityError("Multi-part (spanned) ZIP archives are not supported.");
      if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) throw new ZipSecurityError("ZIP64 entries are not supported.");
      if (flags & 0x1) throw new ZipSecurityError("Encrypted (password-protected) ZIP entries are not accepted.");
      // Bit 11 = UTF-8 names. Otherwise only plain ASCII is accepted (CP437 names are ambiguous).
      const utf8 = (flags & 0x800) !== 0;
      if (!utf8 && rawName.some((b) => b > 0x7e)) throw new ZipSecurityError("A file name in the archive is not ASCII or UTF-8 — rename it with plain characters.");
      const name = rawName.toString(utf8 ? "utf8" : "latin1");
      if (name.includes("�")) throw new ZipSecurityError("A file name in the archive is not valid UTF-8.");
      checkEntryName(name);
      // Unix symlink (S_IFLNK) — never followed, never accepted.
      if (madeBy >> 8 === 3 && ((extAttr >>> 16) & 0o170000) === 0o120000) throw new ZipSecurityError(`Entry "${name}" is a symbolic link — refused.`);
      if (seen.has(name)) throw new ZipSecurityError(`The archive contains "${name}" twice.`);
      seen.add(name);

      const isDir = name.endsWith("/");
      const { kind, note } = classify(name, isDir);
      expanded += usize;
      if (expanded > ZIP_LIMITS.maxExpandedBytes) throw new ZipSecurityError(`The archive expands to more than ${ZIP_LIMITS.maxExpandedBytes / 1024 / 1024} MB.`);
      if (usize > 1024 * 1024 && usize / Math.max(csize, 1) > ZIP_LIMITS.maxRatio) {
        throw new ZipSecurityError(`Entry "${name}" has a suspicious compression ratio (${Math.round(usize / Math.max(csize, 1))}:1) — refused as a possible zip bomb.`);
      }
      const base = isDir ? name : name.slice(name.lastIndexOf("/") + 1);
      let finalKind = kind;
      let finalNote = note;
      if (kind === "IMAGE" && method !== 0 && method !== 8) {
        finalKind = "UNSUPPORTED";
        finalNote = `Compression method ${method} is not supported — use standard (deflate) ZIP.`;
      } else if (kind === "IMAGE" && usize > ZIP_LIMITS.maxEntryBytes) {
        finalKind = "UNSUPPORTED";
        finalNote = `Image is ${(usize / 1024 / 1024).toFixed(1)} MB — images must be at most ${ZIP_LIMITS.maxEntryBytes / 1024 / 1024} MB.`;
      } else if (kind === "IMAGE" && method === 0 && csize !== usize) {
        throw new ZipSecurityError(`Entry "${name}" is corrupt (stored size mismatch).`);
      }
      out.push({ name, basename: base, kind: finalKind, note: finalNote, method, compressedSize: csize, uncompressedSize: usize, crc32: crc, localHeaderOffset: lho });
    }

    // Overlapping entries (the "overlapping files" bomb technique) and entries outside the data area.
    const files = out.filter((e) => e.kind !== "DIRECTORY").sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
    for (let i = 0; i < files.length; i++) {
      const e = files[i];
      const minEnd = e.localHeaderOffset + 30 + Buffer.byteLength(e.name) + e.compressedSize;
      const limit = i + 1 < files.length ? files[i + 1].localHeaderOffset : cdOffset;
      if (minEnd > limit) throw new ZipSecurityError(`Entry "${e.name}" overlaps another entry — refused (malformed or malicious archive).`);
    }
    return out;
  } finally {
    await fh.close();
  }
}

/**
 * Reads and verifies ONE entry. Bounded: at most the declared size is ever
 * inflated (maxOutputLength), and the result must match the declared size and
 * CRC-32 exactly.
 */
export async function readZipEntry(filePath: string, entry: ZipEntryInfo): Promise<Buffer> {
  if (entry.kind !== "IMAGE") throw new ZipSecurityError(`"${entry.name}" is not a readable image entry.`);
  if (entry.uncompressedSize > ZIP_LIMITS.maxEntryBytes) throw new ZipSecurityError(`"${entry.name}" is too large.`);
  if (entry.compressedSize > ZIP_LIMITS.maxEntryBytes + 64 * 1024) throw new ZipSecurityError(`"${entry.name}" is too large.`);
  const fh = await open(filePath, "r");
  try {
    const head = Buffer.alloc(30);
    await fh.read(head, 0, 30, entry.localHeaderOffset);
    if (head.readUInt32LE(0) !== SIG_LOC) throw new ZipSecurityError(`"${entry.name}" is corrupt (bad local header).`);
    if (head.readUInt16LE(6) & 0x1) throw new ZipSecurityError("Encrypted ZIP entries are not accepted.");
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const nameBuf = Buffer.alloc(nameLen);
    await fh.read(nameBuf, 0, nameLen, entry.localHeaderOffset + 30);
    if (nameBuf.toString("utf8") !== entry.name && nameBuf.toString("latin1") !== entry.name) {
      throw new ZipSecurityError(`"${entry.name}" does not match its local header name — refused (malformed or malicious archive).`);
    }
    const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
    const data = Buffer.alloc(entry.compressedSize);
    const { bytesRead } = await fh.read(data, 0, entry.compressedSize, dataStart);
    if (bytesRead !== entry.compressedSize) throw new ZipSecurityError(`"${entry.name}" is truncated.`);

    let bytes: Buffer;
    if (entry.method === 0) bytes = data;
    else if (entry.method === 8) {
      try {
        // +1 so an entry that inflates beyond its declared size is detected, never expanded further.
        bytes = await inflateRawAsync(data, { maxOutputLength: entry.uncompressedSize + 1 });
      } catch {
        throw new ZipSecurityError(`"${entry.name}" could not be decompressed (corrupt or larger than declared).`);
      }
    } else throw new ZipSecurityError(`"${entry.name}" uses an unsupported compression method.`);
    if (bytes.length !== entry.uncompressedSize) throw new ZipSecurityError(`"${entry.name}" does not match its declared size.`);
    if (crc32(bytes) >>> 0 !== entry.crc32 >>> 0) throw new ZipSecurityError(`"${entry.name}" failed its CRC check (corrupt archive).`);
    return bytes;
  } finally {
    await fh.close();
  }
}
