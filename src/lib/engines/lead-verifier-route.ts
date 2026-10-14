/**
 * WHICH VERIFIER A LEAD GOES TO — the FIELD verifier or the DESK one.
 *
 *   raised at the desk (a Telecaller, or a Sales Manager)     → desk (Pritesh)
 *   raised on the handset by a Salesman                       → FIELD (Seema)
 *   raised on the handset by a manager or administrator       → desk
 *   assigned to a Salesman NOW, whoever raised it             → FIELD
 *   creator unknown                                           → desk, as a FALLBACK
 *
 * PRECEDENCE IS EXPLICIT: current Salesman assignment overrides the creator. A
 * Telecaller's or a Sales Manager's lead that a Salesman now holds is the field
 * verifier's; and a Salesman's lead that has since been taken off him is still
 * hers, because rule 3 is about who raised it.
 *
 * ONE EXCEPTION, which is itself a rule: a lead the field verifier raised
 * herself is never hers to verify. It stays with the desk verifier whether or
 * not a Salesman holds it.
 *
 * Pure, like every engine here. It is handed what is persisted and answers
 * which route applies; it never names a creator it was not told. The fallback
 * is not a guess about WHO raised the lead — `creatorId` stays null — it is the
 * answer to "which verifier, when that cannot be established".
 *
 * The creator's KIND is read from what was written the day the lead was raised
 * (the app that wrote `lead_created`, and the level the handset held), never
 * from what the person holds today — a Salesman promoted last month did not
 * raise last year's lead as a manager.
 */

/** What was persisted when the lead was raised. All of it nullable: a lead
    imported from a sheet, or older than the record, carries none of it. */
export type CreatorFacts = {
  /** `timeline_events.actor_user_id` of the `lead_created` event. */
  actorUserId: string | null;
  /** `timeline_events.source_app` of that event — `crm` or `mbos`. */
  eventSourceApp: string | null;
  /** The level the handset held, from the `lead.captured` audit row. */
  capturedAsRole: string | null;
};

export const NO_CREATOR: CreatorFacts = { actorUserId: null, eventSourceApp: null, capturedAsRole: null };

type CreatorKind = "desk" | "salesman" | "unknown";

/** Who raised it, as far as the record can say — never a guess. */
function classifyCreator(c: CreatorFacts): CreatorKind {
  if (!c.actorUserId || !c.eventSourceApp) return "unknown";
  if (c.eventSourceApp === "crm") return "desk";
  if (c.eventSourceApp === "mbos") {
    if (c.capturedAsRole === "associate") return "salesman";
    if (c.capturedAsRole === "manager" || c.capturedAsRole === "admin") return "desk";
    // A handset lead whose level was never recorded: not classified from today's role.
    return "unknown";
  }
  return "unknown";
}

export type VerifierRoute = {
  route: "field" | "desk";
  /** Who raised it, where the record says. Null is "unknown", never a guess. */
  creatorId: string | null;
  /** Creator or routing could not be established, so the desk verifier is the fallback. */
  fallback: boolean;
  /** The field verifier because a Salesman holds the lead now. */
  viaAssignment: boolean;
  /** The lead was raised by the field verifier herself, so the desk verifier has it. */
  creatorIsFieldVerifier: boolean;
};

export function chooseVerifierRoute(input: {
  creator: CreatorFacts;
  assignedToSalesman: boolean;
  /** The configured field verifier's user id — for the own-lead exception. */
  fieldVerifierId?: string | null;
}): VerifierRoute {
  const kind = classifyCreator(input.creator);
  const creatorId = input.creator.actorUserId?.trim() || null;
  const fieldId = input.fieldVerifierId?.trim() || null;

  let route: "field" | "desk" = kind === "salesman" ? "field" : "desk";
  let fallback = kind === "unknown";
  let viaAssignment = false;

  if (input.assignedToSalesman && route !== "field") {
    route = "field";
    viaAssignment = true;
    fallback = false;
  }

  let creatorIsFieldVerifier = false;
  if (route === "field" && creatorId && fieldId && creatorId === fieldId) {
    route = "desk";
    viaAssignment = false;
    fallback = false;
    creatorIsFieldVerifier = true;
  }
  return { route, creatorId, fallback, viaAssignment, creatorIsFieldVerifier };
}
