import { requireOptionalNativeModule } from 'expo';

/**
 * The bridge, and nothing else — the same split `modules/phone-setup` makes.
 * Screens import `src/native/pdf-preview.ts`, which never rejects and knows
 * what to do on a build that has no native half.
 *
 * `requireOptionalNativeModule` because this arrives in a new APK and
 * sideloading has no staged rollout: an older build in somebody's pocket has
 * no `MbosPdfPreview`, and the library has to go on opening files there.
 */

export type RenderedPage = { uri: string; width: number; height: number };

export type NativePdfPreviewModule = {
  pageCount(uri: string): Promise<number>;
  renderPage(uri: string, index: number, widthPx: number): Promise<RenderedPage>;
};

/** `null` on iOS, on web, and on any build that predates the module. */
export const PdfPreview = requireOptionalNativeModule<NativePdfPreviewModule>('MbosPdfPreview');
