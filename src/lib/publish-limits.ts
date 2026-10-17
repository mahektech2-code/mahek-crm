/**
 * How big a file the Documents library and the Training centre will take.
 *
 * THIRTY MEGABYTES, AND IT IS A CONSTANT RATHER THAN A SETTING ON PURPOSE.
 * Every request passes through `src/proxy.ts`, and Next buffers a proxied body
 * only up to `experimental.proxyClientMaxBodySize` in `next.config.ts` — past
 * it the route is handed the first N bytes and nothing says so, which is how a
 * 12 MB price list read as "the file did not arrive whole". That ceiling is
 * fixed at build time, so a setting a manager could raise on a screen would be
 * a number the next upload silently disobeyed. Raising this means raising both,
 * in one commit; `publish-limits.test.ts` holds them together.
 *
 * It is NOT `attachments.maxSizeMb`. That one is five megabytes because it is
 * sized for a phone photograph of a damaged can, and widening it for a
 * catalogue would widen it for every complaint photograph and every cheque.
 *
 * Pure and client-safe: the picker reads it to decide whether to compress
 * before sending, and the route reads it to refuse what still does not fit.
 */
export const PUBLISH_MAX_MB = 30;
export const PUBLISH_MAX_BYTES = PUBLISH_MAX_MB * 1024 * 1024;

export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The refusal, said once. It names the file, its size and the limit, and —
 * where compression was tried — that it was, so nobody compresses it by hand
 * and sends exactly the same bytes back.
 */
export function tooLargeMessage(filename: string, bytes: number, triedCompressing: boolean): string {
  const base = `${filename} is ${megabytes(bytes)}. The limit is ${PUBLISH_MAX_MB} MB.`;
  return triedCompressing
    ? `${base} It is still that size after compressing its photographs — split it into parts, or export it again at a lower resolution.`
    : `${base} Split it into parts, or export it again at a lower resolution.`;
}

/**
 * PDF AND PICTURES, AND NOTHING ELSE — because the phone has to draw it.
 *
 * The handset previews a document inside the app, with no other app and no
 * signal, and it can draw two things: a PDF's pages and a photograph. Android
 * has no renderer for Word, PowerPoint or Excel, so a .docx published to the
 * field is a row a salesman taps and cannot read. The office can make the PDF
 * in two clicks, and is the only one who can; this says how, at the moment it
 * matters, instead of the generic "not a JPG, PNG or PDF".
 */
const OFFICE: Record<string, string> = {
  doc: "Word", docx: "Word", rtf: "Word", odt: "Word",
  ppt: "PowerPoint", pptx: "PowerPoint", pps: "PowerPoint", ppsx: "PowerPoint", odp: "PowerPoint",
  xls: "Excel", xlsx: "Excel", csv: "Excel", ods: "Excel",
};

export function officeFileRefusal(filename: string): string | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const app = ext ? OFFICE[ext] : undefined;
  if (!app) return null;
  return `${filename} is a ${app} file, and phones can only show PDFs and pictures. In ${app}, use File → Save as → PDF, and choose that file instead.`;
}
