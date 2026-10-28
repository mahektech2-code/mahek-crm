import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { customerContacts, customers, focusCustomers, reminders, users } from "@/db/schema";
import { listUserApps, listUserModules } from "@/lib/access";
import {
  assertCustomerInScope,
  requireCapability,
  resolveScope,
  scopedToUsers,
  scopedUserIds,
} from "@/lib/access-control";
import { isManager, requireUser } from "@/lib/auth";
import { customerEditRefusal } from "@/lib/customer-edit-gate";
import { mirrorsFrom, phoneForReading } from "@/lib/customer-contacts";
import { longDate, money } from "@/lib/format";
import { reviewVoidPatch } from "@/lib/lead-review-void";
import { today } from "@/lib/recompute";
import { leadRow } from "@/lib/services/lead-service";
import { isReviewer } from "@/lib/services/lead-qualification-flow-service";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";
import { many, phonesHolding, present, word } from "./crm-common";
import { impactPairOf } from "./crm-keys";

/* ---------------------------------------------------------------------------
 * THE CRM'S REMOVALS, said before they happen.
 *
 * A customer record is read in four apps — the CRM, Accounts, the ERP and the
 * salesmen's phones — so even a small removal on it moves something somewhere
 * else: a contact taken off moves which number WhatsApp goes to, a
 * distributor taken off sets aside a lead's qualification review, a
 * deactivation takes the shop off the Call Log and the ERP's order form. Each
 * source here reads what the act would actually do and names it, with the
 * same permission the act asks for so the modal is no wider a window.
 * ------------------------------------------------------------------------- */

const customerSeats = {
  id: customers.id,
  name: customers.name,
  kind: customers.kind,
  ownerId: customers.ownerId,
  salesAmId: customers.salesAmId,
  backOfficeAmId: customers.backOfficeAmId,
  leadManagerId: customers.leadManagerId,
  relationshipOwnerId: customers.relationshipOwnerId,
  salesManagerId: customers.salesManagerId,
  deletedAt: customers.deletedAt,
};

/** In the caller's book, the way `checkReachable` in `actions/third-party.ts` asks it. */
async function reachable(scope: Awaited<ReturnType<typeof requireCapability>>["scope"], customerId: string) {
  const clause = scopedToUsers(scopedUserIds(scope));
  if (!clause) return;
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.id, customerId), clause));
  if (!row) throw Object.assign(new Error("Some of those customers are not in your book."), { name: "NotPermittedError" });
}

/* ================================================== a contact taken off */

/**
 * The customer columns every other screen reads a number from — the phone,
 * the WhatsApp number, the payment-reminder number — are MIRRORS of the
 * contacts. Removing one is worked out by running the same `mirrorsFrom` over
 * the list as it would stand, so what the modal says moves is what the
 * service will write.
 */
export const customerContactImpact: ImpactSource = {
  /* The edit door's own question: Accounts, and the customer in your book. */
  authorize: async (id) => {
    const ctx = await resolveScope();
    const refusal = await customerEditRefusal(ctx.user.id);
    if (refusal) throw Object.assign(new Error(refusal), { name: "NotPermittedError" });
    const [row] = await db
      .select(customerSeats)
      .from(customerContacts)
      .innerJoin(customers, eq(customers.id, customerContacts.customerId))
      .where(eq(customerContacts.id, id));
    if (row) await assertCustomerInScope(row);
  },

  async report(id) {
    const [contact] = await db.select().from(customerContacts).where(eq(customerContacts.id, id));
    if (!contact) return null;
    const [[customer], all] = await Promise.all([
      db.select({ name: customers.name }).from(customers).where(eq(customers.id, contact.customerId)),
      db
        .select()
        .from(customerContacts)
        .where(eq(customerContacts.customerId, contact.customerId))
        .orderBy(asc(customerContacts.sortOrder), asc(customerContacts.id)),
    ]);
    const label = contact.name?.trim() || phoneForReading(contact.phone);

    if (all.length <= 1) {
      return {
        title: label,
        verb: "Remove",
        confirmWord: word(contact.name, "remove"),
        items: [],
        blockers: ["A customer needs at least one number. Add another contact before removing this one."],
      };
    }

    /* The list as it would stand: this one gone, and the primary handed to the
       next in line exactly as `removeContact` hands it. */
    const left = all.filter((c) => c.id !== id);
    const after = contact.isPrimary ? left.map((c, i) => (i === 0 ? { ...c, isPrimary: true } : c)) : left;
    const was = mirrorsFrom(all);
    const now = mirrorsFrom(after);
    const moves: string[] = [];
    if (now.phone !== undefined && now.phone !== was.phone) moves.push(`the phone becomes ${phoneForReading(now.phone)}`);
    if (now.whatsappPhone !== was.whatsappPhone) {
      moves.push(now.whatsappPhone ? `WhatsApp goes to ${phoneForReading(now.whatsappPhone)}` : "WhatsApp goes to the primary number");
    }
    if (now.paymentWhatsappPhone !== was.paymentWhatsappPhone) {
      moves.push(
        now.paymentWhatsappPhone
          ? `payment reminders go to ${phoneForReading(now.paymentWhatsappPhone)}`
          : "payment reminders go to the WhatsApp number",
      );
    }
    if (now.altPhone !== was.altPhone) moves.push(now.altPhone ? `the other number becomes ${phoneForReading(now.altPhone)}` : "no other number is left");

    const tail = contact.phone.replace(/\D/g, "").slice(-10);
    const [waiting, phones] = await Promise.all([
      db.execute<{ n: number }>(sql`
        select count(*)::int as n from wa_messages
         where customer_id = ${contact.customerId}
           and status in ('prepared', 'copied')
           and right(regexp_replace(resolved_destination, '[^0-9]', '', 'g'), 10) = ${tail}`),
      moves.length ? phonesHolding([contact.customerId]) : Promise.resolve([] as string[]),
    ]);

    const items: ImpactItem[] = [
      {
        app: "CRM",
        label: `number on ${customer?.name ?? "the customer"}'s record`,
        effect: "changed",
        count: moves.length ? 1 : 0,
        note: moves.length ? `With it gone, ${moves.join("; ")}.` : undefined,
      },
      {
        app: "MBOS handsets",
        label: phones.length === 1 ? "salesman's phone showing the shop's numbers" : "salesmen's phones showing the shop's numbers",
        effect: "changed",
        count: phones.length,
        examples: phones.slice(0, 5),
        note: "The shop's numbers change there on the next sync.",
      },
      {
        app: "CRM",
        label: `WhatsApp ${many(Number(waiting[0]?.n ?? 0), "message")} already prepared to this number`,
        effect: "kept",
        count: Number(waiting[0]?.n ?? 0),
        note: "A prepared message keeps the number it was written for — send or discard it on WhatsApp.",
      },
    ];
    return {
      title: label,
      verb: "Remove",
      confirmWord: word(contact.name, "remove"),
      items: present(items),
      blockers: [],
    };
  },
};

/* ================================================= a distributor taken off */

export const distributorLinkImpact: ImpactSource = {
  /* `customer.classify`, and the shop in the caller's book — `removeDistributor`'s two questions. */
  authorize: async (id) => {
    const ctx = await requireCapability("customer.classify");
    const [link] = await db.execute<{ customerId: string }>(sql`
      select customer_id as "customerId" from customer_distributors where id = ${id}`);
    if (link) await reachable(ctx.scope, link.customerId);
  },

  async report(id) {
    const [link] = await db.execute<{
      customerId: string;
      distributorId: string;
      shop: string;
      distributor: string;
      thirdParty: boolean;
      isPrimary: boolean;
    }>(sql`
      select d.customer_id as "customerId", d.distributor_customer_id as "distributorId",
             s.name as shop, b.name as distributor, s.third_party as "thirdParty", d.is_primary as "isPrimary"
        from customer_distributors d
        join customers s on s.id = d.customer_id
        join customers b on b.id = d.distributor_customer_id
       where d.id = ${id}`);
    if (!link) return null;

    const [others, delivered, lead, phones] = await Promise.all([
      db.execute<{ name: string }>(sql`
        select b.name from customer_distributors d join customers b on b.id = d.distributor_customer_id
         where d.customer_id = ${link.customerId} and d.id <> ${id} order by d.is_primary desc, b.name`),
      db.execute<{ n: number }>(sql`
        select count(*)::int as n from orders
         where delivery_customer_id = ${link.customerId} and customer_id = ${link.distributorId}`),
      leadRow(link.customerId),
      phonesHolding([link.customerId]),
    ]);

    const title = `${link.distributor} billing ${link.shop}`;
    if (link.thirdParty && !others.length) {
      return {
        title,
        verb: "Remove",
        confirmWord: word(link.distributor, "remove"),
        items: [],
        blockers: [
          "A third-party customer has to have somebody billing it. Name another distributor first, or stop treating this account as a third-party customer.",
        ],
      };
    }

    /* A distributor is one of the things a lead's qualification review was
       given on, so taking one away sets the review aside — unless a reviewer is
       the one doing it, which is `voidReviewForDistributorChange`'s own rule. */
    const user = await requireUser();
    const voids = lead ? reviewVoidPatch(lead, {}, { reviewer: await isReviewer(user), extra: ["distributor"] }) : null;
    const n = Number(delivered[0]?.n ?? 0);

    return {
      title,
      verb: "Remove",
      confirmWord: word(link.distributor, "remove"),
      items: present([
        {
          app: "CRM",
          label: "qualification review on the lead",
          effect: "changed",
          count: voids ? 1 : 0,
          note: "Set aside — the review was given with this distributor named, so it has to be given again.",
        },
        {
          app: "MBOS handsets",
          label: phones.length === 1 ? "salesman's phone listing who bills the shop" : "salesmen's phones listing who bills the shop",
          effect: "changed",
          count: phones.length,
          examples: phones.slice(0, 5),
          note: `${link.distributor} leaves the shop's card on the next sync.`,
        },
        {
          app: "CRM",
          label: `${many(n, "order")} delivered to ${link.shop} on ${link.distributor}'s bill`,
          effect: "kept",
          count: n,
          note: "Untouched — the shop stays in the list as somewhere the order sheet has seen goods go.",
        },
        {
          app: "CRM",
          label: `other ${many(others.length, "distributor")} of ${link.shop}`,
          effect: "kept",
          count: others.length,
          examples: others.slice(0, 5).map((o) => o.name),
          note: link.isPrimary ? `${link.distributor} was the usual one, and none of these becomes it on its own.` : undefined,
        },
      ]),
      blockers: [],
    };
  },
};

/* ============================================ a customer deactivated */

/**
 * Approving a deactivation is the act that changes other screens; asking for
 * one only marks the row for a manager. A deactivated account leaves the Call
 * Log, the automatic WhatsApp reminders, Monthly targets and the ERP's order
 * form — and keeps every rupee it owes, which is the half people assume goes.
 */
export const customerDeactivateImpact: ImpactSource = {
  authorize: async () => {
    await requireCapability("customer.deactivate");
  },

  async report(id) {
    const [c] = await db
      .select({ name: customers.name, status: customers.status, outstanding: customers.outstanding })
      .from(customers)
      .where(eq(customers.id, id));
    if (!c) return null;
    const live = c.status !== "deactivated";
    const day = await today();
    const [year, month] = day.split("-").map(Number);

    const [counts, phones] = await Promise.all([
      db.execute<{ reminders: number; bills: number; targets: number; erp: number }>(sql`
        select
          (select count(*)::int from reminders where customer_id = ${id} and status = 'pending') as reminders,
          (select count(*)::int from bills b where b.customer_id = ${id} and b.amount > b.paid_amount and b.payment_position = 'stated') as bills,
          (select count(*)::int from monthly_targets t where t.customer_id = ${id} and t.year = ${year} and t.month = ${month}) as targets,
          (select count(*)::int from erp_orders o where o.billing_customer_id = ${id} and o.status <> 'Cancel'
              and not exists (select 1 from erp_order_details d where d.order_id = o.id and d.verification = 'Verified')) as erp`),
      live ? phonesHolding([id]) : Promise.resolve([] as string[]),
    ]);
    const k = counts[0] ?? { reminders: 0, bills: 0, targets: 0, erp: 0 };

    return {
      title: c.name,
      verb: "Deactivate",
      confirmWord: word(c.name, "deactivate"),
      items: present([
        {
          app: "CRM",
          label: "customer leaves the Call Log and the automatic WhatsApp reminders",
          effect: "changed",
          count: live ? 1 : 0,
          note: "Nothing brings a deactivated account back on its own — an order does not; only a reactivation does.",
        },
        {
          app: "Accounts",
          label: "target this month on Monthly targets",
          effect: "changed",
          count: live ? Number(k.targets) : 0,
          note: "A deactivated customer leaves the month's target list.",
        },
        {
          app: "ERP",
          label: "party stops being offered on new orders",
          effect: "changed",
          count: live ? 1 : 0,
        },
        {
          app: "MBOS handsets",
          label: phones.length === 1 ? "salesman's phone holding the shop" : "salesmen's phones holding the shop",
          effect: "changed",
          count: phones.length,
          examples: phones.slice(0, 5),
          note: "The shop reads Deactivated on the next sync.",
        },
        {
          app: "Accounts",
          label: `unpaid ${many(Number(k.bills), "bill")} — ${money(Number(c.outstanding))} outstanding`,
          effect: "kept",
          count: Number(k.bills),
          note: "Still owed. Deactivating says nothing about the money.",
        },
        {
          app: "CRM",
          label: `pending ${many(Number(k.reminders), "reminder")}`,
          effect: "kept",
          count: Number(k.reminders),
          note: "Kept on the record, but the Call Log no longer brings the customer up for them.",
        },
        {
          app: "ERP",
          label: `open order ${many(Number(k.erp), "line")} not yet dispatched`,
          effect: "kept",
          count: Number(k.erp),
          note: "Not cancelled — they can still be billed and dispatched.",
        },
      ]),
      blockers: [],
    };
  },
};

/* ================================================ off Focus customers */

export const focusCustomerImpact: ImpactSource = {
  /* The customer in your book and `customer.write` — what `removeFocusCustomer` asks. */
  authorize: async (id) => {
    await requireUser();
    const [row] = await db
      .select(customerSeats)
      .from(focusCustomers)
      .innerJoin(customers, eq(customers.id, focusCustomers.customerId))
      .where(eq(focusCustomers.id, id));
    if (row) await assertCustomerInScope(row);
    await requireCapability("customer.write");
  },

  async report(id) {
    const [entry] = await db
      .select({ note: focusCustomers.note, addedById: focusCustomers.addedById, name: customers.name, addedBy: users.name })
      .from(focusCustomers)
      .innerJoin(customers, eq(customers.id, focusCustomers.customerId))
      .leftJoin(users, eq(users.id, focusCustomers.addedById))
      .where(eq(focusCustomers.id, id));
    if (!entry) return null;
    const user = await requireUser();
    const blockers =
      entry.addedById !== user.id && !isManager(user)
        ? ["Only the person who added this customer, or a manager, can take it off the list."]
        : [];
    return {
      title: entry.name,
      verb: "Take off",
      confirmWord: word(entry.name, "remove"),
      items: present([
        {
          app: "CRM",
          label: "note saying why it was being watched",
          effect: "deleted",
          count: entry.note ? 1 : 0,
          examples: entry.note ? [entry.note.length > 80 ? `${entry.note.slice(0, 80)}…` : entry.note] : undefined,
          note: entry.addedBy ? `Written by ${entry.addedBy}.` : undefined,
        },
        {
          app: "CRM",
          label: "customer and its place on Top customers",
          effect: "kept",
          count: 1,
          note: "Only the watch ends — the customer, its targets and its figures stay.",
        },
      ]),
      blockers,
    };
  },
};

/* ===================================================== a reminder dismissed */

/**
 * A reminder is a callback somebody promised, and it is what puts a customer
 * on the Call Log for that day — above the quiet windows. Dismissing it takes
 * that day away, and where it was holding the order chasing back until the
 * promised date, lets that resume.
 */
export const reminderDismissImpact: ImpactSource = {
  /* `reminder.close`, as the act asks — and the customer in your book, so the
     modal names nobody the reminders list would not have shown. */
  authorize: async (id) => {
    await requireCapability("reminder.close");
    const [row] = await db
      .select(customerSeats)
      .from(reminders)
      .innerJoin(customers, eq(customers.id, reminders.customerId))
      .where(eq(reminders.id, id));
    if (row) await assertCustomerInScope(row);
  },

  async report(id) {
    const [r] = await db
      .select({
        status: reminders.status,
        dueDate: reminders.dueDate,
        note: reminders.note,
        hold: reminders.holdOtherReasonsUntilDue,
        enquiryId: reminders.enquiryId,
        customer: customers.name,
        assignee: users.name,
      })
      .from(reminders)
      .innerJoin(customers, eq(customers.id, reminders.customerId))
      .leftJoin(users, eq(users.id, reminders.assignedUserId))
      .where(eq(reminders.id, id));
    if (!r) return null;
    const day = await today();
    const due = String(r.dueDate);
    const pending = r.status === "pending";

    return {
      title: `${r.customer}, ${longDate(due)}`,
      verb: "Dismiss",
      confirmWord: word(r.customer, "dismiss"),
      items: present([
        {
          app: "CRM",
          label: "call-back on the Call Log",
          effect: "changed",
          count: pending ? 1 : 0,
          examples: [r.note.length > 80 ? `${r.note.slice(0, 80)}…` : r.note],
          note: `${r.customer} no longer comes up${r.assignee ? ` on ${r.assignee}'s list` : ""} for this promise. The reminder stays on the record as dismissed, with your reason.`,
        },
        {
          app: "CRM",
          label: "order and stock-check calls held back for it",
          effect: "changed",
          count: pending && r.hold && due >= day ? 1 : 0,
          note: `They were being held until ${longDate(due)}. They resume, so the customer can come up for an order before then.`,
        },
        {
          app: "Enquiries",
          label: "enquiry this reminder follows up",
          effect: "kept",
          count: r.enquiryId ? 1 : 0,
          note: "The enquiry stays where it is.",
        },
      ]),
      blockers: pending ? [] : ["That reminder is already closed — there is nothing to dismiss."],
    };
  },
};

/* ================================================ an order off an enquiry */

/** The id is `impactPair(enquiryId, orderId)`. */
export const enquiryOrderImpact: ImpactSource = {
  /* The Website Enquiries grant — `requireEnquiriesAccess`'s whole question. */
  authorize: async () => {
    const user = await requireUser();
    if (!(await listUserApps(user.id)).includes("enquiries")) {
      throw Object.assign(new Error("Only somebody with Website Enquiries access can do that."), { name: "NotPermittedError" });
    }
  },

  async report(key) {
    const [enquiryId, orderId] = impactPairOf(key);
    const [row] = await db.execute<{ orderNo: string | null; orderedAt: string; total: string; customer: string | null }>(sql`
      select o.order_no as "orderNo", o.ordered_at::text as "orderedAt", o.total_amount as total, c.name as customer
        from enquiry_orders l
        join orders o on o.id = l.order_id
        left join customers c on c.id = o.customer_id
       where l.enquiry_id = ${enquiryId} and l.order_id = ${orderId}`);
    if (!row) return null;
    const name = row.orderNo ? `order ${row.orderNo}` : "this order";
    return {
      title: name,
      verb: "Unlink",
      confirmWord: word(row.orderNo, "unlink"),
      items: [
        {
          app: "CRM",
          label: "order itself",
          effect: "kept",
          count: 1,
          examples: [`${row.customer ?? "No customer"} · ${money(Number(row.total))}`],
          note: "Only the link goes. The order, its bill and its approval are untouched, and the enquiry's timeline records the unlink.",
        },
      ],
      blockers: [],
    };
  },
};

/* ============================================== a reporting line removed */

/**
 * The org chart is what the CRM reads to name an account's SALES MANAGER: the
 * nightly pass looks up who the salesperson reports to. Removing the line
 * empties that seat on every account named under this person that nobody has
 * decided by hand — which is the reach nobody standing on the org chart sees.
 */
export const reportingLineImpact: ImpactSource = {
  /* HRMS and its Org chart screen — `requireHrms` in `actions/org.ts`. */
  authorize: async () => {
    const user = await requireUser();
    if (!(await listUserApps(user.id)).includes("hrms")) {
      throw Object.assign(new Error("Only somebody with HRMS access can change the org chart."), { name: "NotPermittedError" });
    }
    if (!(await listUserModules(user.id, "hrms")).some((m) => m.key === "hrms.org")) {
      throw Object.assign(new Error("The Org chart screen is not on your account."), { name: "NotPermittedError" });
    }
  },

  async report(employeeId) {
    const [line] = await db.execute<{ person: string; manager: string }>(sql`
      select e.name as person, m.name as manager
        from employee_reporting r
        join employees e on e.id = r.employee_id
        join employees m on m.id = r.manager_id
       where r.employee_id = ${employeeId}`);
    if (!line) return null;
    const [accounts, reports] = await Promise.all([
      db.execute<{ name: string }>(sql`
        select c.name from customers c
         where c.sales_manager_decided_at is null
           and c.deleted_at is null
           and lower(btrim(coalesce(c.sales_person_name, ''))) = lower(btrim(${line.person}))
         order by c.name`),
      db.execute<{ name: string }>(sql`
        select e.name from employee_reporting r join employees e on e.id = r.employee_id
         where r.manager_id = ${employeeId} order by e.name`),
    ]);
    return {
      title: `${line.person} reporting to ${line.manager}`,
      verb: "Remove",
      confirmWord: word(line.person, "remove"),
      items: present([
        {
          app: "CRM",
          label: `${many(accounts.length, "account")} sold by ${line.person}`,
          effect: "changed",
          count: accounts.length,
          examples: accounts.slice(0, 5).map((a) => a.name),
          note: `The nightly pass reads the sales manager off this line, so ${line.manager} stops being named as their sales manager. Accounts somebody set by hand keep theirs.`,
        },
        {
          app: "HRMS",
          label: `${many(reports.length, "person", "people")} reporting to ${line.person}`,
          effect: "kept",
          count: reports.length,
          examples: reports.slice(0, 5).map((r) => r.name),
          note: `They still report to ${line.person}; only ${line.person}'s own line goes.`,
        },
      ]),
      blockers: [],
    };
  },
};
