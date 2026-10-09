/* ---------------------------------------------------------------------------
 * What the Website app says about itself until it has a backend.
 *
 * Every screen here edits an in-memory copy of `mock-data.ts`. Nothing is
 * written to a database and nothing reaches the public site, and a change is
 * gone the moment the person leaves the screen. A toast reading "Settings
 * saved." or "Photo uploaded." said the opposite, so action feedback is built
 * here, in one place, from the action alone: `tempFeedback("Product added")`.
 *
 * PURE and client-safe, like `seat-labels`, so the banner, the toasts and the
 * test that guards both read the same sentence.
 * ------------------------------------------------------------------------- */

/** The one sentence every screen and every toast uses. */
export const PROTOTYPE_NOTE = "Prototype only — changes are temporary and will not persist.";

/** What happened, then the note: "Product added. Prototype only — …". */
export function tempFeedback(what: string): string {
  return `${what.replace(/[.\s]+$/, "")}. ${PROTOTYPE_NOTE}`;
}
