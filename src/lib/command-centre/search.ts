import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { crore, fmtDate, plural } from "./format";
import { auditFor, notesFor, stampIST } from "./provider";
import type { RecordView, SearchHit } from "./types";

/* ---------------------------------------------------------------------------
 * ONE SEARCH, company-wide (PRD §6.3): customers and leads, staff, orders,
 * bills, price lists and enquiries — the design's "Search customers, staff,
 * price lists, orders, bills". Each hit opens a real record (§6.4).
 * ------------------------------------------------------------------------- */

export type SearchKind = "customer" | "staff" | "order" | "bill" | "pricelist" | "enquiry";

export async function globalSearch(qRaw: string): Promise<(SearchHit & { rk: SearchKind; rid: string })[]> {
  const q = qRaw.trim();
  if (q.length < 2) return [];
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const digits = q.replace(/\D/g, "");
  const phone = digits.length >= 4 ? `%${digits.slice(-10)}%` : null;

  const [customers, staff, orders, bills, lists, enquiries] = await Promise.all([
    db.execute<{ id: string; name: string; city: string | null; kind: string; outstanding: string | null; who: string | null; status: string }>(sql`
      select c.id, c.name, c.city, c.kind::text as kind, c.outstanding::text as outstanding, c.status::text as status,
             coalesce(u.name, c.sales_person_name) as who
        from customers c left join users u on u.id = coalesce(c.sales_am_id, c.back_office_am_id)
       where c.name ilike ${like} or c.city ilike ${like} or c.gstin ilike ${like}
          ${phone ? sql`or regexp_replace(coalesce(c.phone,''), '\\D', '', 'g') like ${phone} or regexp_replace(coalesce(c.alt_phone,''), '\\D', '', 'g') like ${phone}` : sql``}
       order by (c.name ilike ${q.replace(/[%_]/g, "") + "%"}) desc, c.name limit 6
    `),
    db.execute<{ id: string; name: string; email: string; apps: string | null; active: boolean }>(sql`
      select u.id, u.name, u.email, u.active,
             (select string_agg(a.app::text, ', ' order by a.app) from app_access a where a.user_id = u.id) as apps
        from users u
       where u.name ilike ${like} or u.email ilike ${like} ${phone ? sql`or u.phone like ${phone}` : sql``}
       order by u.name limit 4
    `),
    db.execute<{ id: string; no: string | null; name: string; v: string; status: string }>(sql`
      select o.id, o.order_no as no, c.name, o.total_amount::text as v, o.status::text as status
        from orders o join customers c on c.id = o.customer_id
       where o.order_no ilike ${like} or o.external_ref ilike ${like}
       order by o.ordered_at desc limit 4
    `),
    db.execute<{ id: string; no: string; name: string; v: string; due: string | null; bal: string }>(sql`
      select b.id, b.bill_no as no, c.name, b.amount::text as v, b.due_date::text as due, (b.amount - b.paid_amount)::text as bal
        from bills b join customers c on c.id = b.customer_id
       where b.bill_no ilike ${like}
       order by b.bill_date desc limit 4
    `),
    db.execute<{ id: string; name: string; ref: string | null; status: string; to: string | null }>(sql`
      select l.id, l.name, l.ref_no as ref, l.status::text as status, l.effective_to::text as to
        from price_lists l where l.name ilike ${like} or l.ref_no ilike ${like}
       order by l.created_at desc limit 3
    `),
    db
      .execute<{ id: string; name: string | null; company: string | null; stage: string }>(sql`
        select e.id, e.raw_submission->>'name' as name, e.raw_submission->>'company' as company, e.stage::text as stage
          from enquiries e where e.search_text ilike ${like}
         order by e.received_at desc limit 3
      `)
      .catch(() => [] as { id: string; name: string | null; company: string | null; stage: string }[]),
  ]);

  const words = (s: string) => s.replace(/_/g, " ");
  const hits: (SearchHit & { rk: SearchKind; rid: string })[] = [];
  for (const c of customers)
    hits.push({
      kind: c.kind === "lead" ? "Lead" : "Customer",
      name: c.name,
      meta: [c.city ?? "City not recorded", c.status !== "active" ? words(c.status) : null, Number(c.outstanding ?? 0) > 0 ? `owes ${crore(Number(c.outstanding))}` : null, c.who ?? "Unassigned"].filter(Boolean).join(" · "),
      ref: { section: "customers", table: "search", id: c.id },
      rk: "customer",
      rid: c.id,
    });
  for (const u of staff)
    hits.push({ kind: "Staff", name: u.name, meta: [u.apps ?? "No apps", u.active ? null : "Disabled", u.email].filter(Boolean).join(" · "), ref: { section: "people", table: "search", id: u.id }, rk: "staff", rid: u.id });
  for (const o of orders)
    hits.push({ kind: "Order", name: o.no ?? o.id, meta: `${o.name} · ${crore(Number(o.v))} · ${words(o.status)}`, ref: { section: "sales", table: "search", id: o.id }, rk: "order", rid: o.id });
  for (const b of bills)
    hits.push({ kind: "Bill", name: b.no, meta: `${b.name} · ${crore(Number(b.v))}${Number(b.bal) > 0 ? ` · ${crore(Number(b.bal))} open` : " · settled"}${b.due ? ` · due ${fmtDate(b.due)}` : ""}`, ref: { section: "money", table: "search", id: b.id }, rk: "bill", rid: b.id });
  for (const l of lists)
    hits.push({ kind: "Price list", name: l.name, meta: `${l.ref ?? "No reference"} · ${words(l.status)}${l.to ? ` · expires ${fmtDate(l.to)}` : ""}`, ref: { section: "prices", table: "search", id: l.id }, rk: "pricelist", rid: l.id });
  for (const e of enquiries)
    hits.push({ kind: "Enquiry", name: e.name ?? "Enquiry", meta: `${e.company ?? "No company given"} · ${words(e.stage)}`, ref: { section: "enquiries", table: "search", id: e.id }, rk: "enquiry", rid: e.id });
  return hits;
}

/** The record a search hit opens. */
export async function searchRecord(kind: SearchKind, id: string): Promise<RecordView> {
  if (kind === "customer") {
    const [c] = await db.execute<Record<string, string | null>>(sql`
      select c.*, c.kind::text as kind_t, c.status::text as status_t,
             sa.name as sales_name, bo.name as bo_name, sm.name as sm_name
        from customers c
        left join users sa on sa.id = c.sales_am_id
        left join users bo on bo.id = c.back_office_am_id
        left join users sm on sm.id = c.sales_manager_id
       where c.id = ${id}
    `);
    if (!c) throw new Error("That customer no longer exists.");
    const events = await db.execute<{ summary: string; at: string; who: string | null }>(sql`
      select t.summary, t.occurred_at::text as at, u.name as who from timeline_events t
        left join users u on u.id = t.actor_user_id
       where t.customer_id = ${id} order by t.occurred_at desc limit 10
    `);
    return {
      kind: `${c.kind_t === "lead" ? "Lead" : "Customer"} · Customers`,
      title: String(c.name),
      sub: [c.city, c.region].filter(Boolean).join(", ") || "Company-wide record",
      fields: [
        { label: "Contact", value: `${c.contact_person ?? "Not recorded"}${c.phone ? ` · ${c.phone}` : ""}` },
        { label: "Status", value: String(c.status_t).replace(/_/g, " ") },
        { label: "Salesperson", value: c.sales_name ?? c.sales_person_name ?? "Nobody" },
        { label: "Back office", value: c.bo_name ?? c.back_office_name ?? "Nobody" },
        { label: "Sales manager", value: c.sm_name ?? c.sales_manager_person_name ?? "Nobody" },
        { label: "Outstanding", value: crore(Number(c.outstanding ?? 0)) },
        { label: "Last order", value: c.last_order_date ? fmtDate(String(c.last_order_date)) : "Never" },
        { label: "Buying cycle", value: c.cycle_days ? `${c.cycle_days} days${c.cycle_is_default ? " · default, too little history" : ""}` : "Not measured" },
        { label: "Credit days", value: c.credit_days ? `${c.credit_days} days` : "Default" },
        { label: "GSTIN", value: c.gstin ?? "Not recorded" },
        { label: "Scope", value: "Company-wide" },
        { label: "As of", value: stampIST(new Date()) },
      ],
      timeline: [...(await notesFor("customer", id)), ...events.map((e) => ({ what: e.summary, when: `${stampIST(e.at)}${e.who ? ` · ${e.who}` : ""}` }))],
      audit: await auditFor("customer", id),
      acts: [],
      href: { label: "Open in the CRM", url: `/crm/customers/${id}` },
      noteTarget: { kind: "customer", id },
    };
  }
  if (kind === "staff") {
    const [u] = await db.execute<{ name: string; email: string; phone: string | null; active: boolean; role: string; apps: string | null; mgr: string | null; last: string | null }>(sql`
      select u.name, u.email, u.phone, u.active, u.role::text as role, m.name as mgr, u.last_login_at::text as last,
             (select string_agg(a.app::text || coalesce(' (' || a.role::text || ')', ''), ', ' order by a.app) from app_access a where a.user_id = u.id) as apps
        from users u left join users m on m.id = u.reports_to_id where u.id = ${id}
    `);
    if (!u) throw new Error("That person no longer exists.");
    return {
      kind: "Staff · People & organisation",
      title: u.name,
      sub: u.email,
      fields: [
        { label: "Work number", value: u.phone ?? "Not recorded" },
        { label: "Sign-in", value: u.active ? "Enabled" : "Disabled" },
        { label: "Level", value: u.role },
        { label: "Apps", value: u.apps ?? "None" },
        { label: "Reports to", value: u.mgr ?? "Nobody" },
        { label: "Last signed in", value: u.last ? stampIST(u.last) : "Never" },
      ],
      timeline: await notesFor("user", id),
      audit: await auditFor("user", id),
      acts: [],
      noteTarget: { kind: "user", id },
    };
  }
  if (kind === "order") {
    const [o] = await db.execute<Record<string, string | null>>(sql`
      select o.*, o.status::text as status_t, c.name as cname, u.name as taker, a.name as approver,
             to_char(o.ordered_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as on_day
        from orders o join customers c on c.id = o.customer_id
        left join users u on u.id = o.user_id left join users a on a.id = o.approved_by_id
       where o.id = ${id}
    `);
    if (!o) throw new Error("That order no longer exists.");
    return {
      kind: "Order · Sales & order book",
      title: o.order_no ?? `Order for ${o.cname}`,
      sub: `${o.cname} · ${fmtDate(o.on_day)}`,
      fields: [
        { label: "Value", value: crore(Number(o.total_amount ?? 0)) },
        { label: "Status", value: String(o.status_t).replace(/_/g, " ") },
        { label: "Source", value: String(o.source ?? "—") },
        { label: "Taken by", value: o.taker ?? "The order sheet" },
        { label: "Decided by", value: o.approver ?? (o.status_t === "pending_approval" ? "Waiting on accounts" : "—") },
        { label: "Decline reason", value: o.decline_reason ?? "—" },
        { label: "Credit days", value: o.credit_days ? `${o.credit_days} days` : "Default" },
        { label: "Payment due", value: o.payment_due_date ? fmtDate(String(o.payment_due_date)) : "—" },
      ],
      timeline: await notesFor("order", id),
      audit: await auditFor("order", id),
      acts: [],
      noteTarget: { kind: "order", id },
    };
  }
  if (kind === "bill") {
    const [b] = await db.execute<Record<string, string | null>>(sql`
      select b.*, b.status::text as status_t, c.name as cname from bills b join customers c on c.id = b.customer_id where b.id = ${id}
    `);
    if (!b) throw new Error("That bill no longer exists.");
    const allocs = await db.execute<{ amount: string; status: string; at: string; mode: string }>(sql`
      select p.amount::text as amount, r.status::text as status, r.received_at::text as at, r.mode
        from payments p join payment_receipts r on r.id = p.receipt_id where p.bill_id = ${id} order by r.received_at desc limit 10
    `).catch(() => []);
    return {
      kind: "Bill · Money",
      title: String(b.bill_no),
      sub: `${b.cname} · ${fmtDate(String(b.bill_date))}`,
      fields: [
        { label: "Amount", value: crore(Number(b.amount)) },
        { label: "Paid (confirmed)", value: crore(Number(b.paid_amount)) },
        { label: "Balance", value: b.payment_position === "unstated" ? "Not stated — no payment recorded either way" : crore(Number(b.amount) - Number(b.paid_amount)) },
        { label: "Due", value: b.due_date ? fmtDate(String(b.due_date)) : "—" },
        { label: "Status", value: String(b.status_t).replace(/_/g, " ") },
        { label: "Disputed", value: b.disputed ? "Yes" : "No" },
      ],
      timeline: [...(await notesFor("bill", id)), ...allocs.map((a) => ({ what: `${crore(Number(a.amount))} ${a.status === "confirmed" ? "confirmed" : a.status} · ${a.mode}`, when: fmtDate(a.at) }))],
      audit: await auditFor("bill", id),
      acts: [],
      href: { label: "Open the bill in Accounts", url: `/accounts/bills/${id}` },
      noteTarget: { kind: "bill", id },
    };
  }
  if (kind === "pricelist") {
    const [l] = await db.execute<Record<string, string | null>>(sql`
      select l.*, l.status::text as status_t,
             (select count(*)::int from price_list_items i where i.price_list_id = l.id) as items
        from price_lists l where l.id = ${id}
    `).catch(async () => db.execute<Record<string, string | null>>(sql`select l.*, l.status::text as status_t, null as items from price_lists l where l.id = ${id}`));
    if (!l) throw new Error("That price list no longer exists.");
    return {
      kind: "Price list · Price lists",
      title: String(l.name),
      sub: `${l.ref_no ?? "No reference"} · version ${l.version ?? 1}`,
      fields: [
        { label: "State", value: String(l.status_t) },
        { label: "Effective", value: `${l.effective_from ? fmtDate(String(l.effective_from)) : "—"} to ${l.effective_to ? fmtDate(String(l.effective_to)) : "open-ended"}` },
        { label: "Products", value: l.items == null ? "—" : plural(Number(l.items), "product") },
        { label: "Published", value: l.published_at ? stampIST(l.published_at) : "Not yet" },
      ],
      timeline: await notesFor("price_list", id),
      audit: await auditFor("price_list", id),
      acts: [],
      href: { label: "Open the list", url: `/founder/price-lists/${id}` },
      noteTarget: { kind: "price_list", id },
    };
  }
  const [e] = await db.execute<Record<string, string | null>>(sql`
    select e.*, e.stage::text as stage_t, e.priority::text as prio, u.name as who, e.raw_submission::text as raw
      from enquiries e left join users u on u.id = e.assigned_to_id where e.id = ${id}
  `);
  if (!e) throw new Error("That enquiry no longer exists.");
  const raw = JSON.parse(String(e.raw ?? "{}")) as Record<string, unknown>;
  return {
    kind: "Enquiry · Website enquiries",
    title: String(raw.name ?? "Enquiry"),
    sub: String(raw.company ?? raw.email ?? raw.phone ?? ""),
    fields: [
      { label: "Stage", value: String(e.stage_t).replace(/_/g, " ") },
      { label: "Priority", value: String(e.prio) },
      { label: "Assigned to", value: e.who ?? "Nobody" },
      { label: "Received", value: stampIST(e.received_at) },
      { label: "Form", value: String(e.source_form ?? e.category ?? "—") },
      { label: "Message", value: String(raw.message ?? raw.requirement ?? "—") },
    ],
    timeline: await notesFor("enquiry", id),
    audit: await auditFor("enquiry", id),
    acts: [],
    href: { label: "Open in Enquiries", url: `/enquiries/${id}` },
    noteTarget: { kind: "enquiry", id },
  };
}
