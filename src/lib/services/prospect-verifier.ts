import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { approverFor, canVerifyLeadById, deskApprover, holdsLeadSeat, orgModeOn, requireLeadVerifier } from "./lead-verifier";

/* ---------------------------------------------------------------------------
 * WHO MAY CONFIRM OR RETURN A PROSPECT, asked one way by the screen and the action.
 *
 * Nothing here routes anybody. The existing designated-verifier gate
 * (`requireLeadVerifier(…, { designated: true })`) is asked first and where the
 * org chart is on it already names ONE person and refuses everybody else —
 * administrators and `lead.verify` holders included.
 *
 * What that gate does NOT do, with the org chart off, is name anybody: it falls
 * through to "anybody holding `lead.verify`". That is fine for a verification
 * CALL and wrong for the decision to open Qualification, so with the chart off
 * only a person the existing rules already designate may decide — the lead's own
 * Sales Manager seat holder, the configured self-raised-lead approver, or the
 * Calling Desk's configured verifier. Anyone else is refused with the
 * configuration that is missing, rather than approved on a permission alone.
 * ------------------------------------------------------------------------- */

class ProspectVerifierRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotPermittedError";
  }
}

const NO_DESIGNATED =
  "No designated verifier can be resolved for this lead. Verification is not routed through the org chart " +
  "(setting “Verify Salesman-raised leads through the org chart” is off), so only the lead's own Sales Manager, " +
  "the configured self-raised-lead approver or the Calling Desk's verifier may confirm or return it — and you are none of them. " +
  "Turn org-chart routing on, or seat a Sales Manager on the lead.";

async function resolvedWithoutOrgChart(user: { id: string }, customerId: string): Promise<boolean> {
  const [lead] = await db
    .select({ ownerId: customers.ownerId, salesManagerId: customers.salesManagerId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!lead) return false;
  const configured = await approverFor({ ownerId: lead.ownerId, salesManagerId: lead.salesManagerId });
  if (configured?.id === user.id) return true;
  if (await holdsLeadSeat(user, lead.salesManagerId)) return true;
  return (await deskApprover())?.id === user.id;
}

/** The server's form. Throws a `NotPermittedError`, which `fromThrown` answers as `not_permitted`. */
export async function requireProspectVerifier(customerId: string) {
  const ctx = await requireLeadVerifier(customerId, { designated: true });
  if (await orgModeOn()) return ctx;
  if (ctx.user.id && (await resolvedWithoutOrgChart(ctx.user, customerId))) return ctx;
  throw new ProspectVerifierRefused(NO_DESIGNATED);
}

/** The screens' form — the same answer, as a boolean. */
export async function canDecideProspect(user: { id: string; role: string }, customerId: string): Promise<boolean> {
  if (!(await canVerifyLeadById(user, customerId, { designated: true }))) return false;
  if (await orgModeOn()) return true;
  return resolvedWithoutOrgChart(user, customerId);
}
