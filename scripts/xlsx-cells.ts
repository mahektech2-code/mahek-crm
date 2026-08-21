/**
 * The first worksheet of an .xlsx, as a grid of strings. Zero dependencies.
 *
 * An .xlsx is a zip of XML, and both halves of that are simple enough to read
 * here: the alternative is a parser dependency in the tree for the sake of one
 * hand-run import. Values come back as WRITTEN — a date cell yields Excel's
 * serial and a number yields its digits — because deciding what a cell means
 * is `outstanding-parse.ts`'s job and not this file's.
 *
 * Deliberately not general: no zip64, no multi-sheet selection, no formulas
 * (the cached value is used). It reads the workbook it was written for and
 * says so loudly if handed something else.
 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

function entries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();

  // The end-of-central-directory record, scanned for from the back.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file — no end-of-central-directory record");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt entry: ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    out.set(name, method === 0 ? raw : inflateRawSync(raw));

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};

function unescapeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code] ?? whole;
  });
}

/** Every `<t>` under one element, joined — a run-formatted string is still one string. */
function textOf(xml: string): string {
  let s = "";
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += m[1];
  return unescapeXml(s);
}

/** "BC" → 54. Spreadsheet columns are base-26 with no zero. */
function columnOf(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsxCells(path: string): string[][] {
  const zip = entries(readFileSync(path));

  const sheetName =
    [...zip.keys()].find((k) => /^xl\/worksheets\/sheet1\.xml$/.test(k)) ??
    [...zip.keys()].find((k) => /^xl\/worksheets\/.*\.xml$/.test(k));
  if (!sheetName) throw new Error("no worksheet inside this file");

  const shared: string[] = [];
  const ss = zip.get("xl/sharedStrings.xml");
  if (ss) for (const m of ss.toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));

  const xml = zip.get(sheetName)!.toString("utf8");
  const grid: string[][] = [];

  for (const rm of xml.matchAll(/<row[^>]*\sr="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cm of rm[2].matchAll(/<c\s([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const body = cm[3] ?? "";

      let value = "";
      if (type === "inlineStr") value = textOf(body);
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        value = type === "s" ? (shared[Number(v)] ?? "") : unescapeXml(v);
      }

      const at = columnOf(ref);
      while (cells.length < at) cells.push("");
      cells[at] = value.trim();
    }
    const at = Number(rm[1]) - 1;
    while (grid.length < at) grid.push([]);
    grid[at] = cells;
  }

  return grid;
}
