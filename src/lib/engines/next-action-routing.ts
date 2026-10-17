/* ---------------------------------------------------------------------------
 * WHO A NEXT ACTION IS FOR.
 *
 * Every next action on a call used to become a reminder assigned to whoever
 * logged the call — including "Salesman visit", "Contact logistics" and
 * "Escalate", which the telecaller cannot do and nobody else was told about. A
 * dropdown that produced a note on the wrong person's list.
 *
 * This reads the seats an account ALREADY has and nothing else: the person it
 * answers to for sales (`assignedUserId`, the one definition of whose book a
 * customer is in), the back office person who works its dispatch and paperwork
 * — which is what "logistics" means in this product, there being no such role —
 * and the sales manager above the salesperson. No user is named anywhere in
 * code, and no second assignment system is introduced: a reminder already
 * carries `assigned_user_id`, and the Command Centre's quick-log already
 * assigns one to somebody else.
 *
 * WHERE A SEAT IS EMPTY THE ACTION STAYS WITH THE PERSON WHO LOGGED THE CALL,
 * and the result says so. Quietly moving it to a guess would put a job on a
 * stranger; quietly keeping it with no sentence would look like it had been
 * routed. Naming the fall-back is what turns the gap into something somebody
 * can fix.
 *
 * What is NOT routed, deliberately: the Accounts desk. It has no per-customer
 * seat — it is an app, not a person — so there is nobody this engine can name
 * without inventing one. Those actions stay with the caller; see the report.
 *
 * PURE, like every engine here: seats in, groups out, no I/O.
 * ------------------------------------------------------------------------- */

export type RoutingSeats = {
  /** Whose book the account is in — `assignedUserId`. */
  salesUserId: string | null;
  /** `customers.back_office_am_id`. */
  backOfficeUserId: string | null;
  /** `customers.sales_manager_id`. */
  salesManagerUserId: string | null;
};

export type RouteKind = "self" | "salesman" | "back_office" | "sales_manager";

export type RoutedGroup = {
  assigneeId: string;
  routedTo: RouteKind;
  /** The action codes this person is asked to do, in the order they were ticked. */
  actions: string[];
  /**
   * Said when the action belonged to somebody else and the seat was empty, so
   * it stayed with the caller. Null where nothing fell back.
   */
  fellBack: string | null;
};

/** Which seat an action belongs to. Absent means it is the caller's own. */
const OWNER_OF: Record<string, { kind: Exclude<RouteKind, "self">; seat: keyof RoutingSeats; whose: string }> = {
  salesman_visit: { kind: "salesman", seat: "salesUserId", whose: "salesperson" },
  contact_logistics: { kind: "back_office", seat: "backOfficeUserId", whose: "back office person" },
  escalate: { kind: "sales_manager", seat: "salesManagerUserId", whose: "sales manager" },
};

export const ROUTE_LABEL: Record<RouteKind, string> = {
  self: "the person who took the call",
  salesman: "the salesperson on the account",
  back_office: "the back office person on the account",
  sales_manager: "the sales manager on the account",
};

/**
 * The sentence the panel prints under the ticked actions, so nobody ticks
 * "Salesman visit" believing a reminder will appear on their own list. Null
 * where every action stays with the caller — the common case, and the one that
 * needs no sentence.
 */
export function routingNote(actions: readonly string[]): string | null {
  const parts = new Map<string, string>();
  for (const a of actions) {
    const owner = OWNER_OF[a];
    if (owner) parts.set(owner.kind, ROUTE_LABEL[owner.kind]);
  }
  if (!parts.size) return null;
  return `Handed over: ${[...parts.values()].join(" and ")} will be told and gets the reminder. Where the account has no such person recorded, it stays with you.`;
}

export function routeNextActions(
  actions: readonly string[],
  seats: RoutingSeats,
  loggerId: string,
): RoutedGroup[] {
  const self: RoutedGroup = { assigneeId: loggerId, routedTo: "self", actions: [], fellBack: null };
  const others = new Map<string, RoutedGroup>();
  const fellBack: string[] = [];

  for (const a of actions) {
    const owner = OWNER_OF[a];
    if (!owner) {
      self.actions.push(a);
      continue;
    }
    const person = seats[owner.seat];
    if (!person) {
      self.actions.push(a);
      fellBack.push(`no ${owner.whose} is recorded on this account, so it stays with you`);
      continue;
    }
    if (person === loggerId) {
      /* The caller IS that person — one reminder, no hand-over to announce. */
      self.actions.push(a);
      continue;
    }
    const key = `${owner.kind}:${person}`;
    const group = others.get(key) ?? {
      assigneeId: person,
      routedTo: owner.kind,
      actions: [],
      fellBack: null,
    };
    group.actions.push(a);
    others.set(key, group);
  }

  if (fellBack.length) self.fellBack = [...new Set(fellBack)].join("; ");

  /* The caller's own group first, so the call's `reminder_id` keeps pointing at
     the reminder it always pointed at. Absent where every action went away. */
  return [...(self.actions.length ? [self] : []), ...others.values()];
}
