import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { listUserModules } from "@/lib/access";
import { resolveScope, scopedToUsers, scopedUserIds } from "@/lib/access-control";
import { money, phoneDisplay, shortDate } from "@/lib/format";
import { globalSearch } from "@/lib/queries";
import { fieldTeam, leadsVisible, managerScope } from "@/lib/services/sales-service";
import { KIND_ORDER, type SearchHit } from "@/lib/search-hit";
import type { AppId } from "@/lib/apps";

/* ---------------------------------------------------------------------------
 * THE HEADER SEARCH, AS THE ERP DOES IT, for the CRM and the Sales Dashboard.
 *
 * One box, one flat list, every row saying what kind of thing it is and
 * opening it: a customer or a lead, a bill or an order by its number, a
 * complaint by what it says, a salesman, a product, and the screens this
 * person can open. It replaced three fixed sections (customers, bills,
 * products) that could find a bill and not open it, and never found a lead.
 *
 * NOTHING HERE WIDENS WHAT SOMEBODY CAN SEE. Customer rows are narrowed by
 * `scopedToUsers` — the CRM's own book — or by the Sales Dashboard's
 * `managerScope`; a kind of record is searched only where the person holds the
 * screen it opens on; a screen is offered only if the grant holds it.
 * ------------------------------------------------------------------------- */

const LIMIT = 14;

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** Order the hits by kind, then keep what the dropdown can show. */
function finish(hits: SearchHit[]): SearchHit[] {
  const rank = (k: string) => {
    const i = KIND_ORDER.indexOf(k);
    return i < 0 ? KIND_ORDER.length : i;
  };
  return hits
    .map((h, i) => ({ h, i }))
    .sort((a, b) => rank(a.h.kind) - rank(b.h.kind) || a.i - b.i)
    .map((x) => x.h)
    .slice(0, LIMIT);
}

/** The screens of one app this person holds whose name matches what was typed. */
async function screens(userId: string, app: AppId, term: string): Promise<SearchHit[]> {
  const t = term.toLowerCase();
  const held = await listUserModules(userId, app);
  return held
    .filter((m) => !m.writeOf && (m.label.toLowerCase().includes(t) || m.group.toLowerCase().includes(t)))
    .slice(0, 4)
    .map((m) => ({ kind: "Screen", name: m.label, meta: m.group, href: m.href }));
}

/** Products: one catalogue for everybody, so never scoped — and information only. */
async function products(like: string, term: string): Promise<SearchHit[]> {
  const rows = await db.execute<{ id: string; name: string; formulation: string | null; packing: string | null }>(sql`
    select p.id, p.name, f.name as formulation, p.packing
      from products p
      left join product_formulations f on f.id = p.formulation_id
      left join product_brands b on b.id = p.brand_id
     where p.active = true
       and (p.name ilike ${like} or coalesce(f.name, '') ilike ${like} or coalesce(b.name, '') ilike ${like}
            or exists (select 1 from product_aliases a where a.product_id = p.id and a.name ilike ${like}))
     order by case when p.name ilike ${term + "%"} then 0 else 1 end, p.display_order, p.name
     limit 3
  `);
  return rows.map((p) => ({
    kind: "Product",
    name: p.name,
    meta: [p.formulation, p.packing].filter(Boolean).join(" · "),
  }));
}

/* ------------------------------------------------------------------ the CRM */

export async function crmSearch(userId: string, q: string): Promise<SearchHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term}%`;
  const digits = digitsOf(term);
  const ctx = await resolveScope();
  const scope = scopedToUsers(scopedUserIds(ctx.scope)) ?? sql`true`;
  const held = new Set((await listUserModules(userId, "crm")).map((m) => m.key));
  const canSee = (...keys: string[]) => keys.some((k) => held.has(k));

  const phoneLike = "%" + digits + "%";
  const customerRows = db.execute<{
    id: string;
    name: string;
    kind: string;
    thirdParty: boolean;
    city: string | null;
    phone: string | null;
    contact: string | null;
    outstanding: number;
  }>(sql`
    select customers.id, customers.name, customers.kind, customers.third_party as "thirdParty", customers.city,
           customers.phone, customers.contact_person as contact, customers.outstanding
      from customers
     where (customers.name ilike ${like}
            or coalesce(customers.contact_person, '') ilike ${like}
            or coalesce(customers.company_name, '') ilike ${like}
            or coalesce(customers.gstin, '') ilike ${like}
            ${digits.length >= 4 ? sql`or customers.phone like ${phoneLike} or coalesce(customers.whatsapp_phone, '') like ${phoneLike} or coalesce(customers.alt_phone, '') like ${phoneLike}` : sql``})
       and ${scope}
     order by case when customers.name ilike ${term + "%"} then 0 else 1 end, customers.name
     limit 7`);

  const billRows =
    canSee("crm.bills", "crm.outstanding", "crm.payments") && term.length >= 3
      ? db.execute<{ id: string; billNo: string; amount: number; status: string; customerId: string; customer: string }>(sql`
          select bills.id, bills.bill_no as "billNo", bills.amount, bills.status, bills.customer_id as "customerId", customers.name as customer
            from bills join customers on customers.id = bills.customer_id
           where bills.bill_no ilike ${like} and ${scope}
           order by bills.bill_date desc limit 4`)
      : Promise.resolve([]);

  const orderNo = /^(?:ord(?:er)?[-\s#]*)?(\d{2,})$/i.exec(term)?.[1];
  const orderRows =
    orderNo && canSee("crm.customers", "crm.history", "crm.bills")
      ? db.execute<{ customerId: string; orderNo: string; amount: number; status: string; at: string; customer: string }>(sql`
          select orders.customer_id as "customerId", orders.order_no as "orderNo", orders.total_amount as amount,
                 orders.status, orders.ordered_at as at, customers.name as customer
            from orders join customers on customers.id = orders.customer_id
           where orders.order_no = ${orderNo} and ${scope}
           order by orders.ordered_at desc limit 3`)
      : Promise.resolve([]);

  const complaintRows =
    canSee("crm.complaints") && term.length >= 3
      ? db.execute<{ id: string; category: string; status: string; description: string; customer: string }>(sql`
          select complaints.id, complaints.category, complaints.status, complaints.description, customers.name as customer
            from complaints join customers on customers.id = complaints.customer_id
           where (complaints.description ilike ${like} or complaints.category::text ilike ${like}) and ${scope}
           order by complaints.created_at desc limit 3`)
      : Promise.resolve([]);

  const [cust, bill, order, complaint, product, screen] = await Promise.all([
    customerRows,
    billRows,
    orderRows,
    complaintRows,
    products(like, term),
    screens(userId, "crm", term),
  ]);

  const hits: SearchHit[] = [];
  for (const c of cust) {
    const lead = c.kind === "lead";
    hits.push({
      kind: lead ? "Lead" : c.thirdParty ? "Third party" : "Customer",
      name: c.name,
      meta: [
        c.city,
        c.phone ? phoneDisplay(c.phone) : null,
        c.contact && c.contact !== c.name ? c.contact : null,
        Number(c.outstanding) > 0 ? `owes ${money(Number(c.outstanding))}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      href: lead && held.has("crm.leads") ? `/crm/leads/${c.id}` : `/crm/customers/${c.id}`,
    });
  }
  for (const b of bill) {
    hits.push({
      kind: "Bill",
      name: b.billNo,
      meta: `${b.customer} · ${money(Number(b.amount))} · ${b.status}`,
      href: held.has("crm.bills") ? `/crm/bills?customer=${b.customerId}` : `/crm/customers/${b.customerId}`,
    });
  }
  for (const o of order) {
    hits.push({
      kind: "Order",
      name: `Order ${o.orderNo}`,
      meta: `${o.customer} · ${shortDate(o.at)} · ${money(Number(o.amount))} · ${String(o.status).replaceAll("_", " ")}`,
      href: `/crm/customers/${o.customerId}`,
    });
  }
  for (const c of complaint) {
    hits.push({
      kind: "Complaint",
      name: `${c.customer} — ${String(c.category).replaceAll("_", " ")}`,
      meta: `${String(c.status).replaceAll("_", " ")} · ${c.description.slice(0, 70)}`,
      href: `/crm/complaints?open=${c.id}`,
    });
  }
  hits.push(...product, ...screen);
  return finish(hits);
}

/* ------------------------------------------------------- the Sales Dashboard */

export async function salesSearch(userId: string, q: string): Promise<SearchHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const needle = term.toLowerCase();
  const like = `%${term}%`;
  const digits = digitsOf(term);
  const held = new Set((await listUserModules(userId, "sales")).map((m) => m.key));

  const [team, shops, scope, product, screen] = await Promise.all([
    fieldTeam(),
    globalSearch(term),
    managerScope(),
    products(like, term),
    screens(userId, "sales", term),
  ]);

  /* Matched in memory: `fieldTeam` is the definition of who is in the field,
     narrowed by `managerScope` — a second query against `users` would be a
     second answer to "who is on this team". */
  const salesmen = team
    .filter(
      (t) =>
        t.name.toLowerCase().includes(needle) ||
        (t.email ?? "").toLowerCase().includes(needle) ||
        (digits.length >= 4 && digitsOf(t.phone ?? "").includes(digits)),
    )
    .slice(0, 5);

  const leads = held.has("sales.leads")
    ? await db.execute<{ id: string; name: string; city: string | null; stage: string | null; owner: string | null }>(sql`
        select c.id, c.name, c.city, c.lead_stage as stage, u.name as owner
          from customers c left join users u on u.id = c.owner_id
         where c.kind = 'lead'
           and (c.name ilike ${like} or coalesce(c.contact_person, '') ilike ${like}
                ${digits.length >= 4 ? sql`or c.phone like ${"%" + digits + "%"}` : sql``})
           ${leadsVisible(scope)}
         order by case when c.name ilike ${term + "%"} then 0 else 1 end, c.name
         limit 4`)
    : [];

  const hits: SearchHit[] = [
    ...salesmen.map((s) => ({
      kind: "Salesman",
      name: s.name,
      meta: [s.phone ? phoneDisplay(s.phone) : null, `${s.customerCount} shop${s.customerCount === 1 ? "" : "s"}`, s.active ? null : "inactive"]
        .filter(Boolean)
        .join(" · "),
      href: `/sales/people/${s.id}`,
    })),
    ...shops.customers.map((c) => ({
      kind: "Customer",
      name: c.name,
      meta: [c.city, c.phone ? phoneDisplay(c.phone) : null].filter(Boolean).join(" · "),
      quick: c.id,
    })),
    ...leads.map((l) => ({
      kind: "Lead",
      name: l.name,
      meta: [l.city, l.stage ? l.stage.replaceAll("_", " ") : null, l.owner].filter(Boolean).join(" · "),
      href: `/sales/leads/${l.id}`,
    })),
    ...product,
    ...screen,
  ];
  return finish(hits);
}
