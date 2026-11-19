import "server-only";
import sharp from "sharp";

/* ---------------------------------------------------------------------------
 * LOCAL PREVIEW PICTURES — generic, drawn on the fly, labelled as samples.
 *
 * The Inbox's poster picker, while the local preview is on, offers THESE
 * instead of anything from the local database — so no real customer's name
 * appears beside invented ones. They are plain generated pictures: nothing is
 * stored, nothing is a customer's, and they exist only to be looked at.
 * Served by /api/studio/inbox/preview-asset, which answers 404 unless the
 * preview gate is open.
 * ------------------------------------------------------------------------- */

export type PreviewAsset = { id: string; title: string; sub: string; caption: string; color: string; kind: "poster" | "forward" };

const NOT_REAL = "(Local preview — not a real message.)";

export const PREVIEW_ASSETS: PreviewAsset[] = [
  { id: "pvp-1", kind: "poster", title: "Sample festive poster", sub: "Preview poster · English", caption: `Sample caption: warm festive wishes from Mahek Marketing. ${NOT_REAL}`, color: "#d97706" },
  { id: "pvp-2", kind: "poster", title: "Sample offer poster", sub: "Preview poster · English", caption: `Sample caption: this month's offer on thinners and primers. ${NOT_REAL}`, color: "#0f766e" },
  { id: "pvp-3", kind: "poster", title: "Sample new-product poster", sub: "Preview poster · Hindi", caption: `Sample caption: a new product is here. ${NOT_REAL}`, color: "#7c3aed" },
  { id: "pvf-1", kind: "forward", title: "Sample uploaded picture A", sub: "Preview upload", caption: `Sample caption for an uploaded picture. ${NOT_REAL}`, color: "#be123c" },
  { id: "pvf-2", kind: "forward", title: "Sample uploaded picture B", sub: "Preview upload", caption: "", color: "#1d4ed8" },
];

export const isPreviewAsset = (id: unknown): id is string => typeof id === "string" && PREVIEW_ASSETS.some((a) => a.id === id);
export const previewAssetsOf = (kind: "poster" | "forward") => PREVIEW_ASSETS.filter((a) => a.kind === kind);
export const previewAssetOf = (id: string) => PREVIEW_ASSETS.find((a) => a.id === id) ?? null;

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const drawn = new Map<string, Buffer>();

export async function previewAssetPng(id: string): Promise<Buffer | null> {
  const a = previewAssetOf(id);
  if (!a) return null;
  const hit = drawn.get(id);
  if (hit) return hit;
  const text = (y: number, size: number, body: string, extra = "") => `<text x="450" y="${y}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${size}" fill="#ffffff" ${extra}>${esc(body)}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">
    <rect width="900" height="1200" fill="${a.color}"/>
    <rect x="40" y="40" width="820" height="1120" rx="28" fill="none" stroke="#ffffff" stroke-width="6" stroke-dasharray="26 18" opacity="0.85"/>
    ${text(300, 64, "LOCAL PREVIEW", 'font-weight="700"')}
    ${text(380, 64, "SAMPLE POSTER", 'font-weight="700"')}
    ${text(640, 54, a.title)}
    ${text(720, 36, "Generic picture, not a customer's", 'opacity="0.9"')}
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  drawn.set(id, png);
  return png;
}
