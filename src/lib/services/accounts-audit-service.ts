import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireCapability } from "../access-control";
import { decisionLine } from "./accounts-home-service";

/* ---------------------------------------------------------------------------
 * The audit log, for the desk that produces most of it.
 *
 * Every approve, decline, confirm, reject, record and credit note already
 * writes a row; nothing ever showed them. A decision nobody can look up later
 * is a decision nobody can be asked about, which is the opposite of why the
 * table exists.
 *
 * Read-only by construction — there is no update or delete path in this file,
 * and there is not meant to be one.
 * ------------------------------------------------------------------------- */

/** The actions this desk is answerable for. Anything else belongs elsewhere. */
const ACCOUNTS_ACTIONS = [
  "order.approve",
  "order.decline",
  "payment.record",
  "payment.confirm",
  "payment.reject",
  "payment.apply_on_account",
  "creditnote.issue",
  "creditnote.refuse",
] as const;

export type AuditRow = {
  id: string;
  at: Date;
  actorName: string | null;
  action: string;
  /** The sentence, built from the stored state rather than from the action. */
  what: string;
  /** What it happened to, named the way a person would name it. */
  on: string;
  entityType: string;
  entityId: string | null;
  kind: "approve" | "decline" | "confirm" | "reject" | "record" | "issue" | "refuse";
};

const KIND: Record<string, AuditRow["kind"]> = {
  "order.approve": "approve",
  "order.decline": "decline",
  "payment.confirm": "confirm",
  "payment.reject": "reject",
  "payment.record": "record",
  "payment.apply_on_account": "record",
  "creditnote.issue": "issue",
  "creditnote.refuse": "refuse",
};

export async function accountsAudit(limit = 500): Promise<AuditRow[]> {
  await requireCapability("payment.record");

  const rows = await db.execute<{
    id: string;
    at: Date;
    actor: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    after: Record<string, unknown> | null;
    subject: string | null;
  }>(sql`
    select a.id, a.at, u.name as actor, a.action, a.entity_type, a.entity_id,
           a.after_state as after,
           coalesce(oc.name, rc.name, cc.name, bc.name) as subject
      from audit_log a
      left join users u on u.id = a.actor_id
      left join orders o on a.entity_type = 'order' and o.id = a.entity_id
      left join customers oc on oc.id = o.customer_id
      left join payment_receipts r on a.entity_type = 'payment_receipt' and r.id = a.entity_id
      left join customers rc on rc.id = r.customer_id
      left join complaints cm on a.entity_type = 'complaint' and cm.id = a.entity_id
      left join customers cc on cc.id = cm.customer_id
      left join bills b on a.entity_type = 'bill' and b.id = a.entity_id
      left join customers bc on bc.id = b.customer_id
     where a.action in ${sql.raw(`(${ACCOUNTS_ACTIONS.map((x) => `'${x}'`).join(",")})`)}
     order by a.at desc
     limit ${limit}
  `);

  return rows.map((r) => ({
    id: r.id,
    at: new Date(r.at),
    actorName: r.actor,
    action: r.action,
    what:
      r.action === "payment.apply_on_account"
        ? applyLine(r.after)
        : decisionLine(r.action, r.after),
    on: r.subject ?? "—",
    entityType: r.entity_type,
    entityId: r.entity_id,
    kind: KIND[r.action] ?? "record",
  }));
}

function applyLine(after: Record<string, unknown> | null): string {
  const paise = Number(after?.amount ?? 0);
  const rupees = `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
  return `Applied ${rupees} from on account to ${String(after?.billNo ?? "a bill")}`;
}
