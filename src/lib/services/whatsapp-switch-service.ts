import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, auditLog, waTemplates, whatsappServiceEvents } from "@/db/schema";
import { requireCapability, NotPermittedError } from "../access-control";
import { err, okVoid, type Result } from "../result";
import { isApproved, listWatiTemplates } from "../wati";
import { specKey } from "../wati-templates";

/* ---------------------------------------------------------------------------
 * The founder's switch for WhatsApp sending, and the template links beside it.
 *
 * ONE RULE: a message goes out through the API only while the newest row of
 * `whatsapp_service_events` says `active`. No row means off. The switch is
 * read on every send rather than cached, because "I switched it off" has to
 * mean the next message does not go — not the one after a cache expires.
 * ------------------------------------------------------------------------- */

const newId = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

export type ServiceState = {
  active: boolean;
  /** When the newest decision was made; null if nobody has ever decided. */
  at: Date | null;
  byName: string | null;
  note: string | null;
};

export async function whatsappServiceState(): Promise<ServiceState> {
  const [row] = await db
    .select()
    .from(whatsappServiceEvents)
    .orderBy(desc(whatsappServiceEvents.at))
    .limit(1);
  if (!row) return { active: false, at: null, byName: null, note: null };
  return { active: row.active, at: row.at, byName: row.changedByName, note: row.note };
}

export async function serviceHistory(limit = 20) {
  return db
    .select()
    .from(whatsappServiceEvents)
    .orderBy(desc(whatsappServiceEvents.at))
    .limit(limit);
}

/**
 * The capability, AND worn as the Founder Dashboard. An administrator holds
 * `whatsapp.activate` like everything else; without the second half, holding
 * the Admin Console would be holding the founder's switch.
 */
export async function requireFounderDesk() {
  const ctx = await requireCapability("whatsapp.activate");
  // Asked of the GRANTS, not of which hat `requireCapability` happened to
  // credit: an administrator who also holds the Founder Dashboard carries the
  // capability in every app, and the hat it reports can be any of them.
  const [founder] = await db
    .select({ id: appAccess.id })
    .from(appAccess)
    .where(and(eq(appAccess.userId, ctx.user.id), eq(appAccess.app, "founder")))
    .limit(1);
  if (!founder) throw new NotPermittedError("whatsapp.activate");
  return { ...ctx, authorisedIn: "founder" as const };
}

export async function setWhatsappService(input: {
  active: boolean;
  note?: string | null;
}): Promise<Result> {
  const ctx = await requireFounderDesk();
  const current = await whatsappServiceState();
  if (current.active === input.active) {
    return okVoid(input.active ? "WhatsApp sending is already on" : "WhatsApp sending is already off");
  }
  const note = input.note?.trim() || null;

  await db.transaction(async (tx) => {
    await tx.insert(whatsappServiceEvents).values({
      id: newId("wsv"),
      active: input.active,
      note,
      changedById: ctx.user.id,
      changedByName: ctx.user.name,
    });
    await tx.insert(auditLog).values({
      id: newId("aud"),
      actorId: ctx.user.id,
      actorRole: ctx.authorisedBy,
      actorApp: ctx.authorisedIn,
      action: input.active ? "whatsapp.service_on" : "whatsapp.service_off",
      entityType: "whatsapp_service",
      entityId: "wati",
      afterState: { active: input.active, note } as never,
    });
  });

  return okVoid(
    input.active
      ? "WhatsApp sending is ON — linked templates now go out from the business number"
      : "WhatsApp sending is OFF — nothing goes through the API; every screen is back to copy and paste",
  );
}

/**
 * Which approved Wati template a CRM template is sent as — or none.
 *
 * A founder decision for the same reason as the switch: the link is what
 * decides the exact words a customer receives from the business number. The
 * name is checked against Wati at the moment it is linked, so a typo cannot
 * sit there waiting to fail every send.
 */
export async function linkWatiTemplate(
  templateId: string,
  watiTemplateName: string | null,
): Promise<Result> {
  const ctx = await requireFounderDesk();
  const [template] = await db.select().from(waTemplates).where(eq(waTemplates.id, templateId));
  if (!template) return err("That template no longer exists.", "not_found");

  const name = watiTemplateName?.trim() || null;
  // A template whose variables are filled by a rule set can only be sent as
  // the Wati template those rules were written for. Linking "Payment
  // follow-up" to an ORDER template would send a customer a payment total
  // under the words of an order reminder.
  if (name && template.watiSpec && specKey(name) !== template.watiSpec) {
    return err(
      `${template.name} is filled by the ${template.watiSpec} rules, so it can only be sent as a ${template.watiSpec} template in Wati (any _v version).`,
      "validation",
    );
  }
  if (name) {
    const listed = await listWatiTemplates({ fresh: true });
    if (!listed.ok) return err(`Could not check the template with Wati: ${listed.error}`, "rule_violation");
    const found = listed.templates.find((t) => t.name === name);
    if (!found) return err(`Wati has no template called "${name}".`, "validation");
    if (!isApproved(found)) {
      return err(
        `"${name}" is ${found.status.toLowerCase() || "not approved"} in Wati. Only an approved template can be sent.`,
        "rule_violation",
      );
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(waTemplates)
      .set({ watiTemplateName: name, updatedAt: new Date(), updatedById: ctx.user.id })
      .where(eq(waTemplates.id, templateId));
    await tx.insert(auditLog).values({
      id: newId("aud"),
      actorId: ctx.user.id,
      actorRole: ctx.authorisedBy,
      actorApp: ctx.authorisedIn,
      action: "whatsapp.template_link",
      entityType: "wa_template",
      entityId: templateId,
      beforeState: { watiTemplateName: template.watiTemplateName } as never,
      afterState: { watiTemplateName: name } as never,
    });
  });

  return okVoid(name ? `${template.name} now sends as "${name}"` : `${template.name} is no longer linked — it goes the manual way`);
}
