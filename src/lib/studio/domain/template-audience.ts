import { effectiveAudiences, offersTo, type HasAudiences } from "./audience";
import type { Copy, CopyOption } from "./copy";
import type { Language } from "./language";
import type { RecipientKind } from "./recipient";

// What a design offers to one kind of recipient: which wording lines and so which languages. Pure.
// A wording line may NARROW the design's audiences (it can never widen them); a line with no
// `audiences` of its own inherits the design's.

type Design = HasAudiences & { languages: readonly Language[]; fields: readonly { type: string; source?: string }[] };

/** The wording lines of one language that are cleared for this kind of recipient. */
export function wordingForAudience(design: HasAudiences, options: readonly CopyOption[], kind: RecipientKind): CopyOption[] {
  if (!offersTo(design, kind)) return [];
  return options.filter((o) => offersTo({ audiences: o.audiences ?? effectiveAudiences(design) }, kind));
}

/**
 * The languages a design can be made in for this kind of recipient: a language it offers, with at
 * least one wording line cleared for that kind. A design with no greeting field needs no wording, so
 * all its languages are available. This lets a shared design offer customers English now and add
 * Hindi and Gujarati when that wording is cleared, by content change only.
 */
export function languagesForAudience(design: Design, copy: Copy, kind: RecipientKind): Language[] {
  if (!offersTo(design, kind)) return [];
  const needsWording = design.fields.some((f) => f.type === "text" && f.source === "copy");
  if (!needsWording) return [...design.languages];
  return design.languages.filter((lang) => wordingForAudience(design, copy[lang] ?? [], kind).length > 0);
}
