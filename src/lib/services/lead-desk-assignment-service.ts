import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, users } from "@/db/schema";
import { canOpenModule } from "@/lib/access";
import { canFor } from "@/lib/access-control";
import { notifyUsers } from "@/lib/notify";

/* ---------------------------------------------------------------------------
 * WHO THE CALLING DESK'S LEADS CAN BE GIVEN TO, and who is told when one is
 * waiting to be.
 *
 * A lead's owner is the assignment — `ASSIGNED_TO_SQL` resolves a lead through
 * `owner_id` — and an associate's data scope is their own book, so a lead with
 * no owner is on NO telecaller's desk. That is correct and it is also a lead
 * that can sit unseen, which is why the two things below exist: the list of
 * people it can be handed to, and a notification to the people who hand it out.
 *
 * `reassignLead` is the existing move and it cannot serve here: it only accepts
 * an owner who holds the Salesman App, because it puts the lead on a handset. A
 * telecaller holds the CRM and no handset, so the desk has its own list. It is
 * still the same column, and the rule for who may hold the desk is the module
 * check every other door uses (`canOpenModule`), asked here rather than restated
 * in SQL — a second statement of "no rows means every module" would drift.
 * ------------------------------------------------------------------------- */

export const DESK_MODULE = "crm.lead-calling-desk";

export type DeskPerson = { id: string; name: string };

async function crmAccounts(): Promise<(DeskPerson & { role: string })[]> {
  return db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .innerJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "crm")))
    .where(eq(users.active, true))
    .orderBy(users.name);
}

/** A person the Change owner list offers. `canOwn` is whether they hold the Calling desk. */
export type OwnerChoice = DeskPerson & { canOwn: boolean };

/**
 * EVERYONE A "CHANGE OWNER" LIST SHOWS — every active CRM user, in name order.
 *
 * The list used to be `deskHolders()` alone, so anybody who had not been granted
 * the Calling desk was simply missing, and the picker read as if half the team
 * did not exist. They are listed now, and `canOwn` says whether they can be
 * chosen: the server still refuses a lead handed to somebody with no desk to see
 * it on (`assignDeskLead`), so a person without it is drawn DISABLED, with the
 * reason, rather than offered as a choice that cannot work.
 */
export async function ownerChoices(): Promise<OwnerChoice[]> {
  const out: OwnerChoice[] = [];
  for (const u of await crmAccounts()) {
    out.push({ id: u.id, name: u.name, canOwn: await canOpenModule(u.id, DESK_MODULE) });
  }
  return out;
}

/** Everyone who holds the CRM AND the desk — the people a lead can be handed to. */
export async function deskHolders(): Promise<DeskPerson[]> {
  const out: DeskPerson[] = [];
  for (const u of await crmAccounts()) {
    if (await canOpenModule(u.id, DESK_MODULE)) out.push({ id: u.id, name: u.name });
  }
  return out;
}

/** Everyone who may hand a lead out — `lead.verify`, the manager's judgement — and can open the desk to do it. */
export async function deskAssigners(): Promise<DeskPerson[]> {
  const out: DeskPerson[] = [];
  for (const u of await crmAccounts()) {
    if ((await canFor({ id: u.id, role: u.role }, "lead.verify")) && (await canOpenModule(u.id, DESK_MODULE))) {
      out.push({ id: u.id, name: u.name });
    }
  }
  return out;
}

/**
 * A lead exists and nobody owns it. Told to whoever can give it an owner, and
 * never to the person who just created it — nobody is told what they did.
 */
export async function notifyDeskAssigners(input: {
  customerId: string;
  leadName: string;
  byUserId: string;
}): Promise<void> {
  const assigners = (await deskAssigners()).filter((p) => p.id !== input.byUserId);
  await notifyUsers(
    assigners.map((p) => ({
      userId: p.id,
      title: `A lead is waiting to be assigned: ${input.leadName}`,
      body: "It was created from a website enquiry and has no owner, so it is not on any telecaller's calling desk yet.",
      kind: "warn" as const,
      href: `/crm/leads/calling-desk/${input.customerId}`,
    })),
  );
}
