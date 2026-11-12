import type { Language } from "@/lib/studio/domain/language";
import type { Template } from "@/lib/studio/domain/template";

// The renderer's public contract. It receives finished values and local files, and returns an
// image. It knows nothing about leads, the CRM, AI, HTTP or the UI.

/** A finished value for a field: text (with an optional short form), or a local image file. */
export type RenderValue = { text: string; short?: string } | { assetPath: string };

export type RendererFontFamily = {
  /** The family name as the text engine (Pango) knows it. */
  family: string;
  /** weight ("400", "700") -> absolute path of the font file */
  paths: Readonly<Record<string, string>>;
};
export type RendererFonts = ReadonlyMap<string, RendererFontFamily>;

export type RenderTemplate = {
  manifest: Template;
  /** Absolute path of the template folder (layers are relative to it). */
  dir: string;
  /** Absolute path of the text-free background art. */
  backgroundPath: string;
};

export type OutputFormat = "png" | "jpeg";

export type RenderInput = {
  template: RenderTemplate;
  /** Field key -> finished value. A missing or null value means the field is not drawn. */
  values: Readonly<Record<string, RenderValue | null | undefined>>;
  language: Language;
  fonts: RendererFonts;
  format?: OutputFormat;
  /** 1 to 100. Used for JPEG; lowered automatically if the file would be too large. */
  jpegQuality?: number;
  /**
   * Draw a clearly visible SAMPLE strip across the top of the image. The caller decides it on the server, from where
   * the recipient's data came from (never from a request). Off by default, so nothing else changes.
   */
  sampleMark?: boolean;
};

export type FieldStatus = "fits" | "auto-sized" | "shortened" | "placed" | "skipped" | "missing";

export type FieldReport = {
  key: string;
  status: FieldStatus;
  fontSize?: number;
  lines?: number;
  /** The text that was drawn (after fitting and truncation). */
  text?: string;
  note?: string;
};

export type RenderResult = {
  image: Buffer;
  format: OutputFormat;
  width: number;
  height: number;
  report: FieldReport[];
};
