import { z } from "zod";

/* ---------------------------------------------------------------------------
 * A QUESTION ASKED BY VOICE IS ANSWERED IN THE LANGUAGE IT WAS ASKED IN.
 *
 * Every Ask AI drawer carries the same microphone the telecallers dictate
 * notes with (`components/ui/dictate.tsx`): it hears any language and writes
 * faithful English. The English is what the assistant READS — it is what the
 * tools, the SQL and the documentation search are good at, and what the
 * answer cache is keyed on. But the person who asked in Marathi because they
 * do not read English gains nothing from an English answer, so what they
 * actually said rides along beside it, and the model is told to write back
 * in that language.
 *
 * Pure and client-safe: the drawers build the payload with `voiceSchema`'s
 * shape and the four ask services turn it into one instruction.
 * ------------------------------------------------------------------------- */

export const voiceSchema = z
  .object({
    /** What was heard, in the language it was spoken in. */
    spoken: z.string().trim().max(2000),
    /** The provider's language tag — "hi-IN" from Sarvam, "hindi" from OpenAI — or null. */
    language: z.string().trim().max(40).nullish(),
  })
  .nullish();

export type AskVoice = { spoken: string; language?: string | null };

/** "hi-IN" → "Hindi", "marathi" → "Marathi", nonsense → null. */
export function languageName(tag: string | null | undefined): string | null {
  const t = tag?.trim();
  if (!t) return null;
  if (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/i.test(t) && !/^[a-z]{4,}$/i.test(t)) {
    try {
      const name = new Intl.DisplayNames(["en"], { type: "language" }).of(t.split("-")[0].toLowerCase());
      if (name && name.toLowerCase() !== t.toLowerCase()) return name;
    } catch {
      /* not a tag after all */
    }
  }
  if (!/^[a-z][a-z ]{2,30}$/i.test(t)) return null;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/**
 * The instruction appended to a spoken question, or "" for a typed one and
 * for English speech — the model already answers English in English.
 */
export function answerLanguageNote(voice: AskVoice | null | undefined): string {
  const spoken = voice?.spoken?.trim();
  if (!spoken) return "";
  const name = languageName(voice?.language);
  if (name && /^english$/i.test(name)) return "";
  const lang = name ?? "the language they spoke";
  return [
    "",
    "---",
    "This question was ASKED BY VOICE. The English above is a translation; what the person actually said was:",
    `«${spoken.slice(0, 2000)}»`,
    `Write your whole answer in ${lang} — the language they spoke — in the script ${name ? "it" : "that language"} is normally written in, not in English. They may not read English.`,
    "If they mixed English words into their speech, you may use the same everyday English words (product names, 'bill', 'order', 'stock').",
    "Keep every figure, ₹ amount, date, bill or order number, and customer, product and person name exactly as the records give them.",
  ].join("\n");
}

/** What a cached answer is keyed on beside the question: the answer's language. */
export function answerLanguageKey(voice: AskVoice | null | undefined): string {
  if (!answerLanguageNote(voice)) return "";
  return `|lang:${(languageName(voice?.language) ?? voice?.spoken ?? "").toLowerCase()}`;
}
