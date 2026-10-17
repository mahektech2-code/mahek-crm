import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db";
import { designatedApprover } from "./lead-verifier";

/**
 * SEAT THE DESIGNATED APPROVER ON EVERY LEAD THE SALES MANAGER RAISED HERSELF.
 *
 * The approvals on such a lead are one person's (`leads.selfRaisedVerifierEmail`),
 * and a person can only act on a lead they can SEE. The coordinating seat
 * (`customers.lead_manager_id`) is the one that already grants sight to whoever
 * runs a lead's conversion without making them its owner, so that is where they
 * go — which also means the verification queue, the record and the notifications
 * need no second rule to reach them.
 *
 * It is a FILL, in the way `recomputeSalesManagers` is: only leads nobody has
 * decided the seat on (`lead_manager_decided_at` null), only while the lead is
 * still being qualified, and only where the seat is not already theirs. A lead
 * somebody seated deliberately is left alone, and so is every lead once it is
 * past Qualification. With nobody designated it does nothing at all, which is
 * how the rule is off by default.
 *
 * Idempotent: a second pass finds nothing to change.
 */
export async function ensureSelfRaisedVerifierSeats(): Promise<number> {
  const approver = await designatedApprover();
  if (!approver) return 0;

  const rows = await db.execute<{ id: string }>(sql`
    update customers
       set lead_manager_id = ${approver.id}, updated_at = now()
     where lead_stage is not null
       and lead_archived = false
       and deleted_at is null
       and lead_stage::text in ('new', 'suspect', 'contacted', 'prospect', 'qualification', 'qualified')
       and sales_manager_id is not null
       and sales_manager_id <> ${approver.id}
       and (owner_id is null or owner_id = sales_manager_id)
       and lead_manager_decided_at is null
       and lead_manager_id is distinct from ${approver.id}
    returning id
  `);
  return rows.length;
}
