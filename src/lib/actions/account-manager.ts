"use server";

import { z } from "zod";
import { requireCapability } from "@/lib/access-control";
import { applyAccountManagerChange } from "@/lib/services/account-manager-service";
import { err, fromThrown, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * Changing who an account answers to.
 *
 * Every account has two account managers and they move independently: SALES is
 * who sells to them and whose book the account is in, BACK OFFICE is who does
 * the dispatch, billing and paperwork. A salesperson resigning says nothing
 * about who raises the invoices, so the two are asked separately and either or
 * both can be set in one action.
 *
 * WHY IT IS ACCOUNTS' AND ADMIN'S, AND NOT A MANAGER'S. Whose book an account
 * is in decides who is credited for its orders and whose targets it counts
 * toward, so a manager reassigning accounts is a manager moving numbers
 * between their own people, including themselves. That is the conflict
 * `order.approve` already exists to avoid, one level up — there the person
 * chasing the target must not sign off the orders that hit it; here they must
 * not choose which accounts feed it. Checked server-side in this file, not by
 * hiding the button, because a hidden control is not a permission.
 *
 * WHY A REASON IS MANDATORY. The question anybody asks weeks later is not
 * "who owns this account" — the row answers that — it is "why did it move, and
 * what else moved with it". When a salesperson leaves, whoever picks up the
 * book needs the list. So the reason is a coded column in
 * `customer_am_changes` rather than prose in an audit blob, and it can be
 * grouped by.
 * ------------------------------------------------------------------------- */

/**
 * A reason belongs to a SEAT, not to the dialog.
 *
 * It used to be one code and one note for whatever moved, which reads fine
 * until both seats move at once — and both moving at once is the ordinary
 * case, because that is what happens when somebody leaves. "Salesperson left"
 * was then stamped on the back-office row too, and the history said the
 * dispatch clerk changed because a salesperson resigned. Two changes, two
 * reasons, two rows.
 */
const seatReason = z.object({
  reasonCode: z.string().min(1),
  note: z.string().trim().max(500).optional(),
});

const schema = z.object({
  customerIds: z.array(z.string().min(1)).min(1),
  /**
   * `null` means UNASSIGN, and is different from omitting the key, which means
   * leave this manager alone. Collapsing the two would make "clear the back
   * office manager" unexpressible, and the sheet leaves plenty of accounts
   * with nobody in that seat.
   */
  salesAmId: z.string().min(1).nullable().optional(),
  /**
   * The sales seat, where the person who sells has no login.
   *
   * Four of the biggest salespeople on this book are exactly that: Prakash
   * Vasudev Prasad (301 accounts), Rahul Richhariya (147), Bharat Singh (73)
   * and Sanjay Kumar Samantaray (25) are all current employees and none of
   * them has ever signed in. Refusing to record them meant the true answer
   * could not be written down at all, and the sheet's name stayed the only
   * place it existed.
   *
   * WHAT IT COSTS, and why the screen says so: `sales_am_id` is what
   * `ASSIGNED_TO_SQL` reads, so a customer whose sales seat holds a NAME is
   * on nobody's calling queue and nobody's collections list. That is the
   * honest state of an account whose salesperson cannot sign in — better said
   * out loud than hidden behind a login that belongs to somebody else.
   */
  salesEmployeeId: z.string().min(1).optional(),
  /**
   * The back office seat takes a PERSON, who may not have a login.
   *
   * `user` is an account; `employee` is somebody on the HRMS master, stored as
   * a name in `customers.backOfficeName` exactly as the sheet has always
   * stored them; `none` empties the seat. Sales has no such union on purpose —
   * it decides whose calling queue the account lands in, and a name with no
   * account cannot be given a queue.
   *
   * An employee arrives as an ID and the NAME is read from the database here.
   * Taking the name off the request would let a caller write any string they
   * liked into a column the screens display.
   */
  backOffice: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("user"), userId: z.string().min(1) }),
      z.object({ kind: z.literal("employee"), employeeId: z.string().min(1) }),
      z.object({ kind: z.literal("none") }),
    ])
    .optional(),
  sales: seatReason.optional(),
  backOfficeReason: seatReason.optional(),
});

export type UpdateAccountManagersInput = z.input<typeof schema>;
/** What the service is handed: the request, already parsed. */
export type AccountManagerChange = z.output<typeof schema>;

export async function updateAccountManagers(
  raw: UpdateAccountManagersInput,
): Promise<Result> {
  try {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err(issue.message, "validation", [
        { field: issue.path.join("."), message: issue.message },
      ]);
    }

    /*
     * The capability is asked HERE and the work happens in the service, which
     * a remediation job also calls with a named actor. See
     * `services/account-manager-service.ts` for why there is exactly one
     * implementation of the write.
     */
    const ctx = await requireCapability("customer.reassign");
    return await applyAccountManagerChange(parsed.data, {
      userId: ctx.user.id,
      name: ctx.user.name,
      authorisedBy: ctx.authorisedBy,
      authorisedIn: ctx.authorisedIn,
    });
  } catch (e) {
    return fromThrown(e);
  }
}
