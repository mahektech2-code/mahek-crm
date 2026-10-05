import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { customers } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { canFor, levelInApp, requireCapability, resolveScope } from "@/lib/access-control";

/**
 * WHO MAY VERIFY A LEAD: whoever holds `lead.verify`, OR the Sales Manager the
 * lead is under.
 *
 * Verification is the responsible Sales Manager's act. `lead.verify` is a
 * manager-LEVEL capability, and the Sales Manager on this team holds the CRM at
 * associate level — so a lead raised under her seat was one she could read,
 * search and work and could not verify. Making her a manager would have handed
 * her every other manager capability to fix one button; the seat is the
 * narrower and truer fact.
 *
 * The rule is `lead.sales_manager_id = me` AND the Sales Manager module. It is
 * ADDITIVE: it removes nothing from anybody who holds `lead.verify` today, and
 * it grants nothing on any lead that is not under the seat. The creator never
 * enters into it — a Salesman's lead and a Sales Manager's own lead are
 * verified by the same person, the one whose seat it is. A Salesman holds
 * neither the capability nor the module, so he can still never verify.
 */
export const SALES_MANAGER_MODULE = "crm.sales-manager";

/** Is this person the Sales Manager the lead sits under, and allowed in that workspace? */
export async function holdsLeadSeat(
  user: { id: string },
  salesManagerId: string | null | undefined,
): Promise<boolean> {
  if (!salesManagerId || salesManagerId !== user.id) return false;
  return canOpenModule(user.id, SALES_MANAGER_MODULE);
}

/** The screens' form of the rule — the same one the server enforces below. */
export async function canVerifyLead(
  user: { id: string; role: string },
  salesManagerId: string | null | undefined,
): Promise<boolean> {
  if (await canFor(user, "lead.verify")) return true;
  return holdsLeadSeat(user, salesManagerId);
}

/**
 * The server's form: the same context `requireCapability("lead.verify")` hands
 * back, so every audit row downstream records a hat the same way. Where the
 * person holds the capability that is exactly what is returned. Where they hold
 * only the seat, the hat recorded is the one they actually wear in the CRM —
 * "associate in the CRM verified this" is the true sentence.
 */
export async function requireLeadVerifier(customerId: string) {
  const ctx = await resolveScope();
  if (!(await canFor(ctx.user, "lead.verify"))) {
    const [row] = await db
      .select({ salesManagerId: customers.salesManagerId })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    if (await holdsLeadSeat(ctx.user, row?.salesManagerId)) {
      const level = (await levelInApp(ctx.user, "crm")) ?? "associate";
      return { ...ctx, authorisedBy: level, authorisedIn: "crm" as const };
    }
    /* Falls through to the capability check so a refusal is audited and worded
       exactly as it always was. */
    return requireCapability("lead.verify");
  }
  return requireCapability("lead.verify");
}

/** The same rule by lead id, for the screens that load the lead separately. */
export async function canVerifyLeadById(
  user: { id: string; role: string },
  customerId: string,
): Promise<boolean> {
  if (await canFor(user, "lead.verify")) return true;
  const [row] = await db
    .select({ salesManagerId: customers.salesManagerId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return holdsLeadSeat(user, row?.salesManagerId);
}

/** The seat alone, by lead id. */
export async function holdsLeadSeatById(
  user: { id: string },
  customerId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ salesManagerId: customers.salesManagerId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return holdsLeadSeat(user, row?.salesManagerId);
}
