// Text normalization for values that come from outside (lead fields, wording).
// Rules from the Blueprint: Unicode NFC, collapse whitespace, strip control characters, and never
// alter the script. ZWJ (U+200D) and ZWNJ (U+200C) are kept because they change Indic shaping.

// C0/C1 control characters except tab and newline (handled as whitespace below).
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Zero-width and bidi marks that carry no meaning in a name, but NOT ZWJ/ZWNJ.
const INVISIBLE = /[\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}\u{FEFF}]/gu;

export function normalizeText(input: string): string {
  return input
    .normalize("NFC")
    .replace(CONTROL, "")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
}

// First whitespace-separated word of a name (used by wording placeholders like {contact}).
export function firstWord(input: string): string {
  return normalizeText(input).split(" ")[0] ?? "";
}

// Up to two initials for an avatar, from the first letters of the first two words.
export function initials(name: string): string {
  const words = normalizeText(name).split(" ").filter(Boolean);
  return Array.from(words.slice(0, 2).map((w) => Array.from(w)[0] ?? "").join("")).slice(0, 2).join("").toUpperCase();
}
