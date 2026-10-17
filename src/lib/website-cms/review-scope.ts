import { KINDS, KIND_KEYS, type KindKey } from "./kinds";
import { anyAssignmentCovers, hasKindWideAssignment, type AssignmentLike } from "./review-status";

/* ---------------------------------------------------------------------------
 * WHAT A PERSON IS SHOWN — the read-side twin of `gateEdit`.
 *
 * `gateEdit` refuses an edit by somebody who was not assigned; this decides what
 * they are shown in the first place. They must agree, or a screen offers a thing
 * the server then refuses, or — worse — shows a draft, a name or a count that
 * belongs to somebody else's work. So both read the same rule from
 * `review-status.ts` (`anyAssignmentCovers`, `hasKindWideAssignment`).
 *
 * PURE and client-safe. The server builds a scope once per request
 * (`review-queries.ts`) from the setting, the person's two direct-edit rights and
 * their assignments, and every list, count and entry point filters through it.
 *
 *   everything — assignments are not enforced, or the person holds
 *                `website.publish` / `website.review`: nothing is narrowed.
 * ------------------------------------------------------------------------- */

export type ScopeKind = KindKey | "media";

export type ItemScope = {
  everything: boolean;
  /** Whether this person may see, and so work on, this row. */
  covers: (kind: KindKey, contentId: string) => boolean;
  /** Anything of this kind at all — what makes its screen worth opening. */
  hasKind: (kind: ScopeKind) => boolean;
  /** Every item of the kind, present and future — what creating and reordering need. */
  kindWide: (kind: ScopeKind) => boolean;
};

export function makeScope(input: { enforced: boolean; direct: boolean; assignments: readonly AssignmentLike[] }): ItemScope {
  if (!input.enforced || input.direct) {
    return { everything: true, covers: () => true, hasKind: () => true, kindWide: () => true };
  }
  const mine = input.assignments;
  return {
    everything: false,
    covers: (kind, contentId) => anyAssignmentCovers(mine, { kind, contentId }),
    hasKind: (kind) => mine.some((a) => a.revokedAt === null && a.kind === kind),
    kindWide: (kind) => hasKindWideAssignment(mine, kind),
  };
}

/** The rows of a list this scope may see. Pure, so it is the same filter wherever it is applied. */
export function filterToScope<T extends { id: string; kind: string }>(scope: ItemScope, items: readonly T[]): T[] {
  if (scope.everything) return [...items];
  return items.filter((i) => scope.covers(i.kind as KindKey, i.id));
}

/** The Website module slug → the assignable kind it edits. `media` has no content kind of its own. */
export const SLUG_KIND: Record<string, ScopeKind> = {
  ...Object.fromEntries(KIND_KEYS.map((k) => [KINDS[k].moduleSlug, k])),
  media: "media",
};

/** Whether a module's screen is worth showing this person. The dashboard and anything unknown always are. */
export function slugVisible(scope: ItemScope, slug: string): boolean {
  const kind = SLUG_KIND[slug];
  return kind === undefined ? true : scope.hasKind(kind);
}
