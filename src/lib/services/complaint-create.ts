import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { complaintStatusHistory, complaints } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { categoryValue, COMPLAINT_PRIORITIES } from "@/lib/complaint-labels";

/* ---------------------------------------------------------------------------
 * RAISING A COMPLAINT, the one way it is done.
 *
 * The CRM's Complaints dialog and the ERP's "Raise a customer request" write
 * the same row. They used to be two tables with the same fields — a complaint
 * a salesman raised in the ERP never reached the telecaller who took the
 * customer's next call — so this is the single writer both call: the category
 * through `categoryValue`, the severity and SLA deadline from configuration,
 * and the opening line of the status history. A caller that skipped any of
 * those would raise a complaint with no deadline or no history.
 * ------------------------------------------------------------------------- */

export type NewComplaint = {
  customerId: string;
  /** Who is writing it down. */
  loggedById: string;
  loggedByName: string;
  /** A business label — "Packaging", "Price Issue" — never the enum value. */
  category: string;
  description: string;
  /** Normal, Urgent or Critical, as `COMPLAINT_PRIORITIES` spells them; absent takes the configured default. */
  priority?: string;
  mobileNumber?: string | null;
  requestCn?: boolean;
  billId?: string | null;
  goodsDescription?: string | null;
  /** The salesman it was raised for, where somebody in the office raised it on his behalf. */
  salesmanName?: string | null;
  /** Given by the caller where the row already has an identity (a carried-over ERP request). */
  id?: string;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Writes the complaint and its opening history line, inside the caller's transaction or its own. */
export async function createComplaint(input: NewComplaint, tx?: Tx): Promise<string> {
  const config = await getConfig();
  const picked = COMPLAINT_PRIORITIES.find((p) => p.value === input.priority);
  const severity = picked?.value ?? config["complaints.defaultSeverity"];
  const slaHours = config["complaints.slaHours"][severity];
  const complaintId = input.id ?? `cmp_${randomUUID().slice(0, 12)}`;
  const write = async (t: Tx) => {
    await t.insert(complaints).values({
      id: complaintId,
      customerId: input.customerId,
      loggedByUserId: input.loggedById,
      category: categoryValue(input.category) as never,
      description: input.description.trim(),
      severity,
      slaDueAt: new Date(Date.now() + slaHours * 3_600_000),
      mobileNumber: input.mobileNumber?.trim() || null,
      requestCn: input.requestCn ?? false,
      billId: input.requestCn ? (input.billId ?? null) : null,
      goodsDescription: input.requestCn ? input.goodsDescription?.trim() || null : null,
      salesmanName: input.salesmanName?.trim() || null,
      createdById: input.loggedById,
      updatedById: input.loggedById,
    });
    await t.insert(complaintStatusHistory).values({
      id: `csh_${randomUUID().slice(0, 12)}`,
      complaintId,
      fromStatus: null,
      toStatus: "open",
      changedById: input.loggedById,
      note: `Logged by ${input.loggedByName}`,
    });
  };
  if (tx) await write(tx);
  else await db.transaction(write);
  return complaintId;
}
