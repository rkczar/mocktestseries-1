import "server-only";
import { open } from "node:fs/promises";
import { crc32, inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { checkEntryName, ZipSecurityError } from "@/lib/rich-import/zip";

/**
 * Defensive reader for Office containers (DOCX / XLSX) uploaded to the AI
 * Question Importer. Same rules as the rich-import ZIP reader
 * (lib/rich-import/zip.ts — whose name checks it reuses) except that the XML
 * parts an Office file is made of are allowed. Nothing is extracted to disk;
 * entries are read one at a time into bounded buffers and CRC-checked.
 * Refused: ZIP64 / multi-disk, encrypted entries, traversal names, too many
 * entries, oversized entries, bomb ratios, embedded executables / archives.
 */

const inflateRawAsync = promisify(inflateRaw) as (buf: Buffer, opts: { maxOutputLength: number }) => Promise<Buffer>;

export const OFFICE_LIMITS = {
  maxArchiveBytes: 200 * 1024 * 1024,
  maxEntries: 3000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxExpandedBytes: 1024 * 1024 * 1024,
  maxRatio: 200,
};

const FORBIDDEN = /\.(exe|dll|so|bin|com|scr|msi|bat|cmd|ps1|vbs|js|jar|sh|zip|rar|7z|gz|tar|docm|xlsm)$/i;

export interface OfficeEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
  flags: number;
}

export async function readZipDirectory(filePath: string): Promise<OfficeEntry[]> {
  const fh = await open(filePath, "r");
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new ZipSecurityError("Not a ZIP container (too small).");
    if (size > OFFICE_LIMITS.maxArchiveBytes) throw new ZipSecurityError("The document is too large.");
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new ZipSecurityError("Damaged container (no end-of-directory record).");
    const disk = tail.readUInt16LE(eocd + 4);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || count === 0xffff || cdOffset === 0xffffffff) throw new ZipSecurityError("Multi-disk or ZIP64 containers are not accepted.");
    if (count > OFFICE_LIMITS.maxEntries) throw new ZipSecurityError("The document has too many parts.");
    if (cdOffset + cdSize > size || cdSize > 8 * 1024 * 1024) throw new ZipSecurityError("Damaged container (central directory out of range).");
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out: OfficeEntry[] = [];
    const names = new Set<string>();
    let expanded = 0;
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new ZipSecurityError("Damaged container (bad directory entry).");
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compressedSize = cd.readUInt32LE(p + 20);
      const uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const externalAttr = cd.readUInt32LE(p + 38);
      const localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
      p += 46 + nameLen + extraLen + commentLen;
      if (flags & 0x1) throw new ZipSecurityError("Encrypted documents are not accepted.");
      checkEntryName(name);
      if (((externalAttr >>> 16) & 0o170000) === 0o120000) throw new ZipSecurityError("The container holds a symbolic link.");
      if (FORBIDDEN.test(name) && !/\/vbaProject\.bin$/i.test(name)) throw new ZipSecurityError(`The document contains an embedded file that is not allowed ("${name.slice(0, 80)}").`);
      if (names.has(name)) throw new ZipSecurityError("The container lists the same part twice.");
      names.add(name);
      if (name.endsWith("/")) continue;
      if (uncompressedSize > OFFICE_LIMITS.maxEntryBytes) throw new ZipSecurityError(`A document part is too large ("${name.slice(0, 80)}").`);
      if (compressedSize > 1024 && uncompressedSize / Math.max(1, compressedSize) > OFFICE_LIMITS.maxRatio) throw new ZipSecurityError("Suspicious compression ratio (possible zip bomb).");
      expanded += uncompressedSize;
      if (expanded > OFFICE_LIMITS.maxExpandedBytes) throw new ZipSecurityError("The document expands to too much data.");
      if (localHeaderOffset >= size) throw new ZipSecurityError("Damaged container (entry out of range).");
      out.push({ name, method, compressedSize, uncompressedSize, crc32: crc, localHeaderOffset, flags });
    }
    return out;
  } finally {
    await fh.close();
  }
}

export async function readEntry(filePath: string, entry: OfficeEntry, maxBytes = OFFICE_LIMITS.maxEntryBytes): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes) throw new ZipSecurityError(`"${entry.name}" is too large.`);
  const fh = await open(filePath, "r");
  try {
    const head = Buffer.alloc(30);
    await fh.read(head, 0, 30, entry.localHeaderOffset);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new ZipSecurityError(`"${entry.name}" is corrupt.`);
    const dataStart = entry.localHeaderOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const data = Buffer.alloc(entry.compressedSize);
    const { bytesRead } = await fh.read(data, 0, entry.compressedSize, dataStart);
    if (bytesRead !== entry.compressedSize) throw new ZipSecurityError(`"${entry.name}" is truncated.`);
    let bytes: Buffer;
    if (entry.method === 0) bytes = data;
    else if (entry.method === 8) {
      try {
        bytes = await inflateRawAsync(data, { maxOutputLength: entry.uncompressedSize + 1 });
      } catch {
        throw new ZipSecurityError(`"${entry.name}" could not be decompressed.`);
      }
    } else throw new ZipSecurityError(`"${entry.name}" uses an unsupported compression method.`);
    if (bytes.length !== entry.uncompressedSize || (crc32(bytes) >>> 0) !== (entry.crc32 >>> 0)) throw new ZipSecurityError(`"${entry.name}" failed its integrity check.`);
    return bytes;
  } finally {
    await fh.close();
  }
}
