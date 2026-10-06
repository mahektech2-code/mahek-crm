import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customerContacts, customers } from "@/db/schema";
import {
  emailProblem,
  last10,
  mirrorsFrom,
  normalisePhone,
  sortContacts,
  CONTACT_ROLE_CODES,
  type ContactDesignation,
  type ContactRole,
} from "@/lib/customer-contacts";
import { err, ok, type Result } from "@/lib/result";

/*
 * THE PEOPLE AT A CUSTOMER — reads and writes.
 *
 * The table is the truth; `customers.phone`, `contact_person`,
 * `whatsapp_phone`, `payment_whatsapp_phone` and `alt_phone` are its mirrors,
 * because forty readers across the CRM, the handset and the WhatsApp senders
 * read them and none of them should have to learn a join to keep working.
 * `syncContactMirrors` is the ONLY thing that writes those columns from here,
 * and every write below calls it inside its own transaction.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

export type CustomerContact = {
  id: string;
  customerId: string;
  name: string | null;
  role: string;
  phone: string;
  email: string | null;
  note: string | null;
  isPrimary: boolean;
  forWhatsapp: boolean;
  forPaymentReminders: boolean;
  sortOrder: number;
  updatedAt: string;
};

const newId = () => `cct_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

async function rowsOf(exec: Exec, customerId: string): Promise<CustomerContact[]> {
  const rows = await exec
    .select()
    .from(customerContacts)
    .where(eq(customerContacts.customerId, customerId))
    .orderBy(asc(customerContacts.sortOrder), asc(customerContacts.createdAt));
  return sortContacts(
    rows.map((r) => ({
      id: r.id,
      customerId: r.customerId,
      name: r.name,
      role: r.role,
      phone: r.phone,
      email: r.email,
      note: r.note,
      isPrimary: r.isPrimary,
      forWhatsapp: r.forWhatsapp,
      forPaymentReminders: r.forPaymentReminders,
      sortOrder: r.sortOrder,
      updatedAt: r.updatedAt.toISOString(),
    })),
  );
}

/**
 * Write the customer columns the contacts imply, where they differ. Only the
 * columns that moved are written, so a contact edit that changes nothing on
 * the record does not touch `customers.updated_at` — the handset's delta reads
 * that, and a bump would re-send the row to every phone for nothing.
 */
export async function syncContactMirrors(exec: Exec, customerId: string): Promise<void> {
  const contacts = await rowsOf(exec, customerId);
  const [c] = await exec
    .select({
      phone: customers.phone,
      contactPerson: customers.contactPerson,
      whatsappPhone: customers.whatsappPhone,
      paymentWhatsappPhone: customers.paymentWhatsappPhone,
      altPhone: customers.altPhone,
    })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!c) return;
  const m = mirrorsFrom(contacts);
  const set: Partial<typeof customers.$inferInsert> = {};
  if (m.phone !== undefined && m.phone !== c.phone) set.phone = m.phone;
  if (m.contactPerson !== undefined && m.contactPerson !== c.contactPerson) set.contactPerson = m.contactPerson;
  if (m.whatsappPhone !== c.whatsappPhone) set.whatsappPhone = m.whatsappPhone;
  if (m.paymentWhatsappPhone !== c.paymentWhatsappPhone) set.paymentWhatsappPhone = m.paymentWhatsappPhone;
  if (m.altPhone !== c.altPhone) set.altPhone = m.altPhone;
  if (Object.keys(set).length) {
    await exec.update(customers).set({ ...set, updatedAt: new Date() }).where(eq(customers.id, customerId));
  }
}

/**
 * FOLD THE COLUMNS BACK IN, so no number is lost to a writer that does not
 * know about contacts.
 *
 * The sheet fills a blank `whatsapp_phone`; the handset's customer edit sets
 * `phone`, `alt_phone` and `whatsapp_phone` directly; a lead captured before
 * contacts existed has only the columns. Each number found on the record and
 * not in the list is ADDED, and a column that names a number is taken as that
 * number's designation — the column is the newer statement, because every
 * write made through contacts already left the two agreeing. Idempotent: on
 * an agreeing pair it reads two rows and writes nothing.
 */
export async function reconcileContacts(customerId: string, actorId: string | null = null): Promise<CustomerContact[]> {
  return db.transaction(async (tx) => {
    const [c] = await tx
      .select({
        phone: customers.phone,
        contactPerson: customers.contactPerson,
        whatsappPhone: customers.whatsappPhone,
        paymentWhatsappPhone: customers.paymentWhatsappPhone,
        altPhone: customers.altPhone,
      })
      .from(customers)
      .where(eq(customers.id, customerId));
    if (!c) return [];
    let contacts = await rowsOf(tx, customerId);
    let changed = false;

    const ensure = async (
      raw: string | null,
      designation: ContactDesignation | null,
      name: string | null,
    ): Promise<void> => {
      const number = (raw ?? "").trim();
      if (!number || !last10(number)) return;
      let found = contacts.find((x) => last10(x.phone) === last10(number));
      if (!found) {
        const row = {
          id: newId(),
          customerId,
          name: designation === "primary" ? name : null,
          role: "other",
          phone: number,
          sortOrder: contacts.length,
          createdById: actorId,
          updatedById: actorId,
        };
        await tx.insert(customerContacts).values(row);
        changed = true;
        contacts = await rowsOf(tx, customerId);
        found = contacts.find((x) => x.id === row.id)!;
      }
      if (!designation) return;
      const flag = FLAG[designation];
      if (found[flag.key]) return;
      await tx
        .update(customerContacts)
        .set(flagSet(designation, false))
        .where(and(eq(customerContacts.customerId, customerId), flag.column));
      await tx
        .update(customerContacts)
        .set({ ...flagSet(designation, true), updatedAt: new Date() })
        .where(eq(customerContacts.id, found.id));
      changed = true;
      contacts = await rowsOf(tx, customerId);
    };

    await ensure(c.phone, "primary", c.contactPerson?.trim() || null);
    await ensure(c.whatsappPhone, "whatsapp", null);
    await ensure(c.paymentWhatsappPhone, "payment", null);
    await ensure(c.altPhone, null, null);

    /* A column somebody EMPTIED is a designation taken away — the handset's
       customer edit can clear the WhatsApp number. Left flagged, the screen
       would name a WhatsApp number the senders no longer use. */
    for (const [col, d] of [[c.whatsappPhone, "whatsapp"], [c.paymentWhatsappPhone, "payment"]] as const) {
      if (!(col ?? "").trim() && contacts.some((x) => x[FLAG[d].key])) {
        await tx.update(customerContacts).set(flagSet(d, false)).where(eq(customerContacts.customerId, customerId));
        changed = true;
        contacts = await rowsOf(tx, customerId);
      }
    }

    if (changed) await syncContactMirrors(tx, customerId);
    return changed ? rowsOf(tx, customerId) : contacts;
  });
}

const FLAG = {
  primary: { key: "isPrimary", column: eq(customerContacts.isPrimary, true) },
  whatsapp: { key: "forWhatsapp", column: eq(customerContacts.forWhatsapp, true) },
  payment: { key: "forPaymentReminders", column: eq(customerContacts.forPaymentReminders, true) },
} as const;

function flagSet(d: ContactDesignation, v: boolean): Partial<typeof customerContacts.$inferInsert> {
  return d === "primary" ? { isPrimary: v } : d === "whatsapp" ? { forWhatsapp: v } : { forPaymentReminders: v };
}

/** The list as a screen should show it — folded in first, then read. */
export async function listCustomerContacts(customerId: string): Promise<CustomerContact[]> {
  return reconcileContacts(customerId);
}

export type ContactInput = {
  name?: string | null;
  role?: string | null;
  phone: string;
  email?: string | null;
  note?: string | null;
};

type Clean = { name: string | null; role: ContactRole; phone: string; mobile: boolean; email: string | null; note: string | null };

function clean(input: ContactInput): { ok: true; value: Clean } | { ok: false; field: string; reason: string } {
  const phone = normalisePhone(input.phone);
  if (!phone.ok) return { ok: false, field: "phone", reason: phone.reason };
  const email = (input.email ?? "").trim() || null;
  const emailWrong = emailProblem(email);
  if (emailWrong) return { ok: false, field: "email", reason: emailWrong };
  const role = (CONTACT_ROLE_CODES as readonly string[]).includes(input.role ?? "")
    ? (input.role as ContactRole)
    : "other";
  const name = (input.name ?? "").trim().slice(0, 120) || null;
  const note = (input.note ?? "").trim().slice(0, 500) || null;
  return { ok: true, value: { name, role, phone: phone.phone, mobile: phone.mobile, email, note } };
}

function duplicateOf(contacts: CustomerContact[], phone: string, except?: string): CustomerContact | undefined {
  return contacts.find((c) => c.id !== except && last10(c.phone) === last10(phone));
}

async function audit(
  exec: Exec,
  actorId: string,
  action: string,
  customerId: string,
  before: unknown,
  after: unknown,
) {
  await exec.insert(auditLog).values({
    id: `aud_${randomUUID().slice(0, 12)}`,
    actorId,
    action,
    entityType: "customer",
    entityId: customerId,
    beforeState: before as never,
    afterState: after as never,
  });
}

/**
 * Add a person. The first contact on a customer is primary by construction —
 * a customer with contacts and no number to ring is not a state worth having.
 * `designations` lets the form mark the new number in the same write.
 */
export async function addContact(
  customerId: string,
  input: ContactInput & { designations?: ContactDesignation[] },
  actorId: string,
): Promise<Result<CustomerContact[]>> {
  const parsed = clean(input);
  if (!parsed.ok) return err(parsed.reason, "validation", [{ field: parsed.field, message: parsed.reason }]);
  const v = parsed.value;
  const wants = new Set(input.designations ?? []);
  if (!v.mobile && (wants.has("whatsapp") || wants.has("payment"))) {
    return err("WhatsApp needs a mobile number — this looks like a landline.", "validation", [
      { field: "phone", message: "Not a mobile." },
    ]);
  }
  await reconcileContacts(customerId, actorId);
  return db.transaction(async (tx) => {
    const contacts = await rowsOf(tx, customerId);
    const dup = duplicateOf(contacts, v.phone);
    if (dup) {
      return err(
        `That number is already on this customer${dup.name ? ` as ${dup.name}` : ""}.`,
        "duplicate",
        [{ field: "phone", message: "Already listed." }],
      );
    }
    if (!contacts.length) wants.add("primary");
    for (const d of wants) {
      await tx.update(customerContacts).set(flagSet(d, false)).where(and(eq(customerContacts.customerId, customerId), FLAG[d].column));
    }
    const row = {
      id: newId(),
      customerId,
      name: v.name,
      role: v.role,
      phone: v.phone,
      email: v.email,
      note: v.note,
      isPrimary: wants.has("primary"),
      forWhatsapp: wants.has("whatsapp"),
      forPaymentReminders: wants.has("payment"),
      sortOrder: contacts.length ? Math.max(...contacts.map((c) => c.sortOrder)) + 1 : 0,
      createdById: actorId,
      updatedById: actorId,
    };
    await tx.insert(customerContacts).values(row);
    await syncContactMirrors(tx, customerId);
    await audit(tx, actorId, "customer.contact.add", customerId, null, {
      name: v.name, role: v.role, phone: v.phone, designations: [...wants],
    });
    return ok(await rowsOf(tx, customerId), "Contact added");
  });
}

export async function updateContact(
  contactId: string,
  input: ContactInput,
  actorId: string,
): Promise<Result<CustomerContact[]>> {
  const [existing] = await db.select().from(customerContacts).where(eq(customerContacts.id, contactId));
  if (!existing) return err("That contact no longer exists.", "not_found");
  const parsed = clean(input);
  if (!parsed.ok) return err(parsed.reason, "validation", [{ field: parsed.field, message: parsed.reason }]);
  const v = parsed.value;
  if (!v.mobile && (existing.forWhatsapp || existing.forPaymentReminders)) {
    return err(
      "This contact gets WhatsApp messages, and WhatsApp needs a mobile number. Move WhatsApp to another number first, or enter a mobile.",
      "validation",
      [{ field: "phone", message: "Not a mobile." }],
    );
  }
  return db.transaction(async (tx) => {
    const contacts = await rowsOf(tx, existing.customerId);
    const dup = duplicateOf(contacts, v.phone, contactId);
    if (dup) {
      return err(
        `That number is already on this customer${dup.name ? ` as ${dup.name}` : ""}.`,
        "duplicate",
        [{ field: "phone", message: "Already listed." }],
      );
    }
    await tx
      .update(customerContacts)
      .set({ name: v.name, role: v.role, phone: v.phone, email: v.email, note: v.note, updatedAt: new Date(), updatedById: actorId })
      .where(eq(customerContacts.id, contactId));
    await syncContactMirrors(tx, existing.customerId);
    await audit(tx, actorId, "customer.contact.update", existing.customerId,
      { name: existing.name, role: existing.role, phone: existing.phone, email: existing.email },
      { name: v.name, role: v.role, phone: v.phone, email: v.email });
    return ok(await rowsOf(tx, existing.customerId), "Contact saved");
  });
}

/**
 * Remove a person. The LAST contact cannot go — `customers.phone` is what a
 * bill and a call need, and it is NOT NULL for that reason. A primary that
 * goes hands the role to the next contact in the list; a WhatsApp or
 * payment-reminder number that goes is NOT handed on, because guessing who
 * should get money reminders next is a decision, and the fallback (the
 * WhatsApp number, then the phone) is already the honest default.
 */
export async function removeContact(contactId: string, actorId: string): Promise<Result<CustomerContact[]>> {
  const [existing] = await db.select().from(customerContacts).where(eq(customerContacts.id, contactId));
  if (!existing) return err("That contact no longer exists.", "not_found");
  return db.transaction(async (tx) => {
    const contacts = await rowsOf(tx, existing.customerId);
    if (contacts.length <= 1) {
      return err("A customer needs at least one number. Add another contact before removing this one.", "rule_violation");
    }
    await tx.delete(customerContacts).where(eq(customerContacts.id, contactId));
    if (existing.isPrimary) {
      const next = contacts.find((c) => c.id !== contactId)!;
      await tx.update(customerContacts).set({ isPrimary: true, updatedAt: new Date() }).where(eq(customerContacts.id, next.id));
    }
    await syncContactMirrors(tx, existing.customerId);
    await audit(tx, actorId, "customer.contact.remove", existing.customerId,
      { name: existing.name, phone: existing.phone, isPrimary: existing.isPrimary, forWhatsapp: existing.forWhatsapp, forPaymentReminders: existing.forPaymentReminders },
      null);
    const fell = [
      existing.forWhatsapp ? "WhatsApp now goes to the primary number" : null,
      existing.forPaymentReminders ? "payment reminders now go to the WhatsApp number" : null,
    ].filter(Boolean);
    return ok(await rowsOf(tx, existing.customerId), fell.length ? `Contact removed — ${fell.join("; ")}.` : "Contact removed");
  });
}

/**
 * Mark (or unmark) a contact as the primary, WhatsApp or payment-reminder
 * number. Marking takes the mark off whoever held it, in the same
 * transaction, which the partial unique indexes then hold true. Primary can
 * only be MOVED, never cleared: there is always somebody to ring.
 */
export async function designateContact(
  contactId: string,
  designation: ContactDesignation,
  on: boolean,
  actorId: string,
): Promise<Result<CustomerContact[]>> {
  const [existing] = await db.select().from(customerContacts).where(eq(customerContacts.id, contactId));
  if (!existing) return err("That contact no longer exists.", "not_found");
  if (designation === "primary" && !on) {
    return err("Pick another contact as primary instead — a customer always has a number to ring.", "rule_violation");
  }
  if (on && designation !== "primary" && !normalisePhone(existing.phone).ok) {
    return err("That number cannot be read as a phone number.", "validation");
  }
  if (on && designation !== "primary") {
    const n = normalisePhone(existing.phone);
    if (!(n.ok && n.mobile)) return err("WhatsApp needs a mobile number — this one looks like a landline.", "validation");
  }
  const flag = FLAG[designation];
  return db.transaction(async (tx) => {
    if (on) {
      await tx
        .update(customerContacts)
        .set(flagSet(designation, false))
        .where(and(eq(customerContacts.customerId, existing.customerId), flag.column, ne(customerContacts.id, contactId)));
    }
    await tx
      .update(customerContacts)
      .set({ ...flagSet(designation, on), updatedAt: new Date(), updatedById: actorId })
      .where(eq(customerContacts.id, contactId));
    await syncContactMirrors(tx, existing.customerId);
    await audit(tx, actorId, "customer.contact.designate", existing.customerId, null, {
      designation, on, contactId, phone: existing.phone,
    });
    const words =
      designation === "primary"
        ? "Primary number changed"
        : designation === "whatsapp"
          ? on ? "WhatsApp will go to this number" : "WhatsApp will go to the primary number"
          : on ? "Payment reminders will go to this number" : "Payment reminders will go to the WhatsApp number";
    return ok(await rowsOf(tx, existing.customerId), words);
  });
}

/** The name on the primary contact, for a caller that only knows `contact_person`. */
export async function renamePrimaryContact(customerId: string, name: string | null, actorId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(customerContacts)
      .set({ name, updatedAt: new Date(), updatedById: actorId })
      .where(and(eq(customerContacts.customerId, customerId), eq(customerContacts.isPrimary, true)));
    await syncContactMirrors(tx, customerId);
  });
}

/** Which customer a contact belongs to — for the action's scope check. */
export async function customerOfContact(contactId: string): Promise<string | null> {
  const [row] = await db
    .select({ customerId: customerContacts.customerId })
    .from(customerContacts)
    .where(eq(customerContacts.id, contactId));
  return row?.customerId ?? null;
}

/**
 * Every customer whose contacts a PERSON has written — the sheet asks, and
 * leaves their WhatsApp number alone. A row the migration or a reconcile
 * carried in names nobody, and the sheet may still fill a blank there.
 */
export async function customersWithDecidedContacts(): Promise<Set<string>> {
  const rows = await db.execute<{ customer_id: string }>(
    sql`select distinct customer_id from customer_contacts where created_by_id is not null or updated_by_id is not null`,
  );
  return new Set(rows.map((r) => r.customer_id));
}
