import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ZIP_ENTRY_NAME, ZIP_MAX_ENTRIES, ZipError, buildZip, crc32, inspectZip } from "./zip";

const bytes = (...n: number[]) => Uint8Array.from(n);
const text = (s: string) => new TextEncoder().encode(s);
const allBytes = () => Uint8Array.from({ length: 256 * 4 }, (_, i) => i % 256);
const throwsZip = (run: () => unknown, why = "") => assert.throws(run, (e: unknown) => e instanceof ZipError && (why === "" || e.message.includes(why)));

describe("crc32", () => {
  test("matches the standard test values", () => {
    assert.equal(crc32(text("123456789")), 0xcbf43926);
    assert.equal(crc32(new Uint8Array()), 0);
    assert.equal(crc32(text("a")), 0xe8b7be43);
    assert.equal(crc32(text("The quick brown fox jumps over the lazy dog")), 0x414fa339);
  });
});

describe("buildZip and inspectZip", () => {
  test("an archive reads back exactly: names, order and every byte, including binary data", () => {
    const entries = [
      { name: "poster-001.png", data: allBytes() },
      { name: "poster-002.jpg", data: bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10) },
      { name: "report.txt", data: text("poster-003: not included\n") },
    ];
    const back = inspectZip(buildZip(entries));
    assert.deepEqual(back.map((e) => e.name), ["poster-001.png", "poster-002.jpg", "report.txt"]);
    for (let i = 0; i < entries.length; i++) assert.deepEqual(Buffer.from(back[i]!.data), Buffer.from(entries[i]!.data));
  });
  test("an empty file and an empty archive are valid", () => {
    assert.deepEqual(inspectZip(buildZip([])), []);
    const one = inspectZip(buildZip([{ name: "empty.txt", data: new Uint8Array() }]));
    assert.equal(one[0]!.data.length, 0);
  });
  test("the same input always gives the same bytes, with no clock inside", () => {
    const entries = [{ name: "poster-001.png", data: text("x") }];
    assert.deepEqual(buildZip(entries), buildZip(entries));
    const zip = buildZip(entries);
    assert.equal(zip.readUInt16LE(10), 0); // time
    assert.equal(zip.readUInt16LE(12), 0x21); // 1980-01-01
  });
  test("the layout is the plain one: stored, no flags, no extra fields, no comment, ending on the end record", () => {
    const zip = buildZip([{ name: "a.txt", data: text("hello") }]);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.equal(zip.readUInt16LE(6), 0);
    assert.equal(zip.readUInt16LE(8), 0);
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
    assert.equal(zip.readUInt16LE(zip.length - 2), 0);
    assert.equal(zip.length, 30 + 5 + 5 + 46 + 5 + 22);
  });
  test("a full batch of 50 posters plus a report is fine", () => {
    const entries = [...Array.from({ length: 50 }, (_, i) => ({ name: `poster-${String(i + 1).padStart(3, "0")}.png`, data: text(`p${i}`) })), { name: "report.txt", data: text("r") }];
    assert.equal(inspectZip(buildZip(entries)).length, 51);
  });
});

describe("what the writer refuses", () => {
  test("names that could mean something to an extractor: paths, drives, dots, spaces, control or non-ASCII characters, empty, too long", () => {
    for (const name of ["", "../x.png", "a/b.png", "a\\b.png", "C:x.png", "/abs.png", ".hidden", "..", "a..b.png", "a b.png", "poster\n.png", "café.png", "x".repeat(65), "CON:", "poster-001.png ", "poster-001.png\0"]) {
      throwsZip(() => buildZip([{ name, data: text("x") }]), "name");
      assert.ok(!ZIP_ENTRY_NAME.test(name) || name.includes(".."), JSON.stringify(name));
    }
  });
  test("a repeated name, whatever its case, too many files, and too many bytes", () => {
    throwsZip(() => buildZip([{ name: "a.png", data: text("x") }, { name: "A.PNG", data: text("y") }]), "same name");
    throwsZip(() => buildZip(Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.png`, data: text("x") }))), "too many");
    throwsZip(() => buildZip([{ name: "big.png", data: new Uint8Array(1000) }], { maxBytes: 500 }), "too large");
    assert.ok(buildZip([{ name: "ok.png", data: new Uint8Array(100) }], { maxBytes: 500 }));
  });
});

describe("inspectZip is strict: it refuses anything damaged or unlike this writer's output", () => {
  const good = () => buildZip([{ name: "poster-001.png", data: allBytes() }, { name: "poster-002.png", data: text("second") }]);
  const flip = (zip: Buffer, at: number) => {
    const copy = Buffer.from(zip);
    copy[at] = copy[at]! ^ 0xff;
    return copy;
  };
  test("a flipped data byte is a CRC mismatch", () => throwsZip(() => inspectZip(flip(good(), 30 + 14 + 10)), "CRC"));
  test("a damaged CRC, size, name or signature is refused", () => {
    const zip = good();
    const cdir = zip.readUInt32LE(zip.length - 22 + 16);
    for (const at of [14, 18, 30, 0, cdir, cdir + 16, cdir + 20, cdir + 46, zip.length - 22]) throwsZip(() => inspectZip(flip(zip, at)));
  });
  test("a truncated archive, an archive with bytes added, and nonsense are refused", () => {
    const zip = good();
    throwsZip(() => inspectZip(zip.subarray(0, zip.length - 5)));
    throwsZip(() => inspectZip(Buffer.concat([zip, Buffer.from("x")])));
    throwsZip(() => inspectZip(Buffer.from("not a zip at all, not even close to one")));
    throwsZip(() => inspectZip(new Uint8Array()));
  });
  test("an archive with a comment, a compressed file or an extra field is not one this tool made", () => {
    const withComment = Buffer.from(good());
    withComment.writeUInt16LE(3, withComment.length - 2);
    throwsZip(() => inspectZip(Buffer.concat([withComment, Buffer.from("abc")])));
    const deflated = Buffer.from(good());
    deflated.writeUInt16LE(8, 8);
    throwsZip(() => inspectZip(deflated));
    const extra = Buffer.from(good());
    extra.writeUInt16LE(4, 28);
    throwsZip(() => inspectZip(extra));
  });
  test("a directory entry or a path in the names is refused even if the rest is consistent", () => {
    const zip = Buffer.from(buildZip([{ name: "a.png", data: text("x") }]));
    // rewrite "a.png" as "../.." style names would change lengths; use a same-length name with a slash instead
    const patched = Buffer.from(zip);
    patched.write("a/png", 30, "ascii");
    patched.write("a/png", patched.readUInt32LE(patched.length - 22 + 16) + 46, "ascii");
    throwsZip(() => inspectZip(patched), "name");
  });
});
