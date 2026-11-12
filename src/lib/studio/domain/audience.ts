import { z } from "zod";
import { recipientKindSchema, type RecipientKind } from "./recipient";

// Who a design is for (CUSTOMER_FEATURE_BLUEPRINT.md section 7.2). A template declares `audiences`:
//   ["lead"]              lead-only
//   ["customer"]          customer-only
//   ["lead", "customer"]  shared
// Declaring it is the rule. A manifest written before customers existed has no `audiences`; it is
// read as ["lead"], which is the one value that keeps today's behaviour (lead was the only audience)
// and means a design can never reach customers merely by being loaded. The template validator warns
// about it, and `npm run validate-templates` fails it once the migration is done.

export const audiencesSchema = z
  .array(recipientKindSchema)
  .min(1, "declare at least one audience")
  .refine((a) => new Set(a).size === a.length, "duplicate audience");
export type Audiences = z.infer<typeof audiencesSchema>;

/** The compatibility default for a manifest with no `audiences`. */
export const LEGACY_AUDIENCES: readonly RecipientKind[] = ["lead"];

export type HasAudiences = { audiences?: readonly RecipientKind[] | undefined };

/** The audiences of a design or of one wording: what it declares, or the compatibility default. */
export function effectiveAudiences(subject: HasAudiences): readonly RecipientKind[] {
  return subject.audiences ?? LEGACY_AUDIENCES;
}

/** Is this design (or wording) for this kind of recipient? */
export function offersTo(subject: HasAudiences, kind: RecipientKind): boolean {
  return effectiveAudiences(subject).includes(kind);
}

/** True when the design declares its audiences itself instead of relying on the compatibility default. */
export const declaresAudiences = (subject: HasAudiences): boolean => subject.audiences !== undefined;
