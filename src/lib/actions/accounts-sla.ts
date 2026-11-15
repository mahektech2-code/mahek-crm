"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { notifyUsers } from "@/lib/notify";
import { err, fromThrown, okVoid, type Result } from "@/lib/result";
import { requireActIn } from "@/lib/command-centre/access";
import { remarkProblem, remindAtFor, type RemindChoice, type SlaKind } from "@/lib/engines/accounts-sla";
import { SLA_HREF, SLA_MODULE } from "@/lib/services/accounts-sla-service";

/* ---------------------------------------------------------------------------
 * The accounts desk saying WHY something is past its deadline, and when to
 * ask again; and the founder's side — acknowledging and nudging.
 *
 * Every rule the dialog shows is checked again here (`remarkProblem`), and the
 * person must hold the Accounts screen the item is decided on: a server action
 * is a URL, and a dialog is not a permission.
 * ------------------------------------------------------------------------- */

const CHOICES: readonly RemindChoice[] = ["1h", "1d", "2d", "custom"];

export async function explainAccountsDelays(input: {
  items: { breachId: string; body: string }[];
  remind: RemindChoice;
  customAt?: string | null;
}): Promise<Result<{ saved: number }>> {
  try {
    const user = await requireUser();
    if (!(await listUserApps(user.id)).includes("accounts")) return err("Accounts is not on your account.", "not_permitted");
    const held = new Set((await listUserModules(user.id, "accounts")).map((m) => m.key));
    if (!input.items?.length) return err("There is nothing to explain.");
    if (!CHOICES.includes(input.remind)) return err("Choose when to be reminded.");

    const nowMs = Date.now();
    const customMs = input.customAt ? Date.parse(input.customAt) : null;
    const remindAt = remindAtFor(input.remind, nowMs, Number.isFinite(customMs) ? customMs : null);

    const ids = input.items.map((i) => i.breachId);
    const rows = await db.execute<{ id: string; kind: SlaKind }>(
      sql`select id, kind from accounts_sla_breaches where resolved_at is null and id in ${ids}`,
    );
    const kindOf = new Map(rows.map((r) => [r.id, r.kind]));

    const fieldErrors: { field: string; message: string }[] = [];
    for (const it of input.items) {
      const kind = kindOf.get(it.breachId);
      if (!kind) continue; // decided meanwhile — nothing owed
      if (!held.has(SLA_MODULE[kind])) return err("One of these is decided on a screen you do not hold.", "not_permitted");
      const problem = remarkProblem(it.body ?? "", remindAt, nowMs);
      if (problem) fieldErrors.push({ field: it.breachId, message: problem });
    }
    if (fieldErrors.length) return { ok: false, error: fieldErrors[0].message, code: "validation", fieldErrors };

    const toSave = input.items.filter((i) => kindOf.has(i.breachId));
    for (const it of toSave) {
      await db.execute(sql`
        insert into accounts_sla_remarks (id, breach_id, author_id, side, body, remind_at)
        values (${`aslr_${randomUUID().slice(0, 12)}`}, ${it.breachId}, ${user.id}, 'accounts', ${it.body.trim()},
                to_timestamp(${remindAt! / 1000}))
      `);
    }
    revalidatePath("/accounts", "layout");
    revalidatePath("/founder/accounts-deadlines");
    return { ok: true, data: { saved: toSave.length }, message: toSave.length === 1 ? "Reason saved." : `${toSave.length} reasons saved.` };
  } catch (e) {
    return fromThrown(e);
  }
}

/** The founder (or a manager-level delegate) sending the desk a note — it reaches their bell and the dialog. */
export async function nudgeAccounts(input: { breachId: string; body: string }): Promise<Result> {
  try {
    const { user } = await requireActIn("deadlines");
    const body = (input.body ?? "").trim();
    if (body.length < 3) return err("Write the note to send.");
    const [b] = await db.execute<{ id: string; kind: SlaKind }>(
      sql`select id, kind from accounts_sla_breaches where id = ${input.breachId} and resolved_at is null`,
    );
    if (!b) return err("That has been decided already.", "not_found");
    await db.execute(sql`
      insert into accounts_sla_remarks (id, breach_id, author_id, side, body)
      values (${`aslr_${randomUUID().slice(0, 12)}`}, ${b.id}, ${user.id}, 'admin', ${body})
    `);
    // Everyone on the desk who decides this kind — the same set the dialog asks.
    const desk = await db.execute<{ id: string }>(sql`
      select distinct u.id from users u join app_access a on a.user_id = u.id and a.app = 'accounts'
       where u.active and u.id <> ${user.id}
         and (a.role = 'admin'
              or not exists (select 1 from app_module_access m where m.user_id = u.id and m.app = 'accounts')
              or exists (select 1 from app_module_access m where m.user_id = u.id and m.app = 'accounts'
                           and m.module = ${SLA_MODULE[b.kind]}))
    `);
    await notifyUsers(
      desk.map((d) => ({
        userId: d.id,
        kind: "warn",
        title: `${user.name} is asking about an overdue item`,
        body,
        href: SLA_HREF[b.kind],
      })),
    );
    revalidatePath("/founder/accounts-deadlines");
    return okVoid(`Sent to ${desk.length} ${desk.length === 1 ? "person" : "people"} on the accounts desk.`);
  } catch (e) {
    return fromThrown(e);
  }
}

/** "I have seen this" — it stays open and stays the accounts desk's to decide. */
export async function acknowledgeDeadline(breachId: string): Promise<Result> {
  try {
    const { user } = await requireActIn("deadlines");
    const r = await db.execute(sql`
      update accounts_sla_breaches set acknowledged_by_id = ${user.id}, acknowledged_at = now()
       where id = ${breachId} and resolved_at is null returning id
    `);
    if (!r.length) return err("That has been decided already.", "not_found");
    revalidatePath("/founder/accounts-deadlines");
    return okVoid("Marked as seen. It stays with accounts until they decide it.");
  } catch (e) {
    return fromThrown(e);
  }
}
