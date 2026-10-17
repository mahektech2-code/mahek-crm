import "server-only";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, mbosUserTerritories, users } from "@/db/schema";
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

/**
 * Where a lead handed to this person will APPEAR, which is the one thing worth
 * saying beside their name now that anybody can be chosen.
 *
 *   `desk`    - on their Calling desk.
 *   `crm`     - in All Leads (their own book), but on no desk.
 *   `handset` - on their Salesman App handset only; they have no CRM login.
 */
export type OwnerPlace = "desk" | "crm" | "handset";

/** A person the Change owner list offers. `canOwn` is false only for somebody a lead cannot be given to at all. */
export type OwnerChoice = DeskPerson & { canOwn: boolean; place: OwnerPlace };

/** Active people who hold the CRM or the Salesman App, with which of the two. Name order, one row each. */
async function assignableAccounts(): Promise<Array<DeskPerson & { crm: boolean; field: boolean }>> {
  const rows = await db
    .select({ id: users.id, name: users.name, app: appAccess.app })
    .from(users)
    .innerJoin(appAccess, eq(appAccess.userId, users.id))
    .where(and(eq(users.active, true), inArray(appAccess.app, ["crm", "field"])))
    .orderBy(users.name, users.id);
  const byId = new Map<string, DeskPerson & { crm: boolean; field: boolean }>();
  for (const r of rows) {
    const p = byId.get(r.id) ?? { id: r.id, name: r.name, crm: false, field: false };
    if (r.app === "crm") p.crm = true;
    else p.field = true;
    byId.set(r.id, p);
  }
  return Array.from(byId.values());
}

async function placeOf(p: { id: string; crm: boolean }): Promise<OwnerPlace> {
  if (!p.crm) return "handset";
  return (await canOpenModule(p.id, DESK_MODULE)) ? "desk" : "crm";
}

/**
 * EVERYONE A "CHANGE OWNER" / "REASSIGN THE LEAD" LIST SHOWS, and every one of
 * them can be chosen — every active person who holds the CRM or the Salesman
 * App, in name order.
 *
 * It was every active CRM user, with anybody lacking the Calling desk drawn
 * disabled, and a field salesman with no CRM login was not in it at all. Mahek's
 * answer is that it does not matter whether the person is a salesman or a
 * telecaller: whoever is on the team has to be selectable, and the lead has to
 * land with them. So the desk is no longer a precondition; `place` says where
 * the lead will show up for each person, and the label carries it so a choice
 * that puts the lead off a desk is never silent.
 *
 * Accounts are told apart by id throughout — two people can share a name.
 */
export async function ownerChoices(): Promise<OwnerChoice[]> {
  const out: OwnerChoice[] = [];
  for (const u of await assignableAccounts()) {
    out.push({ id: u.id, name: u.name, canOwn: true, place: await placeOf(u) });
  }
  return out;
}

/**
 * One person a lead may be handed to, by id — the server's half of
 * {@link ownerChoices}, so what the picker offers and what the action accepts
 * cannot differ. Null is "not an active CRM or Salesman App account".
 */
export async function assignableOwner(
  id: string,
): Promise<(DeskPerson & { place: OwnerPlace; noArea: boolean }) | null> {
  const found = (await assignableAccounts()).find((p) => p.id === id);
  if (!found) return null;
  const place = await placeOf(found);
  return {
    id: found.id,
    name: found.name,
    place,
    noArea: place === "handset" ? await lacksWorkingArea(found.id) : false,
  };
}

/**
 * A handset-only person with NO allocated area has an empty book: territory
 * narrows what reaches the phone and "no territory means no book" for anybody
 * but a manager or an admin (`territoryExempt` in `mbos-service.ts`, whose
 * definition this repeats rather than imports - that file is the handset's
 * whole sync). A lead given to such a person is assigned and is on their
 * handset at no point until an area is set, so the confirmation must say so
 * rather than imply it will arrive.
 *
 * Only the working kinds count: a `region` row is a manager's oversight patch
 * and never allocates a book.
 */
async function lacksWorkingArea(userId: string): Promise<boolean> {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u || u.role === "manager" || u.role === "admin") return false;
  const rows = await db
    .select({ id: mbosUserTerritories.id })
    .from(mbosUserTerritories)
    .where(and(eq(mbosUserTerritories.userId, userId), ne(mbosUserTerritories.kind, "region")))
    .limit(1);
  return rows.length === 0;
}

/**
 * The sentence that says where a lead handed to somebody will be, for the
 * toast. Empty on a desk. `noArea` is the handset caveat: assigned, but not on
 * the phone until somebody allocates the person an area.
 */
export function placeSentence(name: string, place: OwnerPlace, noArea = false): string {
  if (place === "desk") return "";
  if (place === "crm") {
    return ` ${name} does not hold the Calling desk, so it is in their All Leads list rather than on a desk.`;
  }
  return noArea
    ? ` ${name} has no CRM login and no area allocated, so it is assigned to them but will NOT show on their Salesman App handset until an area is set for them.`
    : ` ${name} has no CRM login, so it reaches their Salesman App handset at the next sync.`;
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
