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
 * What a voice note may be.
 *
 * Deliberately separate from the upload list, because these are not offered on
 * any attachment field — nobody picks an audio file, a handset records one.
 * The CRM's own dictation never stores audio at all; MBOS does, because the
 * recording is made in a shop with no signal and has to survive until there is
 * some.
 */
export const ACCEPTED_AUDIO_TYPES = [
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/webm",
  "audio/wav",
];

/**
 * Magic numbers, because an extension is trivially renamed and the MIME type
 * the browser reports comes from the same untrusted place. §4.2 requires the
 * check be against actual content.
 */
const SIGNATURES: Array<{ type: string; bytes: number[] }> = [
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  /* Audio. This knew nothing about any of it, so every voice note a salesman
   * recorded came back 415 — "not a file type MahekOne accepts, whatever it is
   * named" — and the handset, correctly, kept the recording and tried again
   * forever. The feature had never worked once. */
  { type: "audio/ogg", bytes: [0x4f, 0x67, 0x67, 0x53] } /* OggS */,
  { type: "audio/webm", bytes: [0x1a, 0x45, 0xdf, 0xa3] } /* EBML, also Matroska */,
  { type: "audio/mpeg", bytes: [0x49, 0x44, 0x33] } /* ID3 */,
  { type: "audio/mpeg", bytes: [0xff, 0xfb] },
  { type: "audio/mpeg", bytes: [0xff, 0xf3] },
];

/**
 * The containers whose signature does not start at byte zero.
 *
 * MP4 and WAV both name themselves a few bytes in — `ftyp` at offset 4 after a
 * length, `WAVE` at offset 8 after `RIFF` and a size. A prefix match against
 * byte zero can never see either, and MP4 is what both iOS and Android record
 * into, which makes it the one that matters most here.
 */
const OFFSET_SIGNATURES: Array<{ type: string; at: number; bytes: number[] }> = [
  { type: "audio/mp4", at: 4, bytes: [0x66, 0x74, 0x79, 0x70] } /* ftyp */,
  { type: "audio/wav", at: 8, bytes: [0x57, 0x41, 0x56, 0x45] } /* WAVE */,
];

/**
 * The real type of these bytes, or null if it is none we accept. Never trust
 * the caller's claim — a .jpg carrying a zip is the case this exists for.
 */
export function sniffContentType(bytes: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    if (sig.bytes.every((b, i) => bytes[i] === b)) return sig.type;
  }
  for (const sig of OFFSET_SIGNATURES) {
    if (sig.bytes.every((b, i) => bytes[sig.at + i] === b)) return sig.type;
  }
  return null;
}
