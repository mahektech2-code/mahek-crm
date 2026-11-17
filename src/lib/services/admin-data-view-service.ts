import "server-only";

import { and, desc, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { APP_TIMEZONE } from "@/lib/business-date";
import { products, sheetSyncRuns } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { sheetSwitches, sourceRetired } from "@/lib/engines/sheet-retirement";

/* ---------------------------------------------------------------------------
 * Small reads the Business data screens draw beside what their own services
 * already answer — each one a fact MahekOne records, nothing estimated.
 * ------------------------------------------------------------------------- */

/** How many SKUs a console edit has set apart from the generated seed (`edited_at`). */
export async function editedSkuCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .where(and(isNotNull(products.finishedGoodId), isNotNull(products.editedAt)));
  return Number(row?.n ?? 0);
}

/** Which of these SKUs carry a console edit. */
export async function editedSkuIds(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(and(inArray(products.id, ids), isNotNull(products.editedAt)));
  return rows.map((r) => r.id);
}

/* ------------------------------------------------------------ sheets */


/** Every sheet MahekOne reads, in the order the office thinks of them. */
const SHEET_SOURCES: Array<{ key: string; label: string; retirable?: true }> = [
  { key: "order_details", label: "Order Details", retirable: true },
  { key: "payment_status", label: "Payment Status", retirable: true },
  { key: "taken_order", label: "Taken Order", retirable: true },
  { key: "sales_party", label: "Sales Party", retirable: true },
  { key: "employee_details", label: "Employee Details" },
  { key: "field_activity", label: "EMP 2.0 activity" },
  { key: "customer_master", label: "EMP 2.0 shop master" },
];

export type SheetSourceCard = {
  key: string;
  label: string;
  /** live, failing, retired (a switch stopped it), or never read here. */
  state: "live" | "failing" | "retired" | "never";
  /** When it was last read, ISO. */
  at: string | null;
  read: number | null;
  created: number | null;
  updated: number | null;
  error: string | null;
  retiredWhy: string | null;
};

/** One card per sheet: its newest run, and whether a switch has retired it. */
export async function sheetSourceCards(): Promise<SheetSourceCard[]> {
  const [runs, config] = await Promise.all([
    db
      .select({
        source: sheetSyncRuns.source,
        status: sheetSyncRuns.status,
        read: sheetSyncRuns.rowsRead,
        created: sheetSyncRuns.rowsCreated,
        updated: sheetSyncRuns.rowsUpdated,
        startedAt: sheetSyncRuns.startedAt,
        finishedAt: sheetSyncRuns.finishedAt,
        error: sheetSyncRuns.error,
      })
      .from(sheetSyncRuns)
      .orderBy(desc(sheetSyncRuns.startedAt))
      .limit(400),
    getConfig(),
  ]);
  const switches = sheetSwitches(config);
  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!latest.has(r.source)) latest.set(r.source, r);
  return SHEET_SOURCES.map((s) => {
    const run = latest.get(s.key) ?? null;
    const why = s.retirable ? sourceRetired(s.key as "order_details", switches) : null;
    return {
      key: s.key,
      label: s.label,
      state: why ? "retired" : !run ? "never" : run.status === "failed" ? "failing" : "live",
      at: run ? (run.finishedAt ?? run.startedAt).toISOString() : null,
      read: run?.read ?? null,
      created: run?.created ?? null,
      updated: run?.updated ?? null,
      error: run?.status === "failed" ? run.error : null,
      retiredWhy: why,
    };
  });
}

export type ConflictRow = {
  id: string;
  /** The order number, or PARTY for a customer-master disagreement. */
  ref: string;
  customer: string | null;
  field: string;
  sheetValue: string | null;
  appValue: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
};

/** Where the sheet disagrees with a decision a person made, still unseen. */
export async function openConflicts(limit = 200): Promise<{ rows: ConflictRow[]; total: number }> {
  const rows = (await db.execute(sql`
    select sc.id, sc.entity_type, sc.field, sc.sheet_value, sc.app_value, sc.decided_at,
           coalesce(o.order_no, o.external_ref) as order_ref,
           coalesce(oc.name, pc.name) as customer,
           u.name as decided_by,
           count(*) over () as total
      from sync_conflicts sc
      left join orders o on sc.entity_type = 'orders' and o.id = sc.entity_id
      left join customers oc on oc.id = o.customer_id
      left join customers pc on sc.entity_type = 'customers' and pc.id = sc.entity_id
      left join users u on u.id = sc.decided_by_id
     where sc.resolved_at is null
     order by sc.detected_at desc
     limit ${limit}
  `)) as unknown as Array<{
    id: string;
    entity_type: string;
    field: string;
    sheet_value: string | null;
    app_value: string | null;
    decided_at: Date | string | null;
    order_ref: string | null;
    customer: string | null;
    decided_by: string | null;
    total: number | string;
  }>;
  return {
    total: Number(rows[0]?.total ?? 0),
    rows: rows.map((r) => ({
      id: r.id,
      ref: r.entity_type === "orders" ? (r.order_ref ?? "ORDER") : "PARTY",
      customer: r.customer,
      field: r.field,
      sheetValue: r.sheet_value,
      appValue: r.app_value,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    })),
  };
}

/* ------------------------------------------------------------ data health */

/**
 * When each derived figure was last rebuilt: the newer of the last nightly
 * pass that finished cleanly (it rebuilds them all) and the last "Rebuild"
 * pressed for that figure. Null where neither is recorded.
 */
export async function derivedLastRebuilt(ids: readonly string[]): Promise<Record<string, string | null>> {
  const rows = (await db.execute(sql`
    select f.id,
           greatest(
             (select max(j.finished_at) from job_runs j where j.job = 'nightly' and j.ok and j.finished_at is not null),
             (select max(a.at) from audit_log a where a.action = 'job.rebuild' and a.entity_type = 'derived_figure' and a.entity_id = f.id)
           ) as at
      from unnest(${sql.raw(`array[${ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(",")}]::text[]`)}) as f(id)
  `)) as unknown as Array<{ id: string; at: Date | string | null }>;
  return Object.fromEntries(rows.map((r) => [r.id, r.at ? new Date(r.at).toISOString() : null]));
}

export type ExtraCheck = { id: string; label: string; n: number; tone: "danger" | "warn"; hint?: string; href?: string };

/**
 * Three more loose ends the book records, beside the console's own checks:
 * a phone on three or more shops (a placeholder, not a person), a working
 * lead with nothing owed by anybody (§24), and a field day left open past
 * two days (only a punch-out ends a day).
 */
export async function extraHealthChecks(): Promise<ExtraCheck[]> {
  const [r] = (await db.execute(sql`
    select
      (select coalesce(sum(n), 0) from (
         select count(*) as n from customers c
          where c.phone is not null and c.phone <> '' and c.status <> 'deactivated'
          group by c.phone having count(*) >= 3) s)::int as shared,
      (select count(*) from customers c
        where c.kind = 'lead' and c.status <> 'deactivated' and c.lead_stage is not null
          and c.lead_stage::text not in ('won', 'lost') and c.lead_next_action is null)::int as unowed,
      (select count(*) from mbos_attendance_days d
        where d.check_in_at is not null and d.check_out_at is null
          and d.day < (now() at time zone ${APP_TIMEZONE})::date - 2)::int as open_days
  `)) as unknown as Array<{ shared: number; unowed: number; open_days: number }>;
  return [
    { id: "shared-mobiles", label: "Shops on a shared placeholder mobile", n: Number(r?.shared ?? 0), tone: "warn", hint: "One number on three or more shops is a placeholder, not a person" },
    { id: "leads-unowed", label: "Working leads with nothing owed", n: Number(r?.unowed ?? 0), tone: "warn", hint: "A working lead needs a next action somebody owns (§24)", href: "/crm/leads" },
    { id: "open-days", label: "Open days with no punch-out · 2 d+", n: Number(r?.open_days ?? 0), tone: "warn", hint: "Only a punch-out or a regularisation closes a day", href: "/sales/attendance" },
  ];
}
