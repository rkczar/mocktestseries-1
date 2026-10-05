import { crc32, deflateRawSync } from "node:zlib";

/**
 * Tiny ZIP writer for the downloadable sample image bundle and the test
 * fixtures (synthetic content only). Standard deflate/stored entries, UTF-8
 * names, no ZIP64. `raw` lets fixtures forge hostile archives (traversal,
 * symlink, bomb ratios) to prove the reader refuses them.
 */
export interface ZipWriteEntry {
  name: string;
  data: Buffer;
  store?: boolean;
  raw?: { unixMode?: number; declaredSize?: number; crc?: number; flags?: number };
}

export function buildZip(entries: ZipWriteEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const method = e.store ? 0 : 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = e.raw?.crc ?? crc32(e.data) >>> 0;
    const usize = e.raw?.declaredSize ?? e.data.length;
    const flags = (e.raw?.flags ?? 0) | 0x800;

    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(flags, 6);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(0, 10);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(usize, 22);
    loc.writeUInt16LE(name.length, 26);
    loc.writeUInt16LE(0, 28);
    locals.push(loc, name, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(e.raw?.unixMode !== undefined ? (3 << 8) | 20 : 20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(0, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(usize, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(e.raw?.unixMode !== undefined ? (e.raw.unixMode << 16) >>> 0 : 0, 38);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
