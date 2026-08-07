import { put, del, get, head } from "@vercel/blob";

/**
 * File storage. Vercel Blob, private — a payment proof or a damaged-goods
 * photograph is commercially sensitive, so nothing is ever written with public
 * access and no URL is guessable. Bytes are read back through
 * `/api/attachments/[id]`, which checks the caller can see the parent record
 * before it hands anything over.
 *
 * The seam stays because the rest of the app should not know which backend it
 * is. Swapping S3 in later means replacing `blobStorage` and nothing else.
 */

export type StoredFile = {
  /** Opaque reference, not a URL the browser can follow. */
  ref: string;
  sizeBytes: number;
};

export interface FileStorage {
  upload(input: {
    key: string;
    body: Buffer | Uint8Array;
    contentType: string;
  }): Promise<StoredFile>;
  read(ref: string): Promise<ArrayBuffer>;
  remove(ref: string): Promise<void>;
  readonly configured: boolean;
}

/**
 * What a complaint photo may be. Declared once, because the complaints dialog
 * and the call panel both filter on it and a picture one screen accepts must
 * not be one the other rejects. This is the browser-side accept hint only —
 * the server decides for real, from the bytes.
 */
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png"];

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

const blobStorage: FileStorage = {
  get configured() {
    return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  },
  async upload({ key, body, contentType }) {
    // Private, not public-with-an-unguessable-name. A payment proof must be
    // unreadable without credentials even to somebody who has the URL — an
    // unguessable public link is still a link that works once it leaks.
    await put(key, Buffer.from(body), {
      access: "private",
      contentType,
      addRandomSuffix: false,
    });
    // The pathname is the reference. A private blob has no URL worth storing,
    // and storing one would invite somebody to serve it directly.
    return { ref: key, sizeBytes: body.byteLength };
  },
  async read(ref) {
    const result = await get(ref, { access: "private" });
    if (!result || result.statusCode !== 200) {
      throw new Error("Attachment could not be read from storage.");
    }
    return new Response(result.stream).arrayBuffer();
  },
  async remove(ref) {
    await del(ref);
  },
};

/**
 * Without a token there is nowhere to put bytes. It fails loudly on upload
 * rather than silently accepting and losing the file — but §4.2 is explicit
 * that a failed upload must never block the save, so callers catch this and
 * carry on.
 */
export const notConfiguredStorage: FileStorage = {
  configured: false,
  async upload() {
    throw new Error(
      "File storage is not configured. Set BLOB_READ_WRITE_TOKEN, or connect a Blob store to the project.",
    );
  },
  async read() {
    throw new Error("File storage is not configured.");
  },
  async remove() {
    /* nothing was ever stored */
  },
};

export const fileStorage: FileStorage = process.env.BLOB_READ_WRITE_TOKEN
  ? blobStorage
  : notConfiguredStorage;

export { head as blobHead };
