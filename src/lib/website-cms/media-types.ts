/* ---------------------------------------------------------------------------
 * WHAT A WEBSITE IMAGE MAY BE — the pure half of the media rules.
 *
 * Decided from the BYTES, never the file name or what the browser claimed, the
 * way `lib/file-types.ts` does for attachments. That file does not know WebP —
 * which is what almost every image on mahekindia.com is — and widening it would
 * change what every attachment field in the CRM accepts, so the website's own
 * list lives here.
 *
 * SVG is deliberately NOT accepted: an SVG can carry script, and these files
 * are served to the public from a trusted origin's proxy.
 * ------------------------------------------------------------------------- */

export const WEBSITE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type WebsiteImageType = (typeof WEBSITE_IMAGE_TYPES)[number];

/** Large enough for a good product photograph, small enough that a page stays quick. */
export const WEBSITE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

const EXTENSION: Record<WebsiteImageType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** The image type the bytes actually are, or null. */
export function sniffWebsiteImage(bytes: Uint8Array): WebsiteImageType | null {
  if (bytes.length < 12) return null;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"; // GIF8
  return null;
}

export type ImageCheck =
  | { ok: true; type: WebsiteImageType }
  | { ok: false; error: string };

export function checkWebsiteImage(filename: string, bytes: Uint8Array): ImageCheck {
  if (bytes.byteLength === 0) return { ok: false, error: `${filename} is empty.` };
  if (bytes.byteLength > WEBSITE_IMAGE_MAX_BYTES) {
    const mb = (bytes.byteLength / (1024 * 1024)).toFixed(1);
    return { ok: false, error: `${filename} is ${mb} MB. The limit is ${WEBSITE_IMAGE_MAX_BYTES / (1024 * 1024)} MB.` };
  }
  const type = sniffWebsiteImage(bytes);
  if (!type) return { ok: false, error: `${filename} is not a JPG, PNG, WebP or GIF image, whatever it is named.` };
  return { ok: true, type };
}

/**
 * A file name safe to put in a URL: lower-case, letters, digits, dot, hyphen,
 * with the extension taken from the TRUE type rather than whatever was typed.
 */
export function safeMediaFilename(original: string, type: WebsiteImageType): string {
  const stem = original
    .replace(/\.[^.\\/]*$/, "")
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return `${stem || "image"}.${EXTENSION[type]}`;
}

/** Where a stored file is served on the PUBLIC site (a proxy to the CRM). */
export function mediaPublicPath(id: string, filename: string): string {
  return `/cms-media/${id}/${encodeURIComponent(filename)}`;
}

const MEDIA_PATH = /\/cms-media\/([A-Za-z0-9_-]{8,64})\//g;

/** Every uploaded file a piece of content points at — what stops a used file being deleted. */
export function mediaIdsIn(value: unknown): string[] {
  const found = new Set<string>();
  const json = typeof value === "string" ? value : JSON.stringify(value ?? null);
  for (const m of json.matchAll(MEDIA_PATH)) found.add(m[1]);
  return [...found];
}

export function isMediaId(v: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/.test(v);
}
