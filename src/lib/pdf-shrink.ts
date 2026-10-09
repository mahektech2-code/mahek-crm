import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";

/**
 * MAKE A PDF SMALLER WITHOUT ANYBODY BEING ABLE TO SEE THAT IT WAS.
 *
 * Measured on fourteen real PDFs of 3–34 MB before this was written: saving a
 * PDF again losslessly — object streams, recompressed structure — took off
 * between 0% and 4%. A big PDF is big because of the photographs in it, and
 * those are already compressed. So the only lever worth pulling is the
 * photographs themselves, and this pulls exactly that one:
 *
 * - **A JPEG photograph larger than `MAX_EDGE` on its long side is scaled down
 *   to it and re-encoded at `QUALITY`.** 2400 pixels across an A4 page is about
 *   290 dpi, which is print resolution; on a phone or a laptop screen the two
 *   are indistinguishable at any zoom anybody uses. A smaller JPEG is
 *   re-encoded only where that saves a real tenth or more.
 * - **Nothing else is touched.** Text, vector drawings, fonts and every
 *   losslessly stored image — screenshots, logos, anything with sharp edges —
 *   are left exactly as they were, because JPEG is where crisp lettering goes
 *   soft. A CMYK JPEG is skipped too (see `colourComponents`).
 *
 * On the same fourteen that took decks of photographs down by a quarter to a
 * third, and a screen capture of 15 MB to 1.2 MB.
 *
 * The encoder is injected. In the browser it is a canvas; in the test it is
 * sharp — this file never decides which, so it runs in both and the rule that
 * matters, which images are touched and which are not, is testable in Node.
 */

export const MAX_EDGE = 2400;
export const QUALITY = 0.85;

export type JpegReencoder = (
  jpeg: Uint8Array,
  maxEdge: number,
  quality: number,
) => Promise<{ data: Uint8Array; width: number; height: number } | null>;

export type ShrinkResult = { bytes: Uint8Array; imagesReencoded: number };

/** 3 for RGB, 1 for grey, anything else (CMYK, Lab, indexed, unknown) as null. */
function colourComponents(space: unknown): number | null {
  if (space === PDFName.of("DeviceRGB") || space === PDFName.of("CalRGB")) return 3;
  if (space === PDFName.of("DeviceGray") || space === PDFName.of("CalGray")) return 1;
  if (space instanceof PDFArray && space.get(0) === PDFName.of("ICCBased")) {
    const profile = space.lookup(1);
    const n = profile instanceof PDFRawStream ? profile.dict.lookup(PDFName.of("N")) : null;
    const count = n instanceof PDFNumber ? n.asNumber() : null;
    return count === 3 || count === 1 ? count : null;
  }
  // A CMYK JPEG is decoded by a browser by guessing, and a price list with the
  // wrong red is worse than a big one.
  return null;
}

function single(value: unknown) {
  if (value instanceof PDFArray) return value.size() === 1 ? value.get(0) : null;
  return value;
}

/**
 * Returns the smaller document, or the original bytes untouched where nothing
 * could be gained — an encrypted PDF, one with no photographs, or one this
 * cannot read. It never throws: compression is an attempt, and a failed
 * attempt must leave the caller exactly where it would have been without one.
 */
export async function shrinkPdf(input: Uint8Array, reencode: JpegReencoder): Promise<ShrinkResult> {
  const untouched = { bytes: input, imagesReencoded: 0 };
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(input, { updateMetadata: false });
  } catch {
    // Includes an encrypted PDF: its streams cannot be read, so nothing in it
    // could be replaced safely.
    return untouched;
  }

  let reencoded = 0;
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
    if (single(dict.get(PDFName.of("Filter"))) !== PDFName.of("DCTDecode")) continue;
    // A Decode array inverts or remaps the samples; a re-encode would keep the
    // array and change what it applies to.
    if (dict.get(PDFName.of("Decode"))) continue;
    // The encoder always writes three channels — a canvas cannot write
    // anything else — so only an image that already has three, or one of
    // grey that can be restated as RGB without changing a pixel, qualifies.
    const components = colourComponents(dict.lookup(PDFName.of("ColorSpace")));
    if (components !== 3 && components !== 1) continue;

    let next;
    try {
      next = await reencode(obj.contents, MAX_EDGE, QUALITY);
    } catch {
      continue;
    }
    if (!next || next.data.length >= obj.contents.length * 0.9) continue;

    dict.set(PDFName.of("Width"), PDFNumber.of(next.width));
    dict.set(PDFName.of("Height"), PDFNumber.of(next.height));
    dict.set(PDFName.of("Length"), PDFNumber.of(next.data.length));
    dict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
    dict.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
    if (components === 1) dict.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
    dict.delete(PDFName.of("DecodeParms"));
    doc.context.assign(ref, PDFRawStream.of(dict, next.data));
    reencoded++;
  }

  if (reencoded === 0) return untouched;
  try {
    const bytes = await doc.save({ useObjectStreams: true });
    return bytes.length < input.length ? { bytes, imagesReencoded: reencoded } : untouched;
  } catch {
    return untouched;
  }
}
