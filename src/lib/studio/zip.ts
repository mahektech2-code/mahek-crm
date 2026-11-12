// A small, strict, dependency-free ZIP writer and checker (Task 7, PR 4: the batch ZIP download).
//
// Only what the download needs: a flat list of files, stored without compression (the posters are PNG or JPEG already), with plain
// names, no folders, no extra fields, no comments, no encryption, and a FIXED timestamp (1980-01-01) so an archive carries no clock
// and the same input always gives the same bytes. It writes ZIP32, so it refuses anything that would not fit, and it refuses names
// that could mean something to an extractor (a path, a drive, "..", control characters, a repeated name). `inspectZip` reads an
// archive back the strict way and checks every field and every CRC; the tests (and the browser test) use it to prove an archive
// is sound, and it refuses anything this writer would not have made.

export type ZipEntry = { name: string; data: Uint8Array };

/** Plain ASCII, one path segment, 1 to 64 characters, starting with a letter or digit. No "/", no "\", no ":", no spaces. */
export const ZIP_ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A batch has at most 50 posters (and a report), so a ZIP of this tool never has more than this many entries. */
export const ZIP_MAX_ENTRIES = 64;
/** The most bytes one archive may hold, so the server never builds a huge file in memory. */
export const ZIP_MAX_BYTES = 120_000_000;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const DOS_TIME = 0;
const VERSION = 20;
const LOCAL_FIXED = 30;
const CENTRAL_FIXED = 46;
const END_FIXED = 22;

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** The standard CRC-32 (the one ZIP, PNG and gzip use). */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/** Builds an archive. Throws ZipError for a bad name, a repeated name, too many entries, or too many bytes. */
export function buildZip(entries: readonly ZipEntry[], options: { maxBytes?: number } = {}): Buffer {
  const maxBytes = options.maxBytes ?? ZIP_MAX_BYTES;
  if (entries.length > ZIP_MAX_ENTRIES) throw new ZipError("too many files for one archive");
  const seen = new Set<string>();
  let total = END_FIXED;
  for (const e of entries) {
    if (!ZIP_ENTRY_NAME.test(e.name) || e.name.includes("..")) throw new ZipError("a file name is not allowed");
    const key = e.name.toLowerCase();
    if (seen.has(key)) throw new ZipError("two files have the same name");
    seen.add(key);
    total += LOCAL_FIXED + e.name.length + e.data.length + CENTRAL_FIXED + e.name.length;
  }
  if (total > maxBytes) throw new ZipError("the archive would be too large");

  const out = Buffer.alloc(total);
  const central: { name: string; crc: number; size: number; offset: number }[] = [];
  let at = 0;
  for (const e of entries) {
    const crc = crc32(e.data);
    const offset = at;
    out.writeUInt32LE(SIG_LOCAL, at);
    out.writeUInt16LE(VERSION, at + 4);
    out.writeUInt16LE(0, at + 6); // flags: none (plain ASCII names, sizes known)
    out.writeUInt16LE(0, at + 8); // method: stored
    out.writeUInt16LE(DOS_TIME, at + 10);
    out.writeUInt16LE(DOS_DATE, at + 12);
    out.writeUInt32LE(crc, at + 14);
    out.writeUInt32LE(e.data.length, at + 18);
    out.writeUInt32LE(e.data.length, at + 22);
    out.writeUInt16LE(e.name.length, at + 26);
    out.writeUInt16LE(0, at + 28);
    out.write(e.name, at + LOCAL_FIXED, "ascii");
    at += LOCAL_FIXED + e.name.length;
    out.set(e.data, at);
    at += e.data.length;
    central.push({ name: e.name, crc, size: e.data.length, offset });
  }
  const centralStart = at;
  for (const c of central) {
    out.writeUInt32LE(SIG_CENTRAL, at);
    out.writeUInt16LE(VERSION, at + 4); // made by
    out.writeUInt16LE(VERSION, at + 6); // needed
    out.writeUInt16LE(0, at + 8);
    out.writeUInt16LE(0, at + 10);
    out.writeUInt16LE(DOS_TIME, at + 12);
    out.writeUInt16LE(DOS_DATE, at + 14);
    out.writeUInt32LE(c.crc, at + 16);
    out.writeUInt32LE(c.size, at + 20);
    out.writeUInt32LE(c.size, at + 24);
    out.writeUInt16LE(c.name.length, at + 28);
    out.writeUInt16LE(0, at + 30); // extra
    out.writeUInt16LE(0, at + 32); // comment
    out.writeUInt16LE(0, at + 34); // disk
    out.writeUInt16LE(0, at + 36); // internal attributes
    out.writeUInt32LE(0, at + 38); // external attributes
    out.writeUInt32LE(c.offset, at + 42);
    out.write(c.name, at + CENTRAL_FIXED, "ascii");
    at += CENTRAL_FIXED + c.name.length;
  }
  out.writeUInt32LE(SIG_END, at);
  out.writeUInt16LE(0, at + 4);
  out.writeUInt16LE(0, at + 6);
  out.writeUInt16LE(central.length, at + 8);
  out.writeUInt16LE(central.length, at + 10);
  out.writeUInt32LE(at - centralStart, at + 12);
  out.writeUInt32LE(centralStart, at + 16);
  out.writeUInt16LE(0, at + 20); // comment length
  return out;
}

/**
 * Reads an archive back, strictly: the end record, the central directory and every local header must agree, every file must be
 * stored, every name must be allowed, nothing may overlap or be left over, and every CRC must match. Throws ZipError otherwise.
 */
export function inspectZip(buf: Uint8Array): ZipEntry[] {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const bad = (why: string): never => {
    throw new ZipError(why);
  };
  if (b.length < END_FIXED) bad("too short");
  const end = b.length - END_FIXED;
  if (b.readUInt32LE(end) !== SIG_END) bad("no end record (or a comment, which this writer never makes)");
  const count = b.readUInt16LE(end + 10);
  if (b.readUInt16LE(end + 8) !== count) bad("entry counts differ");
  if (b.readUInt16LE(end + 4) !== 0 || b.readUInt16LE(end + 6) !== 0 || b.readUInt16LE(end + 20) !== 0) bad("multi-disk or comment");
  const centralSize = b.readUInt32LE(end + 12);
  const centralStart = b.readUInt32LE(end + 16);
  if (centralStart + centralSize !== end) bad("the central directory does not end where the end record starts");

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let expectedOffset = 0;
  let at = centralStart;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_FIXED > end || b.readUInt32LE(at) !== SIG_CENTRAL) bad("bad central directory entry");
    const flags = b.readUInt16LE(at + 8);
    const method = b.readUInt16LE(at + 10);
    const crc = b.readUInt32LE(at + 16);
    const csize = b.readUInt32LE(at + 20);
    const usize = b.readUInt32LE(at + 24);
    const nameLen = b.readUInt16LE(at + 28);
    const extraLen = b.readUInt16LE(at + 30);
    const commentLen = b.readUInt16LE(at + 32);
    const offset = b.readUInt32LE(at + 42);
    if (flags !== 0 || method !== 0) bad("only plain stored files are allowed");
    if (csize !== usize) bad("stored sizes differ");
    if (extraLen !== 0 || commentLen !== 0) bad("extra fields and comments are not allowed");
    const name = b.toString("ascii", at + CENTRAL_FIXED, at + CENTRAL_FIXED + nameLen);
    if (!ZIP_ENTRY_NAME.test(name) || name.includes("..")) bad("a file name is not allowed");
    if (names.has(name.toLowerCase())) bad("a file name is repeated");
    names.add(name.toLowerCase());
    // the local header must say the same, and the data must follow it directly
    if (offset !== expectedOffset) bad("files are not laid out one after another");
    if (b.readUInt32LE(offset) !== SIG_LOCAL) bad("bad local header");
    if (b.readUInt16LE(offset + 6) !== 0 || b.readUInt16LE(offset + 8) !== 0 || b.readUInt16LE(offset + 28) !== 0) bad("local header does not match");
    if (b.readUInt32LE(offset + 14) !== crc || b.readUInt32LE(offset + 18) !== csize || b.readUInt32LE(offset + 22) !== usize || b.readUInt16LE(offset + 26) !== nameLen) bad("local header does not match the directory");
    if (b.toString("ascii", offset + LOCAL_FIXED, offset + LOCAL_FIXED + nameLen) !== name) bad("local and directory names differ");
    const dataStart = offset + LOCAL_FIXED + nameLen;
    if (dataStart + usize > centralStart) bad("file data runs into the directory");
    const data = new Uint8Array(b.subarray(dataStart, dataStart + usize));
    if (crc32(data) !== crc) bad(`CRC mismatch in ${name}`);
    entries.push({ name, data });
    expectedOffset = dataStart + usize;
    at += CENTRAL_FIXED + nameLen;
  }
  if (at !== end) bad("bytes left over in the directory");
  if (expectedOffset !== centralStart) bad("bytes left over between the files and the directory");
  return entries;
}
