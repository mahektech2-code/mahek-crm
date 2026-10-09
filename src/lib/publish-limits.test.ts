import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { PUBLISH_MAX_BYTES, PUBLISH_MAX_MB, tooLargeMessage } from "./publish-limits";
import { MAX_EDGE, shrinkPdf, type JpegReencoder } from "./pdf-shrink";

/* ---------------------------------------------------------------------------
 * The ceiling, and the proxy buffer that has to sit above it.
 *
 * Two numbers in two files, joined only at runtime: if the proxy buffer falls
 * below the limit, an upload the screen allowed arrives truncated and the route
 * cannot even tell — which is the bug this file exists after.
 * ------------------------------------------------------------------------- */

test("the proxy buffers more than the publishing limit, with room for the framing", () => {
  const config = readFileSync("next.config.ts", "utf8");
  const match = config.match(/proxyClientMaxBodySize:\s*"(\d+)mb"/);
  assert.ok(match, "next.config.ts must set experimental.proxyClientMaxBodySize in mb");
  const bufferMb = Number(match[1]);
  assert.ok(bufferMb >= PUBLISH_MAX_MB + 1, `buffer ${bufferMb} MB must exceed the ${PUBLISH_MAX_MB} MB limit`);
});

test("the refusal names the file, its size and the limit, and says whether compressing was tried", () => {
  const before = tooLargeMessage("catalogue.pdf", 41 * 1024 * 1024, false);
  assert.match(before, /catalogue\.pdf is 41\.0 MB\. The limit is 30 MB\./);
  assert.doesNotMatch(before, /compress/);
  const after = tooLargeMessage("catalogue.pdf", 34.5 * 1024 * 1024, true);
  assert.match(after, /34\.5 MB\. The limit is 30 MB\. It is still that size after compressing/);
  assert.equal(PUBLISH_MAX_BYTES, 30 * 1024 * 1024);
});

/* ---------------------------------------------------------------------------
 * What the compressor touches, and what it must leave alone.
 *
 * The browser's encoder is a canvas; this one is sharp, writing three channels
 * exactly as a canvas does, so the rule under test — which images are
 * re-encoded — is the one the browser runs.
 * ------------------------------------------------------------------------- */

const sharpReencoder: JpegReencoder = async (jpeg, maxEdge, quality) => {
  const out = await sharp(Buffer.from(jpeg))
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .jpeg({ quality: Math.round(quality * 100) })
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(out.data), width: out.info.width, height: out.info.height };
};

/** A noisy photograph: noise is what a camera produces and what JPEG cannot shrink for free. */
async function photo(width: number, height: number, channels: 1 | 3, quality = 98) {
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels } }).jpeg({ quality }).toBuffer());
}

async function pdfWith(jpegs: Uint8Array[], png?: Uint8Array) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawText("Price list — Odisha, August 2026", { x: 40, y: 800, size: 14 });
  for (const jpeg of jpegs) page.drawImage(await doc.embedJpg(jpeg), { x: 40, y: 100, width: 500, height: 330 });
  if (png) page.drawImage(await doc.embedPng(png), { x: 40, y: 500, width: 200, height: 200 });
  return doc.save();
}

function images(doc: PDFDocument) {
  const found: { filter: string; width: number; colour: string }[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
    found.push({
      filter: String(obj.dict.get(PDFName.of("Filter"))),
      width: Number(String(obj.dict.get(PDFName.of("Width")))),
      colour: String(obj.dict.lookup(PDFName.of("ColorSpace"))),
    });
  }
  return found;
}

test("an oversized photograph is scaled to print resolution and the PDF gets smaller", async () => {
  const input = await pdfWith([await photo(4000, 2600, 3)]);
  const { bytes, imagesReencoded } = await shrinkPdf(input, sharpReencoder);
  assert.equal(imagesReencoded, 1);
  assert.ok(bytes.length < input.length * 0.6, `${bytes.length} should be well under ${input.length}`);
  const out = await PDFDocument.load(bytes);
  assert.equal(out.getPageCount(), 1);
  assert.deepEqual(images(out), [{ filter: "/DCTDecode", width: MAX_EDGE, colour: "/DeviceRGB" }]);
});

test("a grey photograph is restated as RGB, because the encoder writes three channels", async () => {
  const input = await pdfWith([await photo(3600, 2400, 1)]);
  const { bytes, imagesReencoded } = await shrinkPdf(input, sharpReencoder);
  assert.equal(imagesReencoded, 1);
  assert.deepEqual(images(await PDFDocument.load(bytes)), [{ filter: "/DCTDecode", width: MAX_EDGE, colour: "/DeviceRGB" }]);
});

test("a lossless image — a screenshot, a logo — is never touched", async () => {
  const png = new Uint8Array(
    await sharp({ create: { width: 3000, height: 3000, channels: 3, background: "#5223E0" } }).png().toBuffer(),
  );
  const input = await pdfWith([], png);
  const result = await shrinkPdf(input, sharpReencoder);
  assert.equal(result.imagesReencoded, 0);
  assert.equal(result.bytes, input, "nothing to gain hands back the very same bytes");
});

test("a photograph already at a sensible size is left alone rather than re-encoded for nothing", async () => {
  const input = await pdfWith([await photo(1200, 800, 3, 80)]);
  const result = await shrinkPdf(input, sharpReencoder);
  assert.equal(result.imagesReencoded, 0);
  assert.equal(result.bytes, input);
});

test("something that is not a PDF comes back untouched rather than throwing", async () => {
  const junk = new TextEncoder().encode("%PDF-1.7 not really");
  const result = await shrinkPdf(junk, sharpReencoder);
  assert.equal(result.bytes, junk);
});

test("an encoder that fails on one image costs that image, not the document", async () => {
  const input = await pdfWith([await photo(4000, 2600, 3)]);
  const result = await shrinkPdf(input, async () => {
    throw new Error("canvas out of memory");
  });
  assert.equal(result.bytes, input);
});
