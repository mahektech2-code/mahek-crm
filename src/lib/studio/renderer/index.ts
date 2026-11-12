import { composeCreative } from "./compose";
import { isRenderError, RenderError } from "./errors";
import type { RenderInput, RenderResult } from "./types";

export { RenderError, isRenderError } from "./errors";
export type { RenderErrorCode } from "./errors";
export type * from "./types";

/**
 * Turns an approved template and already-resolved values into an image.
 *
 * Pure in the sense that matters: the same inputs give the same bytes (on the same machine and
 * fonts), it reads only the template, asset and font files it is handed, and it either returns a
 * complete image or throws a typed RenderError. It never returns a half-drawn image.
 */
export async function renderCreative(input: RenderInput): Promise<RenderResult> {
  try {
    return await composeCreative(input);
  } catch (e) {
    if (isRenderError(e)) throw e;
    throw new RenderError("RenderFailed", `rendering failed: ${(e as Error).message}`, undefined, { cause: e });
  }
}
