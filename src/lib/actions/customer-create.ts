"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, customers, employees, users } from "@/db/schema";
import { canFor, requireCapability } from "@/lib/access-control";
import { canonicalState } from "@/lib/india-states";
import { newCustomerSchema, type NewCustomerInput, type SeatPick } from "@/lib/new-customer";
import { notifyUsers } from "@/lib/notify";
import { partyNameKey } from "@/lib/sheet-parse";
import { reconcileContacts } from "@/lib/services/customer-contact-service";
import { placeShopsNow } from "@/lib/services/place-tree-service";
import { err, fromThrown, ok, type Result } from "@/lib/result";

/* ---------------------------------------------------------------------------
 * ADDING A CUSTOMER DIRECTLY — the Accounts desk's "Add customer".
 *
 * The CRM's own `createCustomer` writes a LEAD: somebody on the phones met a
 * shop that has never ordered. This is the other door, and it writes an
 * account we INVOICE — `kind = 'customer'` — because the person standing at it
 * is the ledger desk opening an account for a shop that is about to be billed.
 *
 * WHY IT IS `customer.reassign`. Creating an account with its seats filled in
 * decides whose book it is in, whose Call Log and collections list it lands
 * on, and whose target its orders count toward. That is the decision
 * `customer.reassign` exists to keep with accounts and admin — asked here on
 * the server, because a hidden button is not a permission.
 *
 * NOTHING HAS TO BE WIRED BY HAND AFTERWARDS, and this is why:
 *
 *   - The seats are written with `am_decided_at`, the mark of a person's
 *     decision. The nightly `recomputeSalesPeople` and the party projection
 *     both skip a decided account, so neither restates (or blanks) a seat this
 *     form set — the failure AGENTS.md records for reassignments.
 *   - The mirrors (`sales_person_name`, `back_office_name`,
 *     `sales_manager_person_name`) are written WITH the ids, the rule
 *     `applyAccountManagerChange` follows, so every screen that reads the
 *     sheet's name first shows the person actually holding the seat.
 *   - The state is a canonical name and `placeShopsNow` files the shop on the
 *     location tree at once — which is what the salesman's territory clause
 *     reads, so the shop is on his handset at his next sync.
 *   - The contact is written through `reconcileContacts`, so the contacts list,
 *     the WhatsApp designation and the column mirrors agree from the start.
 *   - The name is the one the party sheet matches on; a later sheet row of the
 *     same name fills this account's blanks rather than creating a second one.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

type ResolvedSeat = { userId: string | null; name: string | null };

/** A seat pick resolved against the database — never a name off the request. */
async function resolveSeat(seat: SeatPick, label: string): Promise<ResolvedSeat | string> {
  if (seat.kind === "none") return { userId: null, name: null };
  if (seat.kind === "user") {
    const [u] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.id, seat.userId), eq(users.active, true)))
      .limit(1);
    return u ? { userId: u.id, name: u.name } : `The ${label} no longer has an active account. Pick somebody else.`;
  }
  const [e] = await db
    .select({ name: employees.name })
    .from(employees)
    .where(and(eq(employees.id, seat.employeeId), eq(employees.status, "active")))
    .limit(1);
  return e ? { userId: null, name: e.name } : `The ${label} is no longer on the current staff list.`;
}

export async function createDirectCustomer(
  raw: NewCustomerInput,
): Promise<Result<{ id: string; name: string }>> {
  try {
    const ctx = await requireCapability("customer.reassign");

    const parsed = newCustomerSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err(issue.message, "validation", [
        { field: String(issue.path[0] ?? ""), message: issue.message },
      ]);
    }
    const v = parsed.data;

    // The credit limit is a money decision — the ledger desk's, as on the edit form.
    if (v.creditLimitPaise !== null && !(await canFor(ctx.user, "payment.confirm"))) {
      return err("The credit limit is set by whoever confirms payments in Accounts.", "not_permitted", [
        { field: "creditLimitPaise", message: "Leave it blank, or ask Accounts." },
      ]);
    }

    /* --- is it already on the book? ------------------------------------- */

    const numbers = [v.phone, v.whatsappPhone].filter(Boolean);
    const [byNumber] = await db
      .select({ name: customers.name })
      .from(customers)
      .where(
        or(
          inArray(customers.phone, numbers),
          inArray(customers.whatsappPhone, numbers),
          // `customers.id` spelled out: Drizzle renders an interpolated column as a bare
          // "id", which inside this subquery would bind to the contact row.
          sql`exists (select 1 from customer_contacts cc where cc.customer_id = customers.id and cc.phone in ${numbers})`,
        ),
      )
      .limit(1);
    if (byNumber) {
      return err(`${byNumber.name} already uses that number.`, "duplicate", [
        { field: "phone", message: `Already on ${byNumber.name}.` },
      ]);
    }
    if (v.gstin) {
      const [byGstin] = await db
        .select({ name: customers.name })
        .from(customers)
        .where(eq(customers.gstin, v.gstin))
        .limit(1);
      if (byGstin) {
        return err(`${byGstin.name} already has that GSTIN.`, "duplicate", [
          { field: "gstin", message: `Already on ${byGstin.name}.` },
        ]);
      }
    }
    if (!v.allowSameName) {
      // The party sheet's own key, so "same name" means what the sync means by it.
      const key = partyNameKey(v.name);
      const sameName = (
        await db
          .select({ name: customers.name, city: customers.city })
          .from(customers)
          .where(sql`upper(regexp_replace(trim(${customers.name}), '\\s+', ' ', 'g')) = ${key}`)
          .limit(1)
      )[0];
      if (sameName) {
        return err(
          `${sameName.name}${sameName.city ? ` (${sameName.city})` : ""} is already on the book under that name. If this is a different shop, tick "It is a different shop" and save again.`,
          "duplicate",
          [{ field: "allowSameName", message: "Same name already on the book." }],
        );
      }
    }

    /* --- the seats ------------------------------------------------------- */

    const sales = await resolveSeat(v.sales, "sales account manager");
    if (typeof sales === "string") return err(sales, "validation", [{ field: "sales", message: sales }]);
    const backOffice = await resolveSeat(v.backOffice, "back office account manager");
    if (typeof backOffice === "string") {
      return err(backOffice, "validation", [{ field: "backOffice", message: backOffice }]);
    }
    let salesManager: ResolvedSeat = { userId: null, name: null };
    if (v.salesManager.kind !== "none") {
      // The sales manager seat has its own, wider capability; asked here too.
      if (!(await canFor(ctx.user, "customer.assignSalesManager"))) {
        return err("Setting the sales manager needs a manager or admin.", "not_permitted", [
          { field: "salesManager", message: "Leave it unassigned." },
        ]);
      }
      const resolved = await resolveSeat(v.salesManager, "sales manager");
      if (typeof resolved === "string") {
        return err(resolved, "validation", [{ field: "salesManager", message: resolved }]);
      }
      salesManager = resolved;
    }

    /* --- the row --------------------------------------------------------- */

    const customerId = id("cus");
    const now = new Date();
    const state = canonicalState(v.state);

    await db.transaction(async (tx) => {
      await tx.insert(customers).values({
        id: customerId,
        name: v.name,
        contactPerson: v.contactPerson || null,
        phone: v.phone,
        whatsappPhone: v.whatsappPhone || null,
        email: v.email || null,
        customerType: v.customerType || null,
        externalCode: v.externalCode || null,
        // An account we invoice. A lead is the CRM's door, not this one.
        kind: "customer",
        status: "active",

        address: v.address || null,
        city: v.city,
        region: state,
        area: v.area || null,
        route: v.route || null,

        gstin: v.gstin || null,
        creditTermDays: v.creditTermDays,
        // The nullable mirror — what says a person STATED the term. See updateCustomer.
        creditDays: v.creditTermDays,
        creditLimitPaise: v.creditLimitPaise,
        priceTag: v.priceTag || null,
        freightTerm: v.freightTerm || null,
        deliveryType: v.deliveryType || null,
        cycleDays: 30,
        cycleIsDefault: true,

        // Whose book: the sales seat. `owner_id` follows it so `ASSIGNED_TO_SQL`
        // can never fall back to whoever pressed Save.
        ownerId: sales.userId,
        salesAmId: sales.userId,
        salesPersonName: sales.name,
        backOfficeAmId: backOffice.userId,
        backOfficeName: backOffice.name,
        salesManagerId: salesManager.userId,
        salesManagerPersonName: salesManager.name,
        // A person decided these seats — the sheet must not restate them.
        amDecidedAt: now,

        createdById: ctx.user.id,
        updatedById: ctx.user.id,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(auditLog).values({
        id: id("aud"),
        actorId: ctx.user.id,
        actorRole: ctx.authorisedBy,
        actorApp: ctx.authorisedIn,
        action: "customer.create",
        entityType: "customer",
        entityId: customerId,
        beforeState: null,
        afterState: {
          ...v,
          state,
          sales: sales.name,
          backOffice: backOffice.name,
          salesManager: salesManager.name,
        } as never,
      });
    });

    // The contacts list from the columns just written: one primary contact,
    // and the WhatsApp number as its own contact where it differs.
    await reconcileContacts(customerId, ctx.user.id);
    // Onto the location tree now, not tonight — the handset's territory reads it.
    await placeShopsNow([customerId]);

    /* --- tell the people it landed on ------------------------------------ */

    const told = new Map<string, string>();
    if (sales.userId) told.set(sales.userId, "is now in your book");
    if (backOffice.userId && !told.has(backOffice.userId)) told.set(backOffice.userId, "has you on its back office");
    if (salesManager.userId && !told.has(salesManager.userId)) told.set(salesManager.userId, "has you as its sales manager");
    told.delete(ctx.user.id);
    if (told.size) {
      await notifyUsers(
        [...told].map(([userId, what]) => ({
          userId,
          title: `New customer: ${v.name}`,
          body: `${ctx.user.name} added ${v.name} (${v.city}, ${state}) — it ${what}.`,
          href: `/crm/customers/${customerId}`,
        })),
      );
    }

    try {
      for (const path of ["/accounts/customers", "/crm/customers", "/crm/call-log", "/crm/payments"]) revalidatePath(path);
    } catch {
      /* no request context (tests, scripts) — nothing cached to invalidate */
    }
    return ok({ id: customerId, name: v.name }, `${v.name} added`);
  } catch (e) {
    return fromThrown(e);
  }
}
