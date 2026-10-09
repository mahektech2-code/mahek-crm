import { Platform } from 'react-native';
import { PdfPreview, type RenderedPage } from '../../modules/pdf-preview';

/**
 * What a screen calls to draw a PDF, and the only file that touches the
 * native half — see `modules/pdf-preview/index.ts`.
 *
 * **Nothing here rejects.** A page that cannot be drawn answers with the
 * sentence to show in its place; a build without the module answers
 * `available: false`, and the viewer offers to open the file elsewhere
 * instead. A PDF viewer that crashed on a locked file would be worse than the
 * "no app opens this" it replaced.
 */

export type { RenderedPage };

/** Whether this build can draw PDFs itself. False on iOS and on APKs before the viewer. */
export const pdfPreviewAvailable = Platform.OS === 'android' && PdfPreview != null;

export type PageCount = { ok: true; pages: number } | { ok: false; reason: string };
export type PageImage = { ok: true; page: RenderedPage } | { ok: false; reason: string };

export async function pdfPageCount(uri: string): Promise<PageCount> {
  if (!PdfPreview) return { ok: false, reason: 'This version of the app cannot show PDFs itself.' };
  try {
    const pages = await PdfPreview.pageCount(uri);
    return pages > 0 ? { ok: true, pages } : { ok: false, reason: 'This PDF has no pages.' };
  } catch (e) {
    return { ok: false, reason: messageOf(e) };
  }
}

export async function renderPdfPage(uri: string, index: number, widthPx: number): Promise<PageImage> {
  if (!PdfPreview) return { ok: false, reason: 'This version of the app cannot show PDFs itself.' };
  try {
    return { ok: true, page: await PdfPreview.renderPage(uri, index, Math.round(widthPx)) };
  } catch (e) {
    return { ok: false, reason: messageOf(e) };
  }
}

/* Keyed on the module's CODE, not its message: Expo wraps a native rejection
   in "Call to function … has been rejected → Caused by: …", which is not a
   sentence for the person holding the phone. */
const REASONS: Record<string, string> = {
  ERR_UNREADABLE: 'This PDF cannot be shown here — it may be locked with a password. Open it in another app.',
  ERR_FILE: 'The file is no longer on this phone. Download it again.',
  ERR_PAGE: 'That page is not in this file.',
};

function messageOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return (typeof code === 'string' && REASONS[code]) || 'This page could not be drawn.';
}
