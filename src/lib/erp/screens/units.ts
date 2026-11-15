import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { calendarDate } from "@/lib/business-date";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { erpAudit, stampLine, text, type ScreenModule } from "../server";
import { nf, type ActionSpec, type BulkSpec, type ColSpec, type ListRow, type ToolResult } from "../ui";
import { erpLink } from "../registry";
import { manualMove, packLabel, UNIT_STATUS_LABEL, type UnitStatus } from "../engines/trace";
import { unitEvent } from "../units";
import { erpDispatchHref, erpLabelsHref, erpTraceHref } from "../trace-links";
import { inTx, refuse } from "./common";
import { confirmImpact } from "@/lib/impact/registry";
import { impactBatchKey } from "@/lib/impact/batch-key";
import { readConfirmation } from "@/lib/impact/types";

/* ---------------------------------------------------------------------------
 * BOXES & LABELS — the unit register. Every box a packing batch made and
 * every loose can or drum somebody labelled, by id, with where it is and
 * where it stands. Labels are printed from here (one, a selection or a whole
 * batch), and the few moves a person makes by hand — hold, release, reject —
 * are made here, each one an event on the box's history. A box a customer
 * sends back goes through Material returns → Customer returns.
 * ------------------------------------------------------------------------- */

type UnitRow = {
  id: string;
  kind: string;
  status: UnitStatus;
  note: string | null;
  sku: string;
  litres: number | null;
  lotFrom: string;
  lotCode: string;
  seq: number;
  cans: number;
  godown: string;
  orderNo: number | null;
  customer: string | null;
  scannedAt: Date | null;
  dispatchedAt: Date | null;
  printedAt: Date | null;
  prints: number;
  createdAt: Date;
  by: string | null;
};

/** The register reads at most this many units, newest first, and says so when there are more. */
const UNIT_CAP = 5000;

async function unitTotal(scope: "stock" | "all"): Promise<number> {
  const [r] = (await db.execute(sql`
    select count(*)::int as n from erp_units u
     where ${scope === "stock" ? sql`u.status in ('available', 'hold', 'scanned', 'returned')` : sql`true`}
  `)) as unknown as { n: number }[];
  return Number(r?.n ?? 0);
}

async function unitRows(scope: "stock" | "all"): Promise<UnitRow[]> {
  return (await db.execute(sql`
    select u.id, u.kind, u.status, u.status_note as note, p.name as sku, coalesce(p.millilitres_per_can, fg.millilitres)::float8 / 1000 as litres,
           u.lot_from as "lotFrom", u.lot_code as "lotCode", u.seq, u.cans, g.name as godown, o.order_no as "orderNo",
           coalesce(dc.name, bc.name) as customer, u.scanned_at as "scannedAt", u.dispatched_at as "dispatchedAt",
           u.label_printed_at as "printedAt", u.label_prints as prints, u.created_at as "createdAt", us.name as by
      from erp_units u
      join products p on p.id = u.sku_id
      left join finished_goods fg on fg.id = p.finished_good_id
      join erp_godowns g on g.id = u.godown_id
      left join erp_orders o on o.id = u.order_id
      left join customers bc on bc.id = o.billing_customer_id
      left join customers dc on dc.id = o.delivery_customer_id
      left join users us on us.id = u.created_by_id
     where ${scope === "stock" ? sql`u.status in ('available', 'hold', 'scanned', 'returned')` : sql`true`}
     order by u.created_at desc, u.id desc
     limit ${UNIT_CAP + 1}
  `)) as unknown as UnitRow[];
}

function unitScreen(key: "units" | "allUnits"): ScreenModule {
  return {
    key,
    async load(ctx) {
      const scope = key === "units" ? "stock" : "all";
      const read = await unitRows(scope);
      /* Past the cap the list is the newest UNIT_CAP, and the line under the
         toolbar says how many there are, so the cards are read as a slice. */
      const capped = read.length > UNIT_CAP;
      const rows = capped ? read.slice(0, UNIT_CAP) : read;
      const total = capped ? await unitTotal(scope) : rows.length;
      const power = ctx.powers.has("dispatchOverride");
      const cols: ColSpec[] = [
        { k: "id", l: "Unit id", t: "mono" },
        { k: "status", l: "Status", t: "s" },
        { k: "sku", l: "Description of goods", t: "b", w: 240 },
        { k: "pack", l: "Pack", t: "t" },
        { k: "cans", l: "Cans", t: "n" },
        { k: "lot", l: "Batch / lot", t: "mono" },
        { k: "seq", l: "No.", t: "n" },
        { k: "godown", l: "Godown", t: "t" },
        { k: "order", l: "Order", t: "mono" },
        { k: "customer", l: "Customer", t: "t" },
        { k: "printed", l: "Label printed", t: "d" },
        { k: "f", l: "Flags", t: "f" },
      ];
      const bulk: BulkSpec[] = [
        { id: "print", l: "Print labels" },
        { id: "hold", l: "Put on hold", prompt: { title: "Put the selected boxes on hold", submit: "Hold", fields: [{ k: "note", l: "Why", t: "area", req: true }] } },
        /* Which of the selection goes back, and any it takes off an order or out of a return's quarantine. */
        { id: "release", l: "Release hold", impact: { kind: "erp-unit-release" } },
      ];
      return {
        spec: {
          screen: key,
          cols,
          hidden: [],
          groups: ["lot", "godown", "status"],
          agg: { k: "cans", l: "cans" },
          filters: ["status", "sku", "pack", "customer"],
          stats: [
            { l: "Units" },
            { l: "Lots", kind: "distinct", k: "lot" },
            { l: "Cans", kind: "sum", k: "cans", u: "cans" },
            key === "units"
              ? { l: "Scanned for dispatch", where: { k: "status", in: ["Scanned for dispatch"] }, tone: "info" }
              : { l: "Dispatched", where: { k: "status", in: ["Dispatched"] }, tone: "success" },
            { l: "On hold", where: { flag: "unitHold" }, tone: "warn" },
            { l: "No label printed", where: { flag: "unlabelled" }, tone: "danger" },
          ],
          godownKey: "godown",
          ...(capped ? { scopedLine: `Showing the newest ${nf(UNIT_CAP)} of ${nf(total)} units; the figures above count these only. Trace finds an older one by its id.` } : {}),
          bulk,
          sortDefault: ["id", -1],
          noDataLine:
            key === "units"
              ? "No boxes in stock carry an id yet. A packing batch mints one per box when it completes; loose cans get theirs from FG stock → Label loose units."
              : "No boxes yet.",
        },
        rows: rows.map((r): ListRow => {
          const status = r.status;
          const can = (to: "hold" | "available" | "rejected") => manualMove(status, to);
          const needPower = (to: "rejected") => can(to) ?? (power ? "" : "Only a dispatch-override approver rejects a box.");
          const actions: ActionSpec[] = [
            { id: "print", l: r.printedAt ? "Reprint label" : "Print label", primary: !r.printedAt && status === "available", href: erpLabelsHref({ ids: [r.id] }) },
            { id: "trace", l: "Trace this box", href: erpTraceHref(r.id) },
            ...(status === "scanned" && r.orderNo ? [{ id: "desk", l: `Open order ${r.orderNo} at the dispatch desk`, href: erpDispatchHref(r.orderNo) } as ActionSpec] : []),
            { id: "hold", l: "Put on hold", why: can("hold") ?? "", prompt: { title: `Hold ${r.id}`, sub: "A box on hold cannot be scanned for dispatch until it is released.", submit: "Hold", fields: [{ k: "note", l: "Why", t: "area", req: true }] } },
            ...(status === "returned" ? [{ id: "returns", l: "Open customer returns", href: erpLink("customerReturns") } as ActionSpec] : []),
            { id: "release", l: "Release hold", why: can("available") ?? "", impact: { kind: "erp-unit-release", id: r.id } },
            { id: "reject", l: "Reject", why: needPower("rejected"), prompt: { title: `Reject ${r.id}`, sub: "A rejected box never leaves. The reason stays on its history.", submit: "Reject", fields: [{ k: "note", l: "Why", t: "area", req: true }] } },
          ];
          const flags: string[] = [];
          if (status === "hold") flags.push("unitHold");
          if (!r.printedAt && (status === "available" || status === "hold")) flags.push("unlabelled");
          return {
            id: r.id,
            v: {
              id: r.id,
              status: UNIT_STATUS_LABEL[status] ?? status,
              sku: r.sku,
              pack: packLabel(r.litres == null ? null : Number(r.litres)),
              cans: Number(r.cans),
              lot: r.lotCode,
              seq: Number(r.seq),
              godown: r.godown,
              order: r.orderNo == null ? null : String(r.orderNo),
              customer: r.customer,
              printed: r.printedAt ? calendarDate(new Date(r.printedAt)) : null,
            },
            flags,
            title: r.id,
            header: `${r.sku} · ${r.kind === "box" ? `box ${r.seq} of batch ${r.lotCode}` : `loose unit ${r.seq} of FG lot ${r.lotCode}`} · ${UNIT_STATUS_LABEL[status]}`,
            fields: [
              { l: "Where", v: r.godown },
              ...(r.orderNo ? [{ l: status === "dispatched" ? "Dispatched on" : "Scanned onto", v: `Order ${r.orderNo}${r.customer ? ` · ${r.customer}` : ""}` }] : []),
              ...(r.dispatchedAt ? [{ l: "Dispatched", v: stampLine(null, r.dispatchedAt).replace(/^Created /, "") }] : []),
              { l: "Label", v: r.printedAt ? `Printed ${r.prints} time${r.prints === 1 ? "" : "s"}, last ${stampLine(null, r.printedAt).replace(/^Created /, "")}` : "Not printed yet" },
              ...(r.note ? [{ l: "Note", v: r.note }] : []),
            ],
            actions,
            by: stampLine(r.by, r.createdAt),
          };
        }),
      };
    },
    actions: {
      hold: (ctx, id, v) => move(ctx, [id], "hold", text(v.note)),
      async release(ctx, id, v) {
        const refusal = await confirmImpact("erp-unit-release", id, readConfirmation(v));
        return refusal ?? move(ctx, [id], "available", null);
      },
      reject: (ctx, id, v) => move(ctx, [id], "rejected", text(v.note)),
    },
    bulk: {
      async print(_ctx, ids) {
        return ok<ToolResult>({ navigate: erpLabelsHref({ ids }) }, `Opening ${ids.length} label${ids.length === 1 ? "" : "s"}`);
      },
      hold: (ctx, ids, v) => move(ctx, ids, "hold", text(v.note)),
      async release(ctx, ids, v) {
        const refusal = await confirmImpact("erp-unit-release", impactBatchKey(ids), readConfirmation(v));
        return refusal ?? move(ctx, ids, "available", null);
      },
    },
  };
}

const EVENT: Record<"hold" | "available" | "rejected", string> = { hold: "hold", available: "release", rejected: "reject" };

async function move(ctx: ErpContext, ids: string[], to: "hold" | "available" | "rejected", note: string | null): Promise<Result<unknown>> {
  if ((to === "hold" || to === "rejected") && !note) return fieldErr("note", "Say why.");
  if (to === "rejected" && !ctx.powers.has("dispatchOverride")) return err("Only a dispatch-override approver rejects a box.", "not_permitted");
  let moved = 0;
  let refused = "";
  const res = await inTx(async (tx) => {
    const rows = (await tx.execute(sql`select id, status, order_id as "order", godown_id as godown from erp_units where id in ${ids} for update`)) as unknown as { id: string; status: UnitStatus; order: string | null; godown: string }[];
    if (!rows.length) return refuse(err("No such box.", "not_found"));
    for (const r of rows) {
      const why = manualMove(r.status, to);
      if (why) {
        refused = refused || `${r.id}: ${why}`;
        continue;
      }
      /* A box released from hold leaves any order it was scanned onto. */
      const clearOrder = to === "available";
      await tx.execute(sql`update erp_units set status = ${to}, status_note = ${note}, ${clearOrder ? sql`order_id = null, scanned_at = null, scanned_by_id = null,` : sql``} updated_at = now() where id = ${r.id}`);
      await unitEvent(tx, { unitId: r.id, event: EVENT[to], from: r.status, to, orderId: r.order, godownId: r.godown, note, byId: ctx.user.id });
      moved++;
    }
    if (!moved) return refuse(err(refused || "Nothing to change.", "rule_violation"));
    return okVoid("");
  });
  if (!res.ok) return res;
  await erpAudit(ctx, `erp.unit.${EVENT[to]}`, "erp_unit", ids.join(","), null, { to, note });
  const word = { hold: "on hold", available: "back in stock", rejected: "rejected" }[to];
  return okVoid(`${moved} box${moved === 1 ? "" : "es"} ${word}${refused && moved < ids.length ? ` · ${ids.length - moved} could not be (${refused})` : ""}`);
}

export const UNIT_SCREENS: ScreenModule[] = [unitScreen("units"), unitScreen("allUnits")];
