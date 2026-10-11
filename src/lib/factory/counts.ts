import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { calendarDate } from "@/lib/business-date";
import { checkableItems, recordFloorCheck, setFloorCheckReason, type CheckStage } from "@/lib/erp/floor-checks";
import { COUNT_KIND_LABEL, type CountKind } from "@/lib/erp/engines/stock-check";
import { submitCount } from "@/lib/erp/screens/stock-check";
import { countLabel } from "@/lib/erp/stock-check";
import { erpCtxFor, factoryAudit, type FactoryCtx } from "./server";
import type { CheckUnit, CountInput, CountTask, StockCheckInput, StockKit, StockSave } from "./types";

/* ---------------------------------------------------------------------------
 * Stock checks and office counts from the floor. Every department may check.
 *
 * A CHECK is at the godown the factory app has the person standing in, of any
 * item they choose (`lib/erp/floor-checks.ts`). An OFFICE COUNT is one the
 * ERP's Stock accuracy screen opened; it is offered at the godowns this person
 * works at — the ERP's `erp_godown_staff` plus their factory godown — and to
 * everybody on the floor for the Production Head over the whole floor. A count
 * the office gave to one named person is offered to that person only.
 *
 * Neither is ever sent the book before the figure.
 * ------------------------------------------------------------------------- */

/** The godowns whose office counts this person is offered; null is every godown. */
async function countGodowns(fc: FactoryCtx): Promise<string[] | null> {
  if (fc.level === "admin" || (fc.head && !fc.scope)) return null;
  const rows = (await db.execute(sql`select godown_id as id from erp_godown_staff where user_id = ${fc.user.id}`)) as unknown as { id: string }[];
  return [...new Set([fc.godown.id, ...rows.map((r) => r.id)])];
}

const godownClause = (ids: string[] | null) => (ids == null ? sql`true` : sql`c.godown_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);

type Row = { id: string; no: number; kind: CountKind; item: string; godown: string; unit: CheckUnit; due: string; reason: string; parent: string | null; parentCounterId: string | null; req: string | null };

async function officeCounts(fc: FactoryCtx): Promise<CountTask[]> {
  const ids = await countGodowns(fc);
  const rows = (await db.execute(sql`
    select c.id, c.count_no as no, c.kind, m.name as item, g.name as godown, c.unit, c.due_date::text as due, c.reason,
           c.recount_of_id as parent, p.counted_by_id as "parentCounterId", c.requisition_id as req
      from erp_stock_counts c
      join erp_raw_materials m on m.id = c.raw_material_id
      join erp_godowns g on g.id = c.godown_id
      left join erp_stock_counts p on p.id = c.recount_of_id
     where c.status = 'open'
       and (c.assigned_to_id is null or c.assigned_to_id = ${fc.user.id})
       and ${godownClause(ids)}
     order by c.due_date, c.count_no`)) as unknown as Row[];
  const day = calendarDate(new Date());
  return rows.map((c) => ({
    id: c.id,
    no: countLabel(Number(c.no)),
    item: c.item,
    godown: c.godown,
    unit: c.unit,
    due: c.due,
    overdue: c.due < day,
    kind: COUNT_KIND_LABEL[c.kind] ?? c.kind,
    reason: c.reason,
    recount: !!c.parent,
    forPurchase: !!c.req,
    blocked: c.parent && c.parentCounterId === fc.user.id ? "You counted this first. A recount is done by somebody else." : null,
  }));
}

/** What the Stock check screen draws: the office's counts, and every item at this godown. */
export async function stockKit(fc: FactoryCtx): Promise<StockKit> {
  const [office, items] = await Promise.all([officeCounts(fc), checkableItems(fc.godown.id)]);
  return { ok: true, godown: fc.godown.name, office, items };
}

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const STAGES: CheckStage[] = ["rm", "sfg", "fg", "pack"];

/** A check the person chose. The book is read only now, and the answer says whether it matched. */
export async function saveStockCheck(fc: FactoryCtx, input: StockCheckInput): Promise<StockSave> {
  const qty = num(input?.qty);
  if (qty == null || qty < 0) return { ok: false, kind: "qty", title: "Enter what you counted", text: "The count is a number — zero if there is none.", fix: "Type the number, then save." };
  if (!STAGES.includes(input?.stage)) return { ok: false, kind: "item", title: "Pick the item again", text: "The phone did not say what kind of stock this is.", fix: "Go back and pick the item." };
  const r = await recordFloorCheck(fc.user.id, { stage: input.stage, itemId: clip(input.itemId, 80), godownId: fc.godown.id, qty, bin: clip(input.bin, 120), key: clip(input.key, 80) || null, source: "factory" });
  if (!r.ok) return { ok: false, kind: r.field === "qty" ? "qty" : "item", title: "Not saved", text: r.error, fix: "Go back and pick the item again." };
  const c = r.check;
  if (!c.replay) await factoryAudit(fc, "factory.stockCheck", null, `${c.item} at ${c.godown} · counted ${c.counted} ${c.unit} · ${c.matched ? "matched" : "mismatch"}`);
  return {
    ok: true,
    kind: "check",
    id: c.id,
    no: null,
    item: c.item,
    unit: c.unit,
    qty: c.counted,
    book: c.book,
    difference: c.difference,
    matched: c.matched,
    replay: c.replay,
    message: c.matched ? "Matches the book." : "Does not match the book. The office has been told.",
  };
}

/** A count the office asked for, through the ERP's own submit. */
export async function saveOfficeCount(fc: FactoryCtx, input: CountInput): Promise<StockSave> {
  const id = clip(input?.id, 80);
  const qty = num(input?.qty);
  if (!id) return { ok: false, kind: "notOpen", title: "Pick the count again", text: "The phone did not say which count this is.", fix: "Go back to the list and open the count again." };
  if (qty == null || qty < 0) return { ok: false, kind: "qty", title: "Enter what you counted", text: "The count is a number — zero if the shelf is empty.", fix: "Type the number, then save." };

  type C = { id: string; no: number; status: string; godownId: string; assignedTo: string | null; countedBy: string | null; counted: number | null; book: number | null; difference: number | null; unit: CheckUnit; item: string };
  const read = async () =>
    ((await db.execute(sql`
      select c.id, c.count_no as no, c.status, c.godown_id as "godownId", c.assigned_to_id as "assignedTo", c.counted_by_id as "countedBy",
             c.counted_qty::float8 as counted, (c.book_qty + coalesce(c.pending_in, 0) - coalesce(c.pending_out, 0))::float8 as book,
             c.difference::float8 as difference, c.unit, m.name as item
        from erp_stock_counts c join erp_raw_materials m on m.id = c.raw_material_id
       where c.id = ${id}`)) as unknown as C[])[0];
  const c = await read();
  if (!c) return { ok: false, kind: "notOpen", title: "This count is gone", text: "The office cancelled or removed it.", fix: "Go back to the list." };
  const no = countLabel(Number(c.no));
  const out = (x: C, message: string, replay = false): StockSave => ({
    ok: true, kind: "count", id, no, item: x.item, unit: x.unit, qty: x.counted ?? qty, book: x.book, difference: x.difference,
    matched: x.status === "matched" || x.status === "resolved", message, replay,
  });

  /* A resend of a count this person already saved — the answer was lost on the way back. */
  if (c.status !== "open" && c.countedBy === fc.user.id && c.counted === qty) return out(c, `${no} was already saved with your count.`, true);
  if (c.status !== "open") return { ok: false, kind: "notOpen", title: "Already counted", text: `${no} is no longer open — somebody counted or cancelled it.`, fix: "Go back to the list for the counts still open." };

  const ids = await countGodowns(fc);
  if ((ids && !ids.includes(c.godownId)) || (c.assignedTo && c.assignedTo !== fc.user.id))
    return { ok: false, kind: "notAllowed", title: "Not your godown", text: "This count is for somebody at another godown.", fix: "Ask the Production Head." };

  const r = await submitCount(erpCtxFor(fc), id, { qty: String(qty), bin: clip(input.bin, 120), lot: clip(input.lot, 200), note: "" });
  if (!r.ok) {
    const notAllowed = r.code === "not_permitted";
    return { ok: false, kind: notAllowed ? "notAllowed" : r.code === "conflict" ? "notOpen" : "qty", title: notAllowed ? "Not yours to count" : "Not saved", text: r.error, fix: notAllowed ? "Leave it for somebody else to count." : "Go back to the list and try again." };
  }
  await factoryAudit(fc, "factory.stockCount", null, `${no} · ${c.item} · counted ${qty} ${c.unit}`);
  const after = (await read()) ?? c;
  return out(after, r.message ?? "Saved.");
}

/** Why the counter thinks it differs — optional, theirs, until the office has looked. */
export async function saveCheckReason(fc: FactoryCtx, kind: "check" | "count", id: string, reason: string): Promise<{ ok: boolean }> {
  const text = clip(reason, 1000);
  if (!text) return { ok: false };
  if (kind === "check") return { ok: await setFloorCheckReason(fc.user.id, clip(id, 80), text) };
  const r = (await db.execute(sql`
    update erp_stock_counts set count_note = ${text}
     where id = ${clip(id, 80)} and counted_by_id = ${fc.user.id} and status <> 'matched' and resolved_at is null
     returning id`)) as unknown as { id: string }[];
  return { ok: r.length > 0 };
}
