import { z } from "zod";

// Languages the renderer can draw. Which of them a template offers depends on its approved
// wording (a template's `languages`). Marathi renders (Phase 0) but has no approved wording yet.
export const LANGUAGES = ["en", "hi", "mr", "gu"] as const;
export const languageSchema = z.enum(LANGUAGES);
export type Language = z.infer<typeof languageSchema>;

export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  hi: "हिन्दी",
  mr: "मराठी",
  gu: "ગુજરાતી",
};

export type Script = "latin" | "devanagari" | "gujarati";

export const LANGUAGE_SCRIPT: Record<Language, Script> = {
  en: "latin",
  hi: "devanagari",
  mr: "devanagari",
  gu: "gujarati",
};
