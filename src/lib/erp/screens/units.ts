import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { calendarDate } from "@/lib/business-date";
import { err, fieldErr, ok, okVoid, type Result } from "@/lib/result";
import type { ErpContext } from "../access";
import { erpAudit, stampLine, text, type ScreenModule } from "../server";
import type { ActionSpec, BulkSpec, ColSpec, ListRow, ToolResult } from "../ui";
import { manualMove, packLabel, UNIT_STATUS_LABEL, type UnitStatus } from "../engines/trace";
import { unitEvent } from "../units";
import { erpLabelsHref, erpTraceHref } from "../trace-links";
import { inTx, refuse } from "./common";

/* ---------------------------------------------------------------------------
 * BOXES & LABELS — the unit register. Every box a packing batch made and
 * every loose can or drum somebody labelled, by id, with where it is and
 * where it stands. Labels are printed from here (one, a selection or a whole
 * batch), and the few moves a person makes by hand — hold, release, reject,
 * return — are made here, each one an event on the box's history.
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
     limit 5000
  `)) as unknown as UnitRow[];
}

function unitScreen(key: "units" | "allUnits"): ScreenModule {
  return {
    key,
    async load(ctx) {
      const rows = await unitRows(key === "units" ? "stock" : "all");
      const power = ctx.powers.has("dispatchOverride");
      const cols: ColSpec[] = [
        { k: "id", l: "Box id", t: "mono" },
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
        { id: "release", l: "Release hold" },
      ];
      return {
        spec: {
          screen: key,
          cols,
          hidden: [],
          groups: ["lot", "godown", "status"],
          agg: { k: "cans", l: "cans" },
          godownKey: "godown",
          bulk,
          download: true,
          sortDefault: ["id", -1],
          noDataLine:
            key === "units"
              ? "No boxes in stock carry an id yet. A packing batch mints one per box when it completes; loose cans get theirs from FG stock → Label loose units."
              : "No boxes yet.",
        },
        rows: rows.map((r): ListRow => {
          const status = r.status;
          const can = (to: "hold" | "available" | "rejected" | "returned") => manualMove(status, to);
          const needPower = (to: "rejected" | "returned") => can(to) ?? (power ? "" : "Only a dispatch-override approver rejects or returns a box");
          const actions: ActionSpec[] = [
            { id: "print", l: r.printedAt ? "Reprint label" : "Print label", primary: !r.printedAt && status === "available", href: erpLabelsHref({ ids: [r.id] }) },
            { id: "trace", l: "Trace this box", href: erpTraceHref(r.id) },
            ...(status === "scanned" && r.orderNo ? [{ id: "desk", l: `Open order ${r.orderNo} at the dispatch desk`, href: `/erp/dispatch?order=${r.orderNo}` } as ActionSpec] : []),
            { id: "hold", l: "Put on hold", why: can("hold") ?? "", prompt: { title: `Hold ${r.id}`, sub: "A box on hold cannot be scanned for dispatch until it is released.", submit: "Hold", fields: [{ k: "note", l: "Why", t: "area", req: true }] } },
            { id: "release", l: status === "returned" ? "Back into stock" : "Release hold", why: can("available") ?? "", confirm: `Put ${r.id} back into stock?` },
            { id: "reject", l: "Reject", why: needPower("rejected"), prompt: { title: `Reject ${r.id}`, sub: "A rejected box never leaves. The reason stays on its history.", submit: "Reject", fields: [{ k: "note", l: "Why", t: "area", req: true }] } },
            { id: "return", l: "Mark returned by customer", why: needPower("returned"), prompt: { title: `${r.id} came back`, sub: "It returns to the godown it left from, as Returned, until somebody puts it back into stock or rejects it.", submit: "Mark returned", fields: [{ k: "note", l: "What came back and why", t: "area", req: true }] } },
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
      release: (ctx, id) => move(ctx, [id], "available", null),
      reject: (ctx, id, v) => move(ctx, [id], "rejected", text(v.note)),
      return: (ctx, id, v) => move(ctx, [id], "returned", text(v.note)),
    },
    bulk: {
      async print(_ctx, ids) {
        return ok<ToolResult>({ navigate: erpLabelsHref({ ids }) }, `Opening ${ids.length} label${ids.length === 1 ? "" : "s"}`);
      },
      hold: (ctx, ids, v) => move(ctx, ids, "hold", text(v.note)),
      release: (ctx, ids) => move(ctx, ids, "available", null),
    },
  };
}

const EVENT: Record<"hold" | "available" | "rejected" | "returned", string> = { hold: "hold", available: "release", rejected: "reject", returned: "return" };

async function move(ctx: ErpContext, ids: string[], to: "hold" | "available" | "rejected" | "returned", note: string | null): Promise<Result<unknown>> {
  if ((to === "hold" || to === "rejected" || to === "returned") && !note) return fieldErr("note", "Say why");
  if ((to === "rejected" || to === "returned") && !ctx.powers.has("dispatchOverride")) return err("Only a dispatch-override approver rejects or returns a box.", "not_permitted");
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
      /* A returned box keeps the order it came back from on its history, and
         leaves the order once it is back in stock. */
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
  const word = { hold: "on hold", available: "back in stock", rejected: "rejected", returned: "marked returned" }[to];
  return okVoid(`${moved} box${moved === 1 ? "" : "es"} ${word}${refused && moved < ids.length ? ` · ${ids.length - moved} could not be (${refused})` : ""}`);
}

export const UNIT_SCREENS: ScreenModule[] = [unitScreen("units"), unitScreen("allUnits")];
