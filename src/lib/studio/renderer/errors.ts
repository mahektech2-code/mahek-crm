// Typed renderer errors (RENDERER_SPEC.md section 11). The renderer never returns a half-drawn
// image: it either returns a complete image or throws one of these.
export type RenderErrorCode =
  | "TemplateInvalid"
  | "AssetMissing"
  | "FontMissing"
  | "FieldOverflow"
  | "ValueMissing"
  | "UnsupportedLanguage"
  | "OutputTooLarge"
  | "RenderFailed";

export class RenderError extends Error {
  readonly code: RenderErrorCode;
  /** The field key, asset path, font family or language the error is about. */
  readonly subject: string | undefined;

  constructor(code: RenderErrorCode, message: string, subject?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RenderError";
    this.code = code;
    this.subject = subject;
  }
}

export const isRenderError = (e: unknown): e is RenderError => e instanceof RenderError;
