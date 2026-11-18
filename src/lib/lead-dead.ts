/* ---------------------------------------------------------------------------
 * DEAD LEADS — the vocabulary and the eligibility rule. PURE and CLIENT-SAFE.
 *
 * Dead is a permanent SUBSET of Lost: `lead_stage` stays `lost` and a separate
 * marker (`customers.lead_dead_at`) says nothing can happen to it any more.
 * This file is what the menus, the dialog and the server all read, so the
 * disabled "Mark as Dead" on a live lead and the refusal the server gives a
 * forged request are the same sentence from the same function.
 * ------------------------------------------------------------------------- */

/**
 * WHY A LOST LEAD IS BEING MARKED DEAD — the permanent end.
 *
 * Dead is a subset of Lost that nothing can reverse, so the reason is asked for
 * the way every other closing reason is: a code, so "how many did we write off
 * for no response" is a count and not a grep. The list is configuration
 * (`leads.deadReasons`); `other` makes the note mandatory.
 *
 * Kept HERE and not beside the other reason lists in `lead-labels.ts`, because
 * that file is mirrored byte for byte onto the handset and Dead Leads is an
 * office-only workflow: nothing on a phone asks, shows or sends this list.
 */
export const DEAD_REASONS: readonly { code: string; label: string }[] = [
  { code: "no_response", label: "No response after repeated attempts" },
  { code: "not_interested", label: "Customer is permanently not interested" },
  { code: "business_closed", label: "Business closed or no longer exists" },
  { code: "wrong_contact", label: "Wrong or unreachable contact, cannot be traced" },
  { code: "duplicate_or_invalid", label: "Duplicate or invalid lead" },
  { code: "other", label: "Other" },
] as const;

/** What the database stores in `lead_dead_requests.state`. */
export const DEAD_REQUEST_STATES = ["pending", "approved", "rejected", "withdrawn"] as const;
export type DeadRequestState = (typeof DEAD_REQUEST_STATES)[number];

/** The Postgres error codes the triggers in migration 0189 raise with. */
export const DEAD_ERROR_CODE = "DL001";
export const DEAD_PENDING_ERROR_CODE = "DL002";
export const DEAD_REQUEST_ERROR_CODE = "DL003";

export const DEAD_REFUSAL =
  "This lead is permanently Dead and read-only. It can be viewed, but nothing on it can be changed, reassigned, reopened, converted or added to.";

export const DEAD_PENDING_REFUSAL =
  "A request to mark this lead Dead is waiting on its manager, so it cannot be reversed until that is decided.";

/** What the lead looks like to the eligibility rule. */
export type DeadFacts = {
  /** `customers.lead_stage`. */
  stage: string | null;
  /** `customers.lead_dead_at` — truthy means permanently Dead. */
  deadAt: Date | string | null;
  /** Is there a pending request for it? */
  pending: boolean;
};

export type DeadOffer =
  | { offer: true }
  | { offer: false; reason: string; /** Draw the item at all? False only when it is already Dead. */ show: boolean };

/**
 * May a "Mark as Dead" request be raised about this lead?
 *
 * The menu draws the item on every lead and DISABLES it with `reason`; the
 * server asks the same function, because a menu is not a permission.
 */
export function deadRequestEligibility(f: DeadFacts): DeadOffer {
  if (f.deadAt) {
    return { offer: false, show: false, reason: "This lead is already permanently Dead." };
  }
  if (f.stage !== "lost") {
    return {
      offer: false,
      show: true,
      reason: "Only a lead that is already Lost can be marked Dead. Close it as Lost first.",
    };
  }
  if (f.pending) {
    return {
      offer: false,
      show: true,
      reason: "A request to mark this lead Dead is already waiting on its manager.",
    };
  }
  return { offer: true };
}

/** One word for a Lost-list or record badge. */
export function deadBadge(f: Pick<DeadFacts, "deadAt" | "pending">): "dead" | "pending" | null {
  if (f.deadAt) return "dead";
  if (f.pending) return "pending";
  return null;
}

export const DEAD_REQUEST_STATE_LABEL: Record<DeadRequestState, string> = {
  pending: "Awaiting manager",
  approved: "Approved — Dead",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};
