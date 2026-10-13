import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import type { ErpContext } from "@/lib/erp/access";
import { SEAT_LABEL, type ErpDepartmentSeat, categoriesForDepartment, departmentByLabel } from "@/lib/erp/departments";
import { FLOW_STEPS, purchaseUnit, requirementLabel, type PurchaseMethod } from "@/lib/erp/engines/purchase-flow";
import { dutyKit } from "@/lib/erp/material-duties-server";
import { cancelRequirementItem, raiseRequirementWith, requirementViews, stageOf, type ReqView } from "@/lib/erp/screens/purchase-flow";
import { materials } from "@/lib/erp/screens/common";
import { stockUnit } from "@/lib/erp/stock";
import { calendarDate } from "@/lib/business-date";
import { erpCtxFor, factoryAudit, textArray, today, type FactoryCtx } from "./server";
import type { ReqCard, ReqDept, ReqInput, ReqItem, ReqKit, ReqLine, ReqSave } from "./types";

/* ---------------------------------------------------------------------------
 * PURCHASE REQUIREMENTS FROM THE FLOOR. The in-charge of Mixing, Refilling or
 * Packing (and a supervisor over one, and the Production Head) asks the office
 * to buy what the department needs — the ERP's own requirement, raised through
 * `raiseRequirementWith`, so every rule the ERP keeps still holds: which
 * categories a department may ask for, who may request each material, the
 * purchase rule copied on raise, and the stock check before buying.
 *
 * EVERY ITEM IS COUNTED BEFORE IT IS ASKED FOR, BLIND. The phone is never sent
 * a stock figure — not in the item list, not after the save. What the
 * in-charge counted becomes that item's stock check (`writeCounted`, the same
 * judgement Stock accuracy uses), and the answer is only "matches" or "does
 * not": a recount that knew the book would not be a count. A count that does
 * not match holds nothing — stock control is told and the purchase carries
 * on, the ERP's rule since the count stopped being a gate.
 *
 * It needs the network on purpose, like Stock check: a requirement queued for
 * hours is a count judged against a book that has moved.
 * ------------------------------------------------------------------------- */

/** The floor's department → the ERP's department seat and the label a requirement carries. */
const SEAT: Record<ReqDept, Exclude<ErpDepartmentSeat, "head">> = { mixing: "mixing", filling: "refilling", packing: "packing" };
export const REQ_DEPT_LABEL: Record<ReqDept, string> = { mixing: SEAT_LABEL.mixing, filling: SEAT_LABEL.refilling, packing: SEAT_LABEL.packing };
const deptOfLabel = (label: string | null): ReqDept | null => {
  const d = departmentByLabel(label);
  return d ? ((Object.keys(SEAT) as ReqDept[]).find((k) => SEAT[k] === d.key) ?? null) : null;
};

/** The ERP context a requirement is raised under: the person, the godown they stand in, and the department they raise for. */
function erpCtxForReq(fc: FactoryCtx, dept: ReqDept): ErpContext {
  const base = erpCtxFor(fc);
  return { ...base, screens: new Set([...base.screens, "requisitions"]), department: SEAT[dept] };
}

const countUnitOf = (rmUnit: string): "L" | "pcs" => (stockUnit(rmUnit) === "Pcs" ? "pcs" : "L");

function howBought(rule: string, vendor: string | null): string {
  if (rule === "quotation") return "Quotations needed first";
  if (rule === "buyer") return "The buyer decides how";
  return vendor ? `Direct from ${vendor}` : "Direct purchase";
}

/** A requirement still being worked: not cancelled, not received, not closed. */
const isOpen = (stage: string) => !["Cancelled", "Received", "Closed", "Closed short"].includes(stage);

export async function requirementKit(fc: FactoryCtx): Promise<ReqKit> {
  if (!fc.reqDepts.length)
    return { ok: false, title: "Not for your role", text: "Purchase requirements are raised by whoever is in charge of Mixing, Refilling or Packing.", fix: "Ask the Production Head if you should be." };
  const [mats, views, config, suppliers, recentRows] = await Promise.all([
    materials(),
    requirementViews(),
    getConfig(),
    db.execute(sql`select id, name from erp_suppliers`) as unknown as Promise<{ id: string; name: string }[]>,
    db.execute(sql`
      select distinct raw_material_id as id, department from erp_requisitions
       where raw_material_id is not null and created_at > now() - interval '90 days'`) as unknown as Promise<{ id: string; department: string | null }[]>,
  ]);
  const supplier = new Map(suppliers.map((s) => [s.id, s.name]));
  const minQ = config["erp.purchase.minQuotations"];
  const mine = views.filter((v) => !v.legacy && !!v.r.rawMaterialId && fc.reqDepts.includes(deptOfLabel(v.r.department) as ReqDept));

  /* An open requirement for the item at this godown, so nobody asks twice without knowing. */
  const openFor = new Map<string, string>();
  for (const v of mine) if (v.r.godownId === fc.godown.id && v.r.reqNo && isOpen(stageOf(v, minQ).stage)) openFor.set(`${deptOfLabel(v.r.department)}|${v.r.rawMaterialId}`, requirementLabel(v.r.reqNo));

  const depts = await Promise.all(
    fc.reqDepts.map(async (key) => {
      const label = REQ_DEPT_LABEL[key];
      const duties = await dutyKit(erpCtxForReq(fc, key));
      const cats = categoriesForDepartment(label);
      const recent = new Set(recentRows.filter((r) => r.department === label).map((r) => r.id));
      const items: ReqItem[] = mats
        .filter((m) => cats.includes(m.materialType) && duties.allows(m.id, "request"))
        .map((m) => ({
          id: m.id,
          name: m.name,
          cat: m.materialType,
          countUnit: countUnitOf(m.unit),
          buyUnit: purchaseUnit(m.unit, m.materialType),
          how: howBought(m.purchaseMethod, m.preferredSupplierId ? (supplier.get(m.preferredSupplierId) ?? null) : null),
          recent: recent.has(m.id),
          openReq: openFor.get(`${key}|${m.id}`) ?? null,
        }));
      return { key, label, items };
    }),
  );
  return { ok: true, godown: fc.godown.name, today: today(), steps: [...FLOW_STEPS], depts, reqs: await cards(fc, mine, minQ) };
}

/** The department's requirements, newest first: every open one, and the last 60 days of the rest. */
async function cards(fc: FactoryCtx, views: ReqView[], minQ: number): Promise<ReqCard[]> {
  const ids = views.map((v) => v.r.id);
  /* The requester's own count of each item, and where its stock check stands. Never the book. */
  const counts = ids.length
    ? ((await db.execute(sql`
        select distinct on (c.requisition_id) c.requisition_id as req, c.counted_qty::float8 as qty, c.counted_by_id as by, c.status
          from erp_stock_counts c
         where c.requisition_id = any(${textArray(ids)}) and c.recount_of_id is null and c.status <> 'cancelled'
         order by c.requisition_id, c.created_at desc`)) as unknown as { req: string; qty: number | null; by: string | null; status: string }[])
    : [];
  const countOf = new Map(counts.map((c) => [c.req, c]));
  const cutoff = calendarDate(new Date(Date.now() - 60 * 86400_000));
  const byNo = new Map<number, ReqView[]>();
  for (const v of views) (byNo.get(v.r.reqNo ?? 0) ?? byNo.set(v.r.reqNo ?? 0, []).get(v.r.reqNo ?? 0)!).push(v);
  const out: ReqCard[] = [];
  for (const [no, vs] of byNo) {
    if (!no) continue;
    const lines: ReqLine[] = vs.map((v) => {
      const st = stageOf(v, minQ);
      const c = countOf.get(v.r.id);
      const own = c && c.by === fc.user.id && c.qty != null;
      const countState: ReqLine["countState"] = !c ? null : c.status === "open" ? "waiting" : ["matched", "resolved"].includes(c.status) ? "matched" : "flagged";
      const cancellable = st.step >= 0 && st.step < FLOW_STEPS.length && !v.po;
      return {
        id: v.r.id,
        item: v.item,
        qty: Number(v.r.requiredQty),
        unit: v.r.unit,
        stage: st.stage,
        step: st.step,
        next: st.next,
        counted: own ? Number(c!.qty) : null,
        countUnit: countUnitOf(v.itemUnit),
        countState,
        cancel: st.step < 0 || st.step >= FLOW_STEPS.length ? null : cancellable ? { ok: true } : { ok: false, why: "It is on a PO already. Ask the office to change it." },
      };
    });
    const r = vs[0].r;
    const state: ReqCard["state"] = lines.some((l) => l.step >= 0 && l.step < FLOW_STEPS.length) ? "open" : lines.every((l) => l.step < 0) ? "cancelled" : "received";
    if (state !== "open" && r.reqDate < cutoff) continue;
    out.push({
      no: requirementLabel(no),
      dept: deptOfLabel(r.department) ?? "mixing",
      priority: (["Urgent", "Medium", "For Stock"].includes(r.priority) ? r.priority : "Medium") as ReqCard["priority"],
      date: r.reqDate,
      requiredBy: r.requiredBy,
      godown: vs[0].godown,
      by: vs[0].by,
      remarks: r.remarks,
      state,
      lines,
    });
  }
  return out.sort((a, b) => (a.date === b.date ? b.no.localeCompare(a.no, undefined, { numeric: true }) : b.date.localeCompare(a.date)));
}

const fail = (title: string, text: string, fix: string, line?: number): ReqSave => ({ ok: false, title, text, fix, ...(line != null ? { line } : {}) });
const PRIORITIES = ["Urgent", "Medium", "For Stock"] as const;
const finite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Raises one requirement with every item's count. Safe to send twice: the key answers a resend from the first save. */
export async function raiseFromFloor(fc: FactoryCtx, input: ReqInput): Promise<ReqSave> {
  const key = typeof input?.key === "string" ? input.key.trim().slice(0, 80) : "";
  if (!key) return fail("Start again", "The phone did not say which requirement this is.", "Close it and raise it again.");
  const dept = input?.dept;
  if (!fc.reqDepts.includes(dept)) return fail("Not your department", "You raise requirements only for the departments you are in charge of.", "Pick your department and try again.");
  const lines = Array.isArray(input?.lines) ? input.lines : [];
  if (!lines.length) return fail("Add an item", "A requirement needs at least one item.", "Add what you need, then send.");
  if (lines.length > 100) return fail("Too many items", "Send at most 100 items at a time.", "Split it into two requirements.");
  for (const [i, l] of lines.entries()) {
    const counted = finite(l?.counted), need = finite(l?.need);
    if (counted == null || counted < 0) return fail("Count it first", "Every item needs what you counted in the godown — 0 if there is none.", "Open the item and enter your count.", i);
    if (need == null || need <= 0) return fail("How much to buy?", "Every item needs a quantity above 0.", "Open the item and enter how much you need.", i);
  }
  const requiredBy = typeof input?.requiredBy === "string" ? input.requiredBy : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requiredBy) || requiredBy < today()) return fail("When is it needed?", "Pick a day from today onwards.", "Choose Needed by again.");
  const priority = PRIORITIES.includes(input?.priority) ? input.priority : null;
  if (!priority) return fail("How urgent?", "Pick Urgent, Medium or For stock.", "Choose how urgent it is.");

  /* Claim the key: the first send writes it, a resend reads the answer the first one stored. */
  const claimed = (await db.execute(sql`
    insert into factory_requirement_sends (key, user_id) values (${key}, ${fc.user.id})
    on conflict (key) do nothing returning key`)) as unknown as { key: string }[];
  if (!claimed.length) {
    const [prev] = (await db.execute(sql`select status, result, user_id from factory_requirement_sends where key = ${key}`)) as unknown as { status: string; result: ReqSave | null; user_id: string }[];
    if (prev?.user_id !== fc.user.id) return fail("Start again", "This requirement could not be matched to you.", "Close it and raise it again.");
    if (prev.status === "done" && prev.result?.ok) return { ...prev.result, replay: true };
    return fail("Still sending", "The first send of this requirement is still being saved.", "Wait a moment, then press Send again.");
  }

  const ctx = erpCtxForReq(fc, dept);
  const counts = new Map(lines.map((l) => [String(l.itemId), Number(l.counted)]));
  let res;
  try {
    res = await raiseRequirementWith(
      ctx,
      { date: today(), requiredBy, department: REQ_DEPT_LABEL[dept], godown: fc.godown.name, priority, remarks: typeof input.remarks === "string" ? input.remarks.trim().slice(0, 1000) : "" },
      lines.map((l) => ({ rawMaterialId: String(l.itemId), required: String(l.need) })),
      counts,
    );
  } catch (e) {
    await db.execute(sql`delete from factory_requirement_sends where key = ${key}`);
    throw e;
  }
  if (!res.ok) {
    await db.execute(sql`delete from factory_requirement_sends where key = ${key}`);
    const at = res.fieldErrors?.[0]?.field.match(/^l(\d+)\./);
    return fail("Not sent", res.fieldErrors?.[0]?.message ?? res.error ?? "The requirement was not raised.", "Change it, then send again.", at ? Number(at[1]) : undefined);
  }
  const { reqNo, items } = res.data;
  const mats = await materials();
  const unitOf = new Map(mats.map((m) => [m.id, countUnitOf(m.unit)]));
  const supplierName = new Map(((await db.execute(sql`select id, name from erp_suppliers`)) as unknown as { id: string; name: string }[]).map((x) => [x.id, x.name]));
  const vendorOf = new Map(mats.map((m) => [m.id, m.preferredSupplierId ? (supplierName.get(m.preferredSupplierId) ?? null) : null]));
  const out: ReqSave = {
    ok: true,
    no: requirementLabel(reqNo),
    lines: items.map((x) => ({ item: x.item, qty: x.qty, unit: x.unit, counted: counts.get(x.rawMaterialId) ?? 0, countUnit: unitOf.get(x.rawMaterialId) ?? "L", verdict: x.count?.verdict ?? "skipped" })),
    next: nextWords(items.map((x) => ({ item: x.item, rule: x.rule, vendor: x.rule === "direct" ? (vendorOf.get(x.rawMaterialId) ?? null) : null }))),
  };
  await db.execute(sql`update factory_requirement_sends set status = 'done', result = ${JSON.stringify(out)}::jsonb where key = ${key}`);
  await factoryAudit(fc, "factory.requirement.raise", null, `${requirementLabel(reqNo)} · ${items.length} item${items.length > 1 ? "s" : ""}`, {
    dept,
    items: items.map((x) => ({ item: x.item, qty: x.qty, counted: counts.get(x.rawMaterialId), verdict: x.count?.verdict })),
  });
  return out;
}

/** What happens to each item next, in the floor's words. */
function nextWords(items: { item: string; rule: PurchaseMethod; vendor: string | null }[]): string[] {
  const out: string[] = [];
  for (const x of items) {
    const how = x.rule === "quotation" ? "the office collects quotations" : x.rule === "buyer" ? "the buyer decides how to buy it" : `a PO goes to ${x.vendor ?? "the vendor"}`;
    out.push(`${x.item}: ${how}.`);
  }
  out.push("You see each item move here as the office works on it.");
  return out;
}

/** Cancels one item of a requirement the in-charge's department raised, before it is on a PO. */
export async function cancelFromFloor(fc: FactoryCtx, id: string, reason: string): Promise<{ ok: true; msg: string } | { ok: false; error: string }> {
  const why = String(reason ?? "").trim().slice(0, 500);
  if (!why) return { ok: false, error: "Say why it is cancelled." };
  const [v] = await requirementViews({ ids: [String(id)] });
  const dept = v ? deptOfLabel(v.r.department) : null;
  if (!v || !dept || !fc.reqDepts.includes(dept)) return { ok: false, error: "That requirement is not your department's." };
  const res = await cancelRequirementItem(erpCtxForReq(fc, dept), v.r.id, why);
  if (!res.ok) return { ok: false, error: res.error ?? "It could not be cancelled." };
  await factoryAudit(fc, "factory.requirement.cancel", null, `${v.r.reqNo ? requirementLabel(v.r.reqNo) : v.r.id} · ${v.item}`, { reason: why });
  return { ok: true, msg: `${v.item} cancelled` };
}
