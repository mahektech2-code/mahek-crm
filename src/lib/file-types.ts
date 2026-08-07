/**
 * What a file may be — the pure half of the storage rules.
 *
 * Deliberately free of any backend import, because both the browser and the
 * server need these. The picker uses the accept list to filter what a
 * telecaller can choose; the server uses the signatures to decide the truth.
 * Keeping them in one file is what stops the two disagreeing.
 */

/**
 * The browser-side accept hint. It must not offer more than the server takes:
 * WebP was listed here once while `sniffContentType` knew nothing about it, so
 * a telecaller could pick a file the picker accepted and the save refused.
 */
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png"];

/** Everything an attachment field accepts, images plus documents. */
export const ACCEPTED_UPLOAD_TYPES = [...ACCEPTED_IMAGE_TYPES, "application/pdf"];

/**
 * Magic numbers, because an extension is trivially renamed and the MIME type
 * the browser reports comes from the same untrusted place. §4.2 requires the
 * check be against actual content.
 */
const SIGNATURES: Array<{ type: string; bytes: number[] }> = [
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
];

/**
 * The real type of these bytes, or null if it is none we accept. Never trust
 * the caller's claim — a .jpg carrying a zip is the case this exists for.
 */
export function sniffContentType(bytes: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    if (sig.bytes.every((b, i) => bytes[i] === b)) return sig.type;
  }
  return null;
}
