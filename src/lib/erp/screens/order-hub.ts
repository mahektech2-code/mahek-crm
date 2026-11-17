import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpOrderHolds, erpOrderIntakes, erpOrders } from "@/db/schema";
import { err, fieldErr, okVoid, type Err, type Result } from "@/lib/result";
import { money, stamp } from "@/lib/format";
import { calendarDate } from "@/lib/business-date";
import type { ErpContext } from "../access";
import { erpLink } from "../registry";
import { erpAudit, text, type ScreenModule } from "../server";
import type { ActionSpec, ColSpec, FieldSpec, ListRow, RowField } from "../ui";
import { newFormIn } from "../lazy-forms";
import { cancelIntake, checkIntake, holdIntake, intakeById, releaseIntake, sendBackIntake } from "../order-hub";
import {
  ACCOUNTS_HOLD_REASONS,
  CHECK_LABEL,
  DEPARTMENT_LABEL,
  HOLD_CUSTOMER_TEXT,
  INTAKE_HOLD_REASONS,
  INTAKE_STATUS_LABEL,
  ORIGIN_SOURCE,
  PRODUCTION_HOLD_REASONS,
  RELEASE_TO,
  duplicateOf,
  intakeEditable,
  nextCheck,
  type Checker,
  type HoldDepartment,
  type IntakeStatus,
} from "../engines/order-hub";
import { mrpCheck, type MrpLine, type MrpStock } from "../engines/mrp";
import { closeHold, openHolds, recordHold, tellHold } from "../order-tracking";
import { reasonLabel } from "../engines/order-tracking";
import { fgLots, packLots, rmLots, sfgLots } from "../stock";
import { placeNameSql } from "@/lib/services/place-filter-service";
import { intakeForm, orderForm, saveOrder } from "./sales";

/* ---------------------------------------------------------------------------
 * THE ORDER HUB'S SCREENS: the TOs waiting for their two checks (Order Hub),
 * the approved orders waiting for the Production Head's clearance (MRP check),
 * and every hold from every desk in one list (To Hold). The rules are in
 * `engines/order-hub.ts` and `engines/mrp.ts`; the writes in `order-hub.ts`.
 * ------------------------------------------------------------------------- */

const checker = (ctx: ErpContext): Checker => ({ userId: ctx.user.id, backOffice: ctx.powers.has("verifyOrders"), production: ctx.powers.has("productionCheck"), admin: ctx.administrator });
const plural = (n: number, one = "line") => `${n} ${one}${n === 1 ? "" : "s"}`;

export type IntakeRow = {
  id: string;
  toNo: number;
  status: string;
  origin: string;
  orderSource: string | null;
  orderDate: string;
  billingId: string;
  billing: string;
  delivery: string | null;
  godownId: string | null;
  godown: string | null;
  transporter: string | null;
  taken: string | null;
  takenById: string | null;
  backOfficeById: string | null;
  backOffice: string | null;
  backOfficeAt: Date | null;
  productionById: string | null;
  production: string | null;
  productionAt: Date | null;
  correctionNote: string | null;
  holdReason: string | null;
  holdNote: string | null;
  heldBy: string | null;
  heldAt: Date | null;
  cancelReason: string | null;
  orderNo: number | null;
  createdAt: Date;
  updatedAt: Date;
  city: string | null;
  backOfficeNote: string | null;
  productionNote: string | null;
  updatedById: string | null;
  updatedBy: string | null;
  correctionBy: string | null;
  correctionAt: Date | null;
  remark: string | null;
  lines: { sku: string; skuId: string; qty: number; rate: number | null; discount: number | null; ml: number | null; cpb: number; boxed: boolean; active: boolean }[];
};

export async function intakeRows(where: ReturnType<typeof sql>): Promise<IntakeRow[]> {
  const rows = (await db.execute(sql`
    select i.id, i.to_no as "toNo", i.status, i.origin, i.order_source as "orderSource", i.order_date::text as "orderDate",
           i.billing_customer_id as "billingId", bc.name as billing, dc.name as delivery, i.godown_id as "godownId", g.name as godown,
           i.transporter, tu.name as taken, i.taken_by_id as "takenById",
           i.back_office_by_id as "backOfficeById", bo.name as "backOffice", i.back_office_at as "backOfficeAt",
           i.production_by_id as "productionById", pr.name as production, i.production_at as "productionAt",
           i.correction_note as "correctionNote", i.hold_reason as "holdReason", i.hold_note as "holdNote", hu.name as "heldBy", i.held_at as "heldAt",
           i.cancel_reason as "cancelReason", i.order_no as "orderNo", i.created_at as "createdAt", i.updated_at as "updatedAt",
           ${placeNameSql("bc", "city", "city")} as city, i.back_office_note as "backOfficeNote", i.production_note as "productionNote", i.updated_by_id as "updatedById", uu.name as "updatedBy",
           cu.name as "correctionBy", i.correction_at as "correctionAt", i.remark,
           coalesce((select json_agg(json_build_object('sku', p.name, 'skuId', l.sku_id, 'qty', l.qty_cans, 'rate', l.rate_paise, 'discount', l.discount_bp,
                    'ml', coalesce(p.millilitres_per_can, fg.millilitres), 'cpb', coalesce(p.cans_per_box, 1),
                    'boxed', coalesce(pk.box_type, '') <> '', 'active', p.active) order by l.position)
              from erp_order_intake_lines l join products p on p.id = l.sku_id left join finished_goods fg on fg.id = p.finished_good_id
              left join erp_product_packing pk on pk.product_id = p.id
             where l.intake_id = i.id), '[]'::json) as lines
      from erp_order_intakes i
      join customers bc on bc.id = i.billing_customer_id
      left join customers dc on dc.id = i.delivery_customer_id
      left join erp_godowns g on g.id = i.godown_id
      left join users tu on tu.id = i.taken_by_id
      left join users bo on bo.id = i.back_office_by_id
      left join users pr on pr.id = i.production_by_id
      left join users hu on hu.id = i.held_by_id
      left join users uu on uu.id = i.updated_by_id
      left join users cu on cu.id = i.correction_by_id
     where ${where}
     order by i.created_at asc
     limit 1500
  `)) as unknown as IntakeRow[];
  return rows.map((r) => ({ ...r, toNo: Number(r.toNo), orderNo: r.orderNo == null ? null : Number(r.orderNo), lines: (r.lines ?? []).map((l) => ({ ...l, qty: Number(l.qty), rate: l.rate == null ? null : Number(l.rate), discount: l.discount == null ? null : Number(l.discount), ml: l.ml == null ? null : Number(l.ml), cpb: Number(l.cpb) || 1, boxed: !!l.boxed, active: l.active !== false })) }));
}

const valueOf = (r: IntakeRow) => r.lines.reduce((n, l) => n + (l.rate == null ? 0 : Math.round(l.rate * l.qty * (1 - (l.discount ?? 0) / 10000))), 0);
const litresOf = (r: IntakeRow) => Math.round(r.lines.reduce((n, l) => n + ((l.ml ?? 0) * l.qty) / 1000, 0));
const sourceOf = (r: IntakeRow) => (r.origin === "erp" ? (r.orderSource ?? "ERP") : ORIGIN_SOURCE[r.origin as "crm" | "mbos"]);

function ageWords(from: Date): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

function checkWords(r: IntakeRow): string {
  const back = r.backOfficeById ? `✓ Back office · ${r.backOffice ?? ""}` : "○ Back office";
  const prod = r.productionById ? `✓ Production Head · ${r.production ?? ""}` : "○ Production Head";
  return `${back}\n${prod}`;
}

/** What a TO on the hub offers: shared by the list and the Order Hub board. */
export function hubActions(r: IntakeRow, next: ReturnType<typeof nextCheck>, dup: string | null, noRate: boolean): ActionSpec[] {
  const actions: ActionSpec[] = [];
  if (r.status === "open")
    actions.push({
      id: "verify",
      l: next.ok ? `Verify (${CHECK_LABEL[next.check]})` : "Verify",
      primary: true,
      why: next.ok ? (noRate ? "Add the rate to every line first" : !r.godownId ? "Pick the godown first" : "") : next.why,
      prompt: {
        title: `Verify TO-${r.toNo}`,
        sub: `${r.billing} · ${plural(r.lines.length)}${dup ? ` · ${dup} for this party today has exactly these goods` : ""}. ${next.ok && (next.check === "production" ? r.backOfficeById : r.productionById) ? "This is the second check: it makes the order number." : "The other check is still to come."}`,
        submit: "Verify",
        fields: [{ k: "note", l: "Note", t: "area", mic: true }],
      },
    });
  if (intakeEditable(r.status)) actions.push({ id: "editTo", l: "Edit TO", loadsForm: true });
  if (r.status === "open") actions.push({ id: "correct", l: "Send back for correction", prompt: { title: `Send TO-${r.toNo} back`, sub: "It goes back to whoever took it, with your reason. Both checks start again after their edit.", submit: "Send back", fields: [{ k: "note", l: "What needs correcting", t: "area", req: true, mic: true }] } });
  if (intakeEditable(r.status))
    actions.push({
      id: "hold",
      l: "Put on hold",
      prompt: {
        title: `Hold TO-${r.toNo}`,
        sub: "It moves to To Hold as Order verification. Releasing it brings it back here for both checks.",
        submit: "Put on hold",
        fields: [
          { k: "reason", l: "Reason", t: "select", req: true, opts: [...INTAKE_HOLD_REASONS] },
          { k: "note", l: "Remarks", t: "area", mic: true },
        ],
      },
    });
  if (r.status !== "verified" && r.status !== "cancelled")
    actions.push({ id: "cancel", l: "Cancel TO", prompt: { title: `Cancel TO-${r.toNo}`, sub: r.origin !== "erp" ? "The order taken on the call or the Salesman App is cancelled with it." : undefined, submit: "Cancel TO", fields: [{ k: "reason", l: "Why", t: "area", req: true, mic: true }] } });
  if (r.orderNo) actions.push({ id: "open", l: `Open order ${r.orderNo}`, primary: true, href: erpLink("orders", { fl: `Order ${r.orderNo}` }) });
  return actions;
}

/* ============================================================== Order Hub */

const HUB_COLS = (money: boolean): ColSpec[] => [
  { k: "to", l: "TO", t: "b" },
  { k: "party", l: "Party", t: "t" },
  { k: "taken", l: "Taken by", t: "t" },
  { k: "goods", l: "Goods", t: "t", w: 260 },
  ...(money ? [{ k: "value", l: "Value", t: "m" } as ColSpec] : []),
  { k: "checks", l: "Checks", t: "t" },
  { k: "waiting", l: "Waiting", t: "t" },
  { k: "status", l: "Status", t: "s" },
];

function hubModule(key: "orderHub" | "hubCorrection" | "hubDone"): ScreenModule {
  const where =
    key === "orderHub" ? sql`i.status = 'open'` : key === "hubCorrection" ? sql`i.status = 'correction'` : sql`i.status in ('verified', 'cancelled') and i.updated_at > now() - interval '14 days'`;
  return {
    key,
    async load(ctx, scope) {
      const rows = await intakeRows(where);
      const seeMoney = ctx.powers.has("viewSalesAmounts");
      const who = checker(ctx);
      /* A possible duplicate, among the TOs on this list: same party, day and goods. */
      const shapes = rows.map((r) => ({ key: `TO-${r.toNo}`, billingId: r.billingId, date: r.orderDate, lines: r.lines.map((l) => ({ skuId: l.skuId, qtyCans: l.qty })) }));
      return {
        spec: {
          screen: key,
          cols: HUB_COLS(seeMoney),
          hidden: [],
          sortDefault: ["to", key === "hubDone" ? -1 : 1],
          stats: [{ l: key === "orderHub" ? "Waiting for checks" : key === "hubCorrection" ? "Sent back" : "Checked in 14 days" }],
          filters: ["taken", "status"],
          noDataLine: key === "orderHub" ? "Nothing waiting. A new order lands here as a TO number." : key === "hubCorrection" ? "Nothing sent back." : "Nothing checked in the last 14 days.",
          ...(key === "orderHub" ? await newFormIn(scope, async () => ({ ...(await orderForm(ctx)), screen: key })) : {}),
          ...(key === "orderHub" ? { newLabel: "New order" } : {}),
        },
        rows: rows.map((r): ListRow => {
          const dup = r.status === "open" ? duplicateOf(shapes.find((s) => s.key === `TO-${r.toNo}`)!, shapes) : null;
          const next = nextCheck(r, who);
          const noRate = r.lines.some((l) => l.rate == null);
          const flags = [
            ...(r.status === "open" ? ["hubWaiting"] : []),
            ...(dup ? ["hubDuplicate"] : []),
            ...(noRate && intakeEditable(r.status) ? ["hubNoRate"] : []),
            ...(!r.godownId && intakeEditable(r.status) ? ["hubNoGodown"] : []),
          ];
          const goods = r.lines.map((l) => `${l.sku} × ${l.qty}`).join(", ");
          const actions = hubActions(r, next, dup, noRate);
          const fields: RowField[] = [
            { l: "Source", v: `${sourceOf(r)}${r.taken ? ` · ${r.taken}` : ""}` },
            { l: "Order date", v: r.orderDate },
            { l: "Godown", v: r.godown ?? "Not picked" },
            { l: "Delivery party", v: r.delivery ?? r.billing },
            { l: "Transporter", v: r.transporter ?? "The delivery party's" },
            { l: "Lines", v: r.lines.map((l) => `${l.sku} × ${l.qty} cans${l.rate == null ? " · no rate" : seeMoney ? ` · ${money(l.rate)}` : ""}`).join("\n") },
            { l: "Back office", v: r.backOfficeById ? `${r.backOffice ?? ""} · ${stamp(r.backOfficeAt!)}` : "Not yet" },
            { l: "Production Head", v: r.productionById ? `${r.production ?? ""} · ${stamp(r.productionAt!)}` : "Not yet" },
            ...(r.correctionNote ? [{ l: "Sent back", v: r.correctionNote }] : []),
            ...(r.cancelReason ? [{ l: "Cancelled", v: r.cancelReason }] : []),
            ...(r.orderNo ? [{ l: "Order number", v: String(r.orderNo) }] : []),
          ];
          return {
            id: r.id,
            v: {
              to: `TO-${r.toNo}`,
              party: r.billing,
              taken: `${sourceOf(r)}${r.taken ? ` · ${r.taken}` : ""}`,
              goods: `${goods} · ${litresOf(r)} L`,
              ...(seeMoney ? { value: valueOf(r) } : {}),
              checks: checkWords(r),
              waiting: ageWords(r.createdAt),
              status: r.orderNo ? `${INTAKE_STATUS_LABEL[r.status as IntakeStatus]} · ${r.orderNo}` : INTAKE_STATUS_LABEL[r.status as IntakeStatus] ?? r.status,
            },
            flags,
            title: `TO-${r.toNo} · ${r.billing}`,
            header: r.correctionNote && r.status === "correction" ? `Sent back: ${r.correctionNote}` : `${INTAKE_STATUS_LABEL[r.status as IntakeStatus]} · ${plural(r.lines.length)} · ${litresOf(r)} L`,
            fields,
            actions,
          };
        }),
      };
    },
    actions: {
      async verify(ctx, id, v) {
        const res = await checkIntake(checker(ctx), id, text(v.note));
        if (!res.ok) return res;
        await erpAudit(ctx, "erp.intake.check", "erp_order_intake", id, null, { check: res.data.check, orderNo: res.data.orderNo });
        return okVoid(res.data.orderNo ? `TO-${res.data.toNo} → order ${res.data.orderNo} · with Accounts for approval` : `TO-${res.data.toNo} · ${CHECK_LABEL[res.data.check]} check done · waiting for the other`);
      },
      async correct(ctx, id, v) {
        const note = text(v.note);
        if (!note) return fieldErr("note", "Say what needs correcting");
        if (!ctx.powers.has("verifyOrders") && !ctx.powers.has("productionCheck") && !ctx.administrator) return err("Only the back office or the Production Head sends a TO back.", "not_permitted");
        const res = await sendBackIntake(ctx.user.id, id, note);
        if (res.ok) await erpAudit(ctx, "erp.intake.correct", "erp_order_intake", id, null, { note });
        return res;
      },
      async hold(ctx, id, v) {
        const reason = text(v.reason);
        if (!reason) return fieldErr("reason", "Pick the reason");
        const res = await holdIntake(ctx.user.id, id, reason, text(v.note));
        if (res.ok) await erpAudit(ctx, "erp.intake.hold", "erp_order_intake", id, null, { reason, note: text(v.note) });
        return res;
      },
      async cancel(ctx, id, v) {
        const reason = text(v.reason);
        if (!reason) return fieldErr("reason", "Say why");
        const res = await cancelIntake(ctx.user.id, id, reason);
        if (res.ok) await erpAudit(ctx, "erp.intake.cancel", "erp_order_intake", id, null, { reason });
        return res;
      },
    },
    formLoaders: {
      async editTo(ctx, id) {
        const got = await intakeById(id);
        if (!got || !intakeEditable(got.intake.status)) return null;
        return intakeForm(ctx, got.intake, got.lines, key);
      },
    },
    forms: {
      new: (ctx, h, ls) => saveOrder(ctx, h, ls),
      async editTo(ctx, h, ls, id) {
        if (!id) return err("No TO named.", "not_found");
        const got = await intakeById(id);
        if (!got) return err("That TO no longer exists.", "not_found");
        return saveOrder(ctx, h, ls, { id, toNo: got.intake.toNo });
      },
    },
  };
}

/* ============================================================== MRP check */

type GateLine = {
  id: string;
  orderNo: number;
  orderDate: string;
  godownId: string;
  godown: string;
  billing: string;
  skuId: string;
  sku: string;
  qty: number;
  ml: number | null;
  cpb: number;
  boxed: boolean;
  finishedGoodId: string | null;
  formulationId: string | null;
  formulation: string | null;
  canMaterialId: string | null;
  canMaterial: string | null;
  productionCheck: string;
  accountsCheckedAt: Date | null;
  dispatchOn: string | null;
  toNo: number | null;
};

async function waitingForMrp(): Promise<GateLine[]> {
  const rows = (await db.execute(sql`
    select o.id, o.order_no as "orderNo", o.order_date::text as "orderDate", o.godown_id as "godownId", g.name as godown, bc.name as billing,
           o.sku_id as "skuId", p.name as sku, o.qty_cans as qty, coalesce(p.millilitres_per_can, fg.millilitres) as ml,
           coalesce(p.cans_per_box, 1) as cpb, coalesce(pk.box_type, '') <> '' as boxed,
           p.finished_good_id as "finishedGoodId", fg.formulation_id as "formulationId", f.name as formulation,
           pk.can_use_material_id as "canMaterialId", rm.name as "canMaterial",
           o.production_check as "productionCheck", o.accounts_checked_at as "accountsCheckedAt", o.dispatch_on::text as "dispatchOn",
           i.to_no as "toNo"
      from erp_orders o
      join erp_godowns g on g.id = o.godown_id
      join customers bc on bc.id = o.billing_customer_id
      join products p on p.id = o.sku_id
      left join finished_goods fg on fg.id = p.finished_good_id
      left join product_formulations f on f.id = fg.formulation_id
      left join erp_product_packing pk on pk.product_id = p.id
      left join erp_raw_materials rm on rm.id = pk.can_use_material_id
      left join erp_order_intakes i on i.id = o.intake_id
     where o.status <> 'Cancel' and o.source = 'erp' and o.accounts_check = 'Approved' and o.production_check in ('Pending', 'Hold')
     order by o.accounts_checked_at nulls last, o.order_no, o.created_at
     limit 3000
  `)) as unknown as GateLine[];
  return rows.map((r) => ({ ...r, orderNo: Number(r.orderNo), qty: Number(r.qty), ml: r.ml == null ? null : Number(r.ml), cpb: Number(r.cpb) || 1, toNo: r.toNo == null ? null : Number(r.toNo) }));
}

/** What the godown holds now, for the MRP check — read once per page. */
async function stockAt(godownIds: string[]): Promise<Map<string, MrpStock>> {
  const out = new Map<string, MrpStock>();
  if (!godownIds.length) return out;
  const [packs, fgs, sfgs, rms, qc, recipes] = await Promise.all([
    packLots(db, { rates: false }),
    fgLots(db, { rates: false }),
    sfgLots(db, { rates: false }),
    rmLots(db, { rates: false }),
    db.execute(sql`select lot_code as "lotCode", status from erp_sfg_qc`) as unknown as Promise<{ lotCode: string; status: string }[]>,
    db.execute(sql`select formulation_id as "formulationId", raw_material_id as "materialId", qty_per_batch::float8 as qty from erp_recipes`) as unknown as Promise<{ formulationId: string; materialId: string; qty: number }[]>,
  ]);
  const qcOf = new Map(qc.map((q) => [q.lotCode, q.status]));
  const recipe = new Map<string, Map<string, number>>();
  for (const r of recipes) {
    const m = recipe.get(r.formulationId) ?? new Map<string, number>();
    m.set(r.materialId, Number(r.qty));
    recipe.set(r.formulationId, m);
  }
  for (const gid of new Set(godownIds)) {
    const s: MrpStock = { packedBoxes: new Map(), looseCans: new Map(), baseLitres: new Map(), batchLitres: new Map(), material: new Map(), materialName: new Map(), materialUnit: new Map(), recipe };
    const add = (m: Map<string, number>, k: string | null, n: number) => k && m.set(k, (m.get(k) ?? 0) + n);
    for (const p of packs) if (p.godownId === gid && p.stock > 0) add(s.packedBoxes, p.skuId, p.stock);
    for (const f of fgs) if (f.godownId === gid && f.stock > 0) add(s.looseCans, f.finishedGoodId, f.stock);
    for (const b of sfgs) {
      if (b.godownId !== gid) continue;
      if (b.batchSize && b.batchSize > 0) s.batchLitres.set(b.formulationId, b.batchSize);
      /* No QC row reads as Pending (`erp_sfg_qc`): only approved base can be filled. */
      if (b.stock > 0 && qcOf.get(b.lotCode) === "Approved") add(s.baseLitres, b.formulationId, b.stock);
    }
    for (const r of rms) {
      s.materialName.set(r.rawMaterialId, r.item);
      s.materialUnit.set(r.rawMaterialId, r.unit);
      if (r.godownId === gid && r.stock > 0) add(s.material, r.rawMaterialId, r.stock);
    }
    out.set(gid, s);
  }
  return out;
}

/** What an order on the MRP check offers: shared by the list and the MRP board. */
function mrpActions(no: number, short: boolean, sentence: string, held: boolean, decider: boolean): ActionSpec[] {
  return held
          ? [{ id: "toHold", l: "Open in To Hold", href: erpLink("toHold"), primary: true }]
          : [
              {
                id: "clear",
                l: "Clear for production",
                primary: true,
                why: decider ? "" : "Only the Production Head clears an order",
                prompt: {
                  title: `Clear order ${no} for production`,
                  sub: short ? `${sentence}. Clear it only if you know the material will arrive in time; that is recorded.` : "It joins Under Process and the day's production plan.",
                  submit: "Clear for production",
                  fields: [
                    { k: "capacity", l: "The floor can make it in time", t: "select", req: true, opts: ["Yes"] },
                    { k: "note", l: "Note", t: "area", mic: true },
                  ],
                },
              },
              {
                id: "hold",
                l: "Put on hold",
                why: decider ? "" : "Only the Production Head holds an order here",
                prompt: {
                  title: `Hold order ${no}`,
                  sub: "It moves to To Hold as Production. Releasing it brings it back to this check with the stock as it is then.",
                  submit: "Put on hold",
                  fields: [
                    { k: "reason", l: "Reason", t: "select", req: true, opts: PRODUCTION_HOLD_REASONS.map((r) => r.label) },
                    { k: "note", l: "Remarks (staff only)", t: "area", mic: true },
                    { k: "customerText", l: "What the customer reads", t: "area", hint: "Filled from the reason when left blank. Remarks never reach the customer." },
                  ],
                },
              },
            ];
}

export const mrpCheckScreen: ScreenModule = {
  key: "mrpCheck",
  async load(ctx) {
    const lines = await waitingForMrp();
    const byOrder = new Map<number, GateLine[]>();
    for (const l of lines) byOrder.set(l.orderNo, [...(byOrder.get(l.orderNo) ?? []), l]);
    const stock = await stockAt([...new Set(lines.map((l) => l.godownId))]);
    const holds = await openHolds([...byOrder.keys()]);
    const decider = ctx.powers.has("productionCheck") || ctx.administrator;
    const rows: ListRow[] = [];
    for (const [no, ls] of byOrder) {
      const head = ls[0];
      const answer = mrpCheck(
        ls.map(
          (l): MrpLine => ({
            lineId: l.id,
            sku: l.sku,
            skuId: l.skuId,
            cans: l.qty,
            litresPerCan: (l.ml ?? 0) / 1000,
            boxed: l.boxed,
            cansPerBox: l.cpb,
            finishedGoodId: l.finishedGoodId,
            formulationId: l.formulationId,
            formulation: l.formulation,
            canMaterialId: l.canMaterialId,
            canMaterial: l.canMaterial,
          }),
        ),
        stock.get(head.godownId)!,
      );
      const h = holds.get(no);
      /* ANY open hold makes the order held here, not only the MRP check's own.
         An order held from the Office (the orders list, To Hold) kept its
         production check "Pending", so it sat on this list as waiting with a
         "Put on hold" that could only be refused — "already on hold, resolve
         that first" — and read as the button not working (2026-11-17,
         order 10254). It is shown held, and To Hold is where it is released. */
      const held = ls.some((l) => l.productionCheck === "Hold") || !!h;
      const fields: RowField[] = [
        ...answer.lines.map((a) => ({ l: a.sku, v: `${a.cans} cans needed · ${a.onShelfCans} on the shelf · ${a.toMakeCans ? `${a.toMakeCans} cans (${a.toMakeLitres} L) to make` : "nothing to make"}${a.boxesToPack ? ` · ${a.boxesToPack} boxes to pack` : ""}` })),
        ...answer.bases.map((b) => ({
          l: `Base · ${b.formulation}`,
          v: `${b.needLitres} L needed · ${b.inTank} L approved in the tank${b.shortLitres ? ` · ${b.shortLitres} L to mix (${b.batches} batch${b.batches === 1 ? "" : "es"}${b.batchGuessed ? ", size not known" : ""})` : ""}${b.materials.length ? `\n${b.materials.map((m) => `${m.name}: ${m.need} needed, ${m.stock} in stock${m.short ? ` — short ${m.short}` : ""}`).join("\n")}` : ""}`,
        })),
        ...answer.cans.map((c) => ({ l: c.name, v: `${c.need} needed · ${c.stock} in stock${c.short ? ` — short ${c.short}` : ""}` })),
        ...(answer.unknown.length ? [{ l: "Not known", v: `${answer.unknown.join(", ")}: the product names no base, so its making cannot be checked.` }] : []),
        { l: "Capacity", v: "Your call: MahekOne does not know the floor's capacity." },
        ...(h ? [{ l: h.department === "production" ? "On hold" : `On hold · ${DEPARTMENT_LABEL[h.department as HoldDepartment] ?? h.department}`, v: `${reasonLabel(h.reason)}${h.internalNote ? ` — ${h.internalNote}` : ""}` }] : []),
      ];
      const sentence = answer.short.length ? `Short: ${answer.short.join("; ")}` : "Everything it needs is in stock now";
      rows.push({
        id: head.id,
        v: {
          order: `Order ${no}`,
          to: head.toNo ? `TO-${head.toNo}` : "",
          party: head.billing,
          godown: head.godown,
          goods: ls.map((l) => `${l.sku} × ${l.qty}`).join(", "),
          dispatch: head.dispatchOn,
          answer: sentence,
          status: held ? "On hold" : "Waiting for MRP check",
        },
        flags: [held ? "mrpHold" : "mrpPending", ...(answer.short.length ? ["mrpShort"] : [])],
        title: `Order ${no} · ${head.billing}`,
        header: sentence,
        fields,
        actions: mrpActions(no, answer.short.length > 0, sentence, held, decider),
      });
    }
    return {
      spec: {
        screen: "mrpCheck",
        cols: [
          { k: "order", l: "Order", t: "b" },
          { k: "to", l: "TO", t: "t" },
          { k: "party", l: "Party", t: "t" },
          { k: "goods", l: "Goods", t: "t", w: 240 },
          { k: "answer", l: "Materials", t: "t", w: 260 },
          { k: "dispatch", l: "Dispatch on", t: "d" },
          { k: "status", l: "Status", t: "s" },
        ],
        hidden: [],
        stats: [{ l: "Waiting" }, { l: "Short of material", where: { flag: "mrpShort" }, tone: "danger" }],
        filters: ["godown", "status"],
        noDataLine: "Nothing waiting. An order comes here once Accounts approve it.",
      },
      rows,
    };
  },
  actions: {
    async clear(ctx, id, v) {
      if (!ctx.powers.has("productionCheck") && !ctx.administrator) return err("Only the Production Head clears an order.", "not_permitted");
      if (text(v.capacity) !== "Yes") return fieldErr("capacity", "Confirm the floor can make it");
      const [l] = await db.select({ no: erpOrders.orderNo }).from(erpOrders).where(eq(erpOrders.id, id));
      if (!l) return err("That order no longer exists.", "not_found");
      const open = (await openHolds([l.no])).get(l.no);
      if (open) return err(`Order ${l.no} is on hold (${reasonLabel(open.reason)}). Release it in To Hold first.`, "conflict");
      const done = await db
        .update(erpOrders)
        .set({ productionCheck: "Cleared", productionCheckedById: ctx.user.id, productionCheckedAt: new Date(), productionNote: text(v.note), updatedAt: new Date(), updatedById: ctx.user.id })
        .where(and(eq(erpOrders.orderNo, l.no), eq(erpOrders.productionCheck, "Pending"), eq(erpOrders.accountsCheck, "Approved")))
        .returning({ id: erpOrders.id });
      if (!done.length) return err(`Order ${l.no} is not waiting for the MRP check.`, "conflict");
      await erpAudit(ctx, "erp.order.mrpClear", "erp_order", String(l.no), null, { note: text(v.note) });
      const { syncBookOrders } = await import("../book");
      await syncBookOrders([l.no]);
      return okVoid(`Order ${l.no} cleared · it is in Under Process and the day's plan`);
    },
    async hold(ctx, id, v) {
      if (!ctx.powers.has("productionCheck") && !ctx.administrator) return err("Only the Production Head holds an order here.", "not_permitted");
      const reason = PRODUCTION_HOLD_REASONS.find((r) => r.label === text(v.reason));
      if (!reason) return fieldErr("reason", "Pick the reason");
      const [l] = await db.select({ no: erpOrders.orderNo }).from(erpOrders).where(eq(erpOrders.id, id));
      if (!l) return err("That order no longer exists.", "not_found");
      return holdOrder(ctx.user.id, l.no, "production", reason.code, text(v.note), text(v.customerText), ctx);
    },
  },
};

/**
 * HOLDS AN ORDER AT A DESK (Accounts or the MRP check): one `erp_order_holds`
 * row with its department, and the lines' own check moved to Hold so the
 * order leaves that desk's queue. The lines' status is not touched — they were
 * never in production. The customer is not messaged: an order is confirmed to
 * them only once Accounts approve it.
 */
export async function holdOrder(userId: string, orderNo: number, department: "accounts" | "production", reason: string, note: string | null, customerText: string | null, ctx?: ErpContext, nextUpdateOn?: string | null): Promise<Result<unknown>> {
  const sentence = customerText?.trim() || HOLD_CUSTOMER_TEXT[reason] || HOLD_CUSTOMER_TEXT.other;
  const column = department === "accounts" ? erpOrders.accountsCheck : erpOrders.productionCheck;
  try {
    await db.transaction(async (tx) => {
      const moved = await tx
        .update(erpOrders)
        .set(department === "accounts" ? { accountsCheck: "Hold", updatedAt: new Date(), updatedById: userId } : { productionCheck: "Hold", updatedAt: new Date(), updatedById: userId })
        .where(and(eq(erpOrders.orderNo, orderNo), eq(column, "Pending"), sql`${erpOrders.status} <> 'Cancel'`))
        .returning({ id: erpOrders.id });
      if (!moved.length) throw new Stop(err(`Order ${orderNo} is not waiting at ${department === "accounts" ? "Accounts" : "the MRP check"}.`, "conflict"));
      const r = await recordHold({ user: { id: userId } } as unknown as Pick<ErpContext, "user">, orderNo, { kind: "hold", reason, customerText: sentence, internalNote: note, department, nextUpdateOn: nextUpdateOn || null }, tx as unknown as typeof db);
      if (!r.ok) throw new Stop(r);
    });
  } catch (e) {
    if (e instanceof Stop) return e.result;
    throw e;
  }
  if (ctx) await erpAudit(ctx, "erp.order.deskHold", "erp_order", String(orderNo), null, { department, reason, note });
  const { syncBookOrders } = await import("../book");
  await syncBookOrders([orderNo]);
  return okVoid(`Order ${orderNo} is on hold · ${DEPARTMENT_LABEL[department]}`);
}

/** Releases a desk's hold: the order goes back to that desk's queue, never past it. */
export async function releaseOrderHold(userId: string, orderNo: number, department: "accounts" | "production", resolution: string | null): Promise<Result<unknown>> {
  const h = (await openHolds([orderNo])).get(orderNo);
  if (!h || h.department !== department) return err(`Order ${orderNo} is not on hold with ${DEPARTMENT_LABEL[department]}.`, "rule_violation");
  let closed = false;
  await db.transaction(async (tx) => {
    const c = await closeHold(userId, h.id, resolution, tx as unknown as typeof db);
    if (!c.ok) return;
    closed = true;
    await tx
      .update(erpOrders)
      .set(department === "accounts" ? { accountsCheck: "Pending", updatedAt: new Date(), updatedById: userId } : { productionCheck: "Pending", updatedAt: new Date(), updatedById: userId })
      .where(and(eq(erpOrders.orderNo, orderNo), eq(department === "accounts" ? erpOrders.accountsCheck : erpOrders.productionCheck, "Hold")));
  });
  if (!closed) return err(`The hold on order ${orderNo} is already resolved.`, "conflict");
  const { syncBookOrders } = await import("../book");
  await syncBookOrders([orderNo]);
  return okVoid(`Order ${orderNo} released · ${RELEASE_TO[department]}`);
}

/* ============================================================== To Hold */

type HoldRow = {
  key: string;
  kind: "to" | "order";
  number: string;
  sub: string;
  party: string;
  department: HoldDepartment;
  reason: string;
  note: string | null;
  customerText: string | null;
  by: string | null;
  at: Date;
  orderNo: number | null;
  lineId: string | null;
  intakeId: string | null;
  holdId: string | null;
  nextUpdateOn: string | null;
  customerId: string | null;
  taker: string | null;
};

async function allHolds(): Promise<HoldRow[]> {
  const tos = await intakeRows(sql`i.status = 'hold'`);
  const holds = (await db.execute(sql`
    select h.id, h.order_no as "orderNo", h.department, h.reason, h.internal_note as note, h.customer_text as "customerText", h.raised_at as at, u.name as by,
           h.next_update_on::text as "nextUpdateOn",
           (select o.billing_customer_id from erp_orders o where o.order_no = h.order_no limit 1) as "customerId",
           (select tu.name from erp_order_intakes i join users tu on tu.id = i.taken_by_id where i.order_no = h.order_no) as taker,
           (select o.id from erp_orders o where o.order_no = h.order_no order by o.created_at limit 1) as "lineId",
           (select c.name from erp_orders o join customers c on c.id = o.billing_customer_id where o.order_no = h.order_no limit 1) as party,
           (select i.to_no from erp_order_intakes i where i.order_no = h.order_no) as "toNo"
      from erp_order_holds h left join users u on u.id = h.raised_by_id
     where h.resolved_at is null and h.kind = 'hold'
     order by h.raised_at
  `)) as unknown as { id: string; orderNo: number; department: string; reason: string; note: string | null; customerText: string; at: Date; by: string | null; lineId: string | null; party: string | null; toNo: number | null; nextUpdateOn: string | null; customerId: string | null; taker: string | null }[];
  return [
    ...tos.map(
      (t): HoldRow => ({ key: `to:${t.id}`, kind: "to", number: `TO-${t.toNo}`, sub: "No order number yet", party: t.billing, department: "verification", reason: t.holdReason ?? "", note: t.holdNote, customerText: null, by: t.heldBy, at: t.heldAt ?? t.updatedAt, orderNo: null, lineId: null, intakeId: t.id, holdId: null, nextUpdateOn: null, customerId: t.billingId, taker: t.taken }),
    ),
    ...holds.map(
      (h): HoldRow => ({
        key: `hold:${h.id}`,
        kind: "order",
        number: `Order ${h.orderNo}`,
        sub: h.toNo ? `TO-${h.toNo}` : "",
        party: h.party ?? "",
        department: (h.department as HoldDepartment) ?? "office",
        reason: reasonLabel(h.reason),
        note: h.note,
        customerText: h.customerText,
        by: h.by,
        at: h.at,
        orderNo: Number(h.orderNo),
        lineId: h.lineId,
        intakeId: null,
        holdId: h.id,
        nextUpdateOn: h.nextUpdateOn,
        customerId: h.customerId,
        taker: h.taker,
      }),
    ),
  ];
}

function mayRelease(ctx: ErpContext, d: HoldDepartment): string {
  if (ctx.administrator) return "";
  if (d === "verification") return ctx.powers.has("verifyOrders") || ctx.powers.has("productionCheck") ? "" : "The back office or the Production Head releases it";
  if (d === "production") return ctx.powers.has("productionCheck") ? "" : "The Production Head releases it";
  if (d === "accounts") return "Accounts release it, from Order approvals";
  return "";
}

/** The id a hold row is acted on by: the TO, or `department:order:line`. */
function holdRowId(r: HoldRow): string {
  return r.kind === "to" ? r.intakeId! : `${r.department}:${r.orderNo}:${r.lineId ?? ""}`;
}

/** What a row on To Hold offers: shared by the list and the To Hold board. */
function holdActions(ctx: ErpContext, r: HoldRow): ActionSpec[] {
  const why = mayRelease(ctx, r.department);
  const releaseId = r.kind === "to" ? "releaseTo" : r.department === "office" ? "releaseOffice" : "releaseDesk";
  const editWhy = r.department === "accounts" && !ctx.administrator ? "Accounts edit their own hold, from Order approvals" : why;
  return [
    {
      id: releaseId,
      l: "Release",
      primary: true,
      why,
      prompt: {
        title: `Release ${r.number}`,
        sub: `It goes ${RELEASE_TO[r.department]}.`,
        submit: "Release",
        fields: [
          { k: "resolution", l: "What changed", t: "area", req: r.department !== "verification", mic: true },
          ...(r.kind === "order" ? ([{ k: "notify", l: "Tell the customer the hold is over", t: "select", opts: ["Yes"] }] as FieldSpec[]) : []),
        ],
      },
    },
    {
      id: "editHold",
      l: "Edit hold",
      why: editWhy,
      prompt: {
        title: `Edit the hold on ${r.number}`,
        submit: "Save",
        fields: [
          { k: "note", l: "Remarks (staff only)", t: "area", mic: true },
          ...(r.kind === "order"
            ? ([
                { k: "customerText", l: "What the customer sees on the tracking link", t: "area" },
                { k: "nextUpdateOn", l: "Look at it again on", t: "date" },
              ] as FieldSpec[])
            : []),
        ],
      },
    },
    ...(r.kind === "to"
      ? [{ id: "open", l: "Open the Order Hub", href: erpLink("orderHub", { open: r.intakeId }) }]
      : r.orderNo
        ? [
            { id: "editOrder", l: "Edit order", href: erpLink("orders", { fl: `Order ${r.orderNo}` }) },
            { id: "open", l: `Open order ${r.orderNo}`, href: erpLink("orders", { fl: `Order ${r.orderNo}` }) },
            { id: "cancelOrder", l: "Cancel order…", href: erpLink("orders", { fl: `Order ${r.orderNo}` }) },
          ]
        : []),
  ];
}

export const toHoldScreen: ScreenModule = {
  key: "toHold",
  async load(ctx) {
    const rows = await allHolds();
    return {
      spec: {
        screen: "toHold",
        cols: [
          { k: "number", l: "Number", t: "b" },
          { k: "party", l: "Party", t: "t" },
          { k: "department", l: "Department", t: "s" },
          { k: "reason", l: "Reason", t: "t" },
          { k: "note", l: "Remarks", t: "t", w: 240 },
          { k: "by", l: "Held by", t: "t" },
          { k: "at", l: "Held on", t: "d" },
        ],
        hidden: [],
        chips: "department",
        stats: [
          { l: "On hold" },
          { l: "Order verification", where: { k: "department", in: [DEPARTMENT_LABEL.verification] } },
          { l: "Accounts", where: { k: "department", in: [DEPARTMENT_LABEL.accounts] } },
          { l: "Production", where: { k: "department", in: [DEPARTMENT_LABEL.production] } },
        ],
        filters: ["department"],
        noDataLine: "Nothing on hold. A hold from any desk lands here.",
      },
      rows: rows.map((r): ListRow => {
        return {
          id: holdRowId(r),
          v: { number: r.sub ? `${r.number} · ${r.sub}` : r.number, party: r.party, department: DEPARTMENT_LABEL[r.department], reason: r.reason, note: r.note, by: r.by, at: calendarDate(new Date(r.at)) },
          flags: [],
          title: `${r.number} · ${r.party}`,
          header: `${DEPARTMENT_LABEL[r.department]} · ${r.reason}`,
          fields: [
            { l: "Held by", v: `${r.by ?? "—"} · ${stamp(new Date(r.at))}` },
            ...(r.note ? [{ l: "Remarks", v: r.note }] : []),
            ...(r.customerText ? [{ l: "The customer reads", v: r.customerText }] : []),
            { l: "Releasing sends it", v: RELEASE_TO[r.department] },
          ],
          actions: holdActions(ctx, r),
        };
      }),
    };
  },
  actions: {
    async releaseTo(ctx, id, v) {
      const why = mayRelease(ctx, "verification");
      if (why) return err(`${why}.`, "not_permitted");
      const res = await releaseIntake(ctx.user.id, id, text(v.resolution));
      if (res.ok) await erpAudit(ctx, "erp.intake.release", "erp_order_intake", id, null, { resolution: text(v.resolution) });
      return res;
    },
    async releaseDesk(ctx, id, v) {
      const [department, no] = id.split(":");
      if (department !== "production" && department !== "accounts") return err("That hold is not a desk's.", "rule_violation");
      const why = mayRelease(ctx, department);
      if (why) return err(`${why}.`, "not_permitted");
      const resolution = text(v.resolution);
      if (!resolution) return fieldErr("resolution", "Say what changed");
      const was = (await openHolds([Number(no)])).get(Number(no));
      const res = await releaseOrderHold(ctx.user.id, Number(no), department, resolution);
      if (res.ok) {
        await erpAudit(ctx, "erp.order.deskRelease", "erp_order", no, null, { department, resolution });
        if (was && text(v.notify) === "Yes") await tellHold(was.id, ctx.user.id, true).catch(() => null);
      }
      return res;
    },
    async editHold(ctx, id, v) {
      if (!id.includes(":")) {
        if (mayRelease(ctx, "verification")) return err(`${mayRelease(ctx, "verification")}.`, "not_permitted");
        const res = await editIntakeHold(ctx.user.id, id, text(v.note));
        if (res.ok) await erpAudit(ctx, "erp.intake.holdEdit", "erp_order_intake", id, null, { note: text(v.note) });
        return res;
      }
      const [department, no] = id.split(":") as [HoldDepartment, string];
      if (department === "accounts" && !ctx.administrator) return err("Accounts edit their own hold, from Order approvals.", "not_permitted");
      const why = mayRelease(ctx, department);
      if (why) return err(`${why}.`, "not_permitted");
      const h = (await openHolds([Number(no)])).get(Number(no));
      if (!h) return err(`Order ${no} is not on hold.`, "conflict");
      const res = await updateHoldWords(h.id, { note: text(v.note), customerText: text(v.customerText), nextUpdateOn: text(v.nextUpdateOn) });
      if (res.ok) await erpAudit(ctx, "erp.order.holdEdit", "erp_order", no, null, { note: text(v.note), customerText: text(v.customerText), nextUpdateOn: text(v.nextUpdateOn) });
      return res;
    },
    async releaseOffice(ctx, id, v) {
      const [, , lineId] = id.split(":");
      if (!lineId) return err("That order has no lines.", "not_found");
      const { SALES_SCREENS } = await import("./sales");
      const orders = SALES_SCREENS.find((m) => m.key === "pendingOrders");
      const handler = orders?.actions?.resolveHold;
      if (!handler) return err("The release could not be run.", "conflict");
      return handler(ctx, lineId, { resolution: text(v.resolution) ?? "", notify: v.notify === "No" ? "No" : v.notify === "Yes" ? "Yes" : "" });
    },
  },
};

/** A hold's words changed in place: the staff remark, what the customer reads, when to look again. Blank keeps what was there. */
async function updateHoldWords(holdId: string, v: { note: string | null; customerText: string | null; nextUpdateOn: string | null }): Promise<Result<unknown>> {
  const set: Partial<typeof erpOrderHolds.$inferInsert> = {};
  if (v.note != null) set.internalNote = v.note;
  if (v.customerText != null) set.customerText = v.customerText;
  if (v.nextUpdateOn != null) set.nextUpdateOn = v.nextUpdateOn;
  if (!Object.keys(set).length) return fieldErr("note", "Change something first");
  const done = await db.update(erpOrderHolds).set(set).where(and(eq(erpOrderHolds.id, holdId), sql`${erpOrderHolds.resolvedAt} is null`)).returning({ id: erpOrderHolds.id });
  return done.length ? okVoid("Hold updated") : err("That hold is already resolved.", "conflict");
}

/** A TO's hold remark, changed in place. */
async function editIntakeHold(userId: string, intakeId: string, note: string | null): Promise<Result<unknown>> {
  const done = await db
    .update(erpOrderIntakes)
    .set({ holdNote: note, updatedAt: new Date(), updatedById: userId })
    .where(and(eq(erpOrderIntakes.id, intakeId), eq(erpOrderIntakes.status, "hold")))
    .returning({ id: erpOrderIntakes.id });
  return done.length ? okVoid("Hold updated") : err("That TO is not on hold.", "conflict");
}

/** Rolls a transaction back carrying the answer to give. */
class Stop extends Error {
  constructor(public result: Err) {
    super("stop");
  }
}

/**
 * The sidebar's badges for the hub's screens, read by `erpNavCounts`. Each is
 * the count its own list draws: TOs waiting for a check, TOs sent back,
 * orders waiting at the MRP check, and everything on To Hold.
 */
export async function orderHubCounts(): Promise<{ orderHub: number; hubCorrection: number; mrpCheck: number; toHold: number }> {
  const [byStatus, mrp, holds] = await Promise.all([
    db.execute(sql`select status, count(*)::int as n from erp_order_intakes where status in ('open', 'correction') group by status`) as unknown as Promise<{ status: string; n: number }[]>,
    waitingForMrp(),
    allHolds(),
  ]);
  const n = (k: string) => byStatus.find((r) => r.status === k)?.n ?? 0;
  return {
    orderHub: n("open"),
    hubCorrection: n("correction"),
    mrpCheck: (() => {
      const heldNos = new Set(holds.map((h) => h.orderNo).filter((n): n is number => n != null));
      return new Set(mrp.filter((l) => l.productionCheck === "Pending" && !heldNos.has(l.orderNo)).map((l) => l.orderNo)).size;
    })(),
    toHold: holds.length,
  };
}

export const ORDER_HUB_SCREENS: ScreenModule[] = [hubModule("orderHub"), hubModule("hubCorrection"), hubModule("hubDone"), mrpCheckScreen, toHoldScreen];

/* The Accounts app's hold dialog offers these. */
export { ACCOUNTS_HOLD_REASONS };

/* ============================================================== Order Hub board */

/**
 * THE ORDER HUB AS ITS OWN PAGE (`app/erp/order-hub`): every TO open, sent
 * back, on hold or verified in the last two days, with the facts the board and
 * the Verify dialog draw — who checked it and when, how long it has waited,
 * a possible duplicate, an edit by its taker, and the Production Head's
 * checklist (duplicate, active products, whole boxes, quantity against the
 * party's usual order). Its actions are `hubActions`, the list's own.
 */
export type HubCheckItem = { tone: "ok" | "warn"; text: string };
export type HubBoardRow = {
  id: string;
  toNo: number;
  status: string;
  party: string;
  billingId: string;
  city: string | null;
  source: string;
  takenBy: string | null;
  orderDate: string;
  godown: string | null;
  delivery: string;
  transporter: string | null;
  remark: string | null;
  lines: { sku: string; qty: number; boxes: number | null; litres: number | null; rate: number | null; amount: number | null; active: boolean }[];
  litres: number;
  value: number | null;
  back: { by: string | null; at: string; note: string | null } | null;
  prod: { by: string | null; at: string; note: string | null } | null;
  createdAt: string;
  dup: string | null;
  edited: { by: string | null; at: string } | null;
  correction: { note: string; by: string | null; at: string | null } | null;
  held: { reason: string; note: string | null; by: string | null; at: string | null } | null;
  cancelReason: string | null;
  orderNo: number | null;
  verifiedToday: boolean;
  myCheck: "backOffice" | "production" | null;
  second: boolean;
  checklist: HubCheckItem[];
  actions: ActionSpec[];
};

async function usualLitres(partyIds: string[]): Promise<Map<string, number>> {
  if (!partyIds.length) return new Map();
  const rows = (await db.execute(sql`
    select id, percentile_cont(0.5) within group (order by l) as usual from (
      select o.billing_customer_id as id, o.order_no,
             sum(o.qty_cans * coalesce(p.millilitres_per_can, fg.millilitres, 0))::float8 / 1000 as l,
             row_number() over (partition by o.billing_customer_id order by max(o.order_date) desc) as rn
        from erp_orders o join products p on p.id = o.sku_id left join finished_goods fg on fg.id = p.finished_good_id
       where o.billing_customer_id in (${sql.join(partyIds.map((x) => sql`${x}`), sql`, `)}) and o.status <> 'Cancel'
       group by o.billing_customer_id, o.order_no) x
     where rn <= 10 and l > 0 group by id`)) as unknown as { id: string; usual: number }[];
  return new Map(rows.map((r) => [r.id, Math.round(Number(r.usual))]));
}

export async function hubBoard(ctx: ErpContext): Promise<{ rows: HubBoardRow[]; seeMoney: boolean }> {
  const rows = await intakeRows(sql`i.status in ('open', 'correction', 'hold') or (i.status = 'verified' and i.updated_at > now() - interval '2 days')`);
  const seeMoney = ctx.powers.has("viewSalesAmounts");
  const who = checker(ctx);
  const today = calendarDate(new Date());
  const usual = await usualLitres([...new Set(rows.filter((r) => r.status === "open").map((r) => r.billingId))]);
  const open = rows.filter((r) => r.status === "open" || r.status === "correction" || r.status === "hold");
  const shapes = open.map((r) => ({ key: `TO-${r.toNo}`, billingId: r.billingId, date: r.orderDate, lines: r.lines.map((l) => ({ skuId: l.skuId, qtyCans: l.qty })) }));
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    seeMoney,
    rows: rows.map((r): HubBoardRow => {
      const dup = r.status === "open" ? duplicateOf(shapes.find((s) => s.key === `TO-${r.toNo}`)!, shapes) : null;
      const next = nextCheck(r, who);
      const noRate = r.lines.filter((l) => l.rate == null);
      const litres = litresOf(r);
      const lines = r.lines.map((l) => {
        const amount = l.rate == null ? null : Math.round(l.rate * l.qty * (1 - (l.discount ?? 0) / 10000));
        return {
          sku: l.sku,
          qty: l.qty,
          boxes: l.boxed && l.cpb > 1 && l.qty % l.cpb === 0 ? l.qty / l.cpb : null,
          litres: l.ml == null ? null : Math.round((l.ml * l.qty) / 1000),
          rate: seeMoney ? l.rate : null,
          amount: seeMoney ? amount : null,
          active: l.active,
        };
      });
      const checklist: HubCheckItem[] = [];
      checklist.push(dup ? { tone: "warn", text: `Possibly the same as ${dup}: same party, day and goods.` } : { tone: "ok", text: "No other open order for this party with these goods" });
      const inactive = r.lines.filter((l) => !l.active);
      checklist.push(
        inactive.length
          ? { tone: "warn", text: `${inactive.map((l) => l.sku).join(", ")} ${inactive.length === 1 ? "is" : "are"} no longer active.` }
          : { tone: "ok", text: `Every product is active${r.godown ? ` and made at ${r.godown}` : ""}` },
      );
      if (!r.godownId) checklist.push({ tone: "warn", text: "No godown picked yet. Edit the TO to pick one." });
      for (const l of r.lines.filter((x) => x.boxed && x.cpb > 1))
        checklist.push(
          l.qty % l.cpb === 0
            ? { tone: "ok", text: `${l.sku} is in whole boxes (${l.qty} cans = ${l.qty / l.cpb} boxes)` }
            : { tone: "warn", text: `${l.sku}: ${l.qty} cans is not whole boxes of ${l.cpb}.` },
        );
      if (noRate.length) checklist.push({ tone: "warn", text: `${noRate.length} line${noRate.length === 1 ? " has" : "s have"} no rate yet. Edit the TO to add it.` });
      const u = usual.get(r.billingId);
      if (u && litres > 0)
        checklist.push(
          litres >= u * 1.5
            ? { tone: "warn", text: `Quantity is ${Math.round((litres / u) * 10) / 10}× their usual order of about ${u} L. Check before verifying.` }
            : { tone: "ok", text: `Quantity is in line with their usual order of about ${u} L` },
        );
      const editedLater = r.updatedById && r.updatedById === r.takenById && new Date(r.updatedAt).getTime() - new Date(r.createdAt).getTime() > 60_000 && r.status === "open";
      return {
        id: r.id,
        toNo: r.toNo,
        status: r.status,
        party: r.billing,
        billingId: r.billingId,
        city: r.city,
        source: sourceOf(r),
        takenBy: r.taken,
        orderDate: r.orderDate,
        godown: r.godown,
        delivery: r.delivery ?? r.billing,
        transporter: r.transporter,
        remark: r.remark,
        lines,
        litres,
        value: seeMoney ? valueOf(r) : null,
        back: r.backOfficeById ? { by: r.backOffice, at: iso(r.backOfficeAt)!, note: r.backOfficeNote } : null,
        prod: r.productionById ? { by: r.production, at: iso(r.productionAt)!, note: r.productionNote } : null,
        createdAt: iso(r.createdAt)!,
        dup,
        edited: editedLater ? { by: r.updatedBy, at: iso(r.updatedAt)! } : null,
        correction: r.correctionNote ? { note: r.correctionNote, by: r.correctionBy, at: iso(r.correctionAt) } : null,
        held: r.status === "hold" ? { reason: r.holdReason ?? "", note: r.holdNote, by: r.heldBy, at: iso(r.heldAt) } : null,
        cancelReason: r.cancelReason,
        orderNo: r.orderNo,
        verifiedToday: r.status === "verified" && calendarDate(new Date(r.updatedAt)) === today,
        myCheck: r.status === "open" && next.ok ? next.check : null,
        second: next.ok ? !!(next.check === "production" ? r.backOfficeById : r.productionById) : false,
        checklist,
        actions: hubActions(r, next, dup, noRate.length > 0),
      };
    }),
  };
}

/* ============================================================== MRP board */

/**
 * THE MRP CHECK AS ITS OWN PAGE (`app/erp/mrp-check`): each approved order on
 * the left, and the chosen one's answer on the right — its finished goods
 * against the shelf and the tank, the materials a batch of its base takes by
 * its recipe (with an open PO named where one is coming), the empty cans, and
 * the capacity tick. The answer is `mrpCheck`'s, the actions `mrpActions`.
 */
export type MrpBoardOrder = {
  id: string;
  orderNo: number;
  toNo: number | null;
  party: string;
  godown: string;
  litres: number;
  dispatchOn: string | null;
  accountsAt: string | null;
  verdict: { tone: "ok" | "short" | "make"; text: string };
  held: { department: string; reason: string; note: string | null } | null;
  goods: { sku: string; need: string; onShelf: string; toMake: string; base: { tone: "ok" | "short" | "muted"; text: string } }[];
  materials: { name: string; need: string; stock: string; short: boolean; answer: string }[];
  batchLine: string | null;
  unknown: string[];
  actions: ActionSpec[];
};

async function openPosFor(materialIds: string[]): Promise<Map<string, string>> {
  if (!materialIds.length) return new Map();
  const rows = (await db.execute(sql`
    select distinct on (l.raw_material_id) l.raw_material_id as id, po.po_number as "poNumber", po.qm_po_no as "qmPoNo", po.delivery_date::text as due
      from erp_po_lines l join erp_purchase_orders po on po.id = l.po_id
     where l.raw_material_id in (${sql.join(materialIds.map((x) => sql`${x}`), sql`, `)}) and po.status in ('Approved', 'Sent', 'Partly received')
     order by l.raw_material_id, po.delivery_date`)) as unknown as { id: string; poNumber: number; qmPoNo: string | null; due: string }[];
  const { poName } = await import("../engines/purchase-flow");
  const { fd } = await import("../ui");
  return new Map(rows.map((r) => [r.id, `${poName({ poNumber: Number(r.poNumber), qmPoNo: r.qmPoNo })} due ${fd(r.due)}`]));
}

export async function mrpBoard(ctx: ErpContext): Promise<MrpBoardOrder[]> {
  const lines = await waitingForMrp();
  const byOrder = new Map<number, GateLine[]>();
  for (const l of lines) byOrder.set(l.orderNo, [...(byOrder.get(l.orderNo) ?? []), l]);
  const stock = await stockAt([...new Set(lines.map((l) => l.godownId))]);
  const holds = await openHolds([...byOrder.keys()]);
  const decider = ctx.powers.has("productionCheck") || ctx.administrator;
  const answers = [...byOrder].map(([no, ls]) => {
    const head = ls[0];
    const answer = mrpCheck(
      ls.map((l): MrpLine => ({ lineId: l.id, sku: l.sku, skuId: l.skuId, cans: l.qty, litresPerCan: (l.ml ?? 0) / 1000, boxed: l.boxed, cansPerBox: l.cpb, finishedGoodId: l.finishedGoodId, formulationId: l.formulationId, formulation: l.formulation, canMaterialId: l.canMaterialId, canMaterial: l.canMaterial })),
      stock.get(head.godownId)!,
    );
    return { no, ls, head, answer };
  });
  const shortIds = answers.flatMap((a) => [...a.answer.bases.flatMap((b) => b.materials), ...a.answer.cans].filter((m) => m.short > 0).map((m) => m.id));
  const pos = await openPosFor([...new Set(shortIds)]);
  const qty = (n: number, unit: string) => `${Math.round(n * 100) / 100}${unit ? ` ${unit === "Litre" ? "L" : unit === "Kg" ? "kg" : unit === "Pcs" ? "" : unit}` : ""}`.trim();
  return answers.map(({ no, ls, head, answer }) => {
    const h = holds.get(no);
    const held = ls.some((l) => l.productionCheck === "Hold") || !!h;
    const baseOf = new Map(answer.bases.map((b) => [b.formulationId, b]));
    const goods = answer.lines.map((a) => {
      const l = ls.find((x) => x.id === a.lineId)!;
      const boxed = l.boxed && l.cpb > 1 && a.cans % l.cpb === 0;
      const as = (cans: number) => (boxed && cans % l.cpb === 0 ? `${cans / l.cpb} boxes` : `${cans} cans`);
      const b = l.formulationId ? baseOf.get(l.formulationId) : undefined;
      return {
        sku: a.sku,
        need: as(a.cans),
        onShelf: as(a.onShelfCans),
        toMake: a.toMakeCans ? `${a.toMakeCans} cans · ${Math.round(a.toMakeLitres)} L` : "—",
        base: !a.toMakeCans
          ? { tone: "ok" as const, text: "Not needed" }
          : !b
            ? { tone: "muted" as const, text: "No base named" }
            : b.shortLitres > 0
              ? { tone: "short" as const, text: `${Math.round(b.inTank)} L approved` }
              : { tone: "ok" as const, text: `${Math.round(b.inTank)} L approved` },
      };
    });
    const mats = [...answer.bases.flatMap((b) => b.materials), ...answer.cans];
    const materials = mats.map((m) => ({
      name: m.name,
      need: qty(m.need, m.unit),
      stock: qty(m.stock, m.unit),
      short: m.short > 0,
      answer: m.short > 0 ? `Short ${qty(m.short, m.unit)}${pos.get(m.id) ? ` · ${pos.get(m.id)}` : ""}` : "Enough",
    }));
    const making = answer.bases.filter((b) => b.shortLitres > 0);
    const batchLine = making.length
      ? `To make ${making.map((b) => `${Math.round(b.shortLitres)} L ${b.formulation}`).join(" and ")} (recipe, ${making.map((b) => `${b.batches} batch${b.batches === 1 ? "" : "es"}${b.batchGuessed ? ", size not known" : ""}`).join("; ")})`
      : null;
    const shortMats = materials.filter((m) => m.short);
    const allShelf = answer.lines.every((a) => a.toMakeCans === 0);
    const boxesShort = answer.cans.some((c) => c.short > 0) && !answer.bases.some((b) => b.materials.some((m) => m.short > 0));
    const verdict = shortMats.length
      ? { tone: "short" as const, text: boxesShort ? "Empty cans short" : `${shortMats.length} material${shortMats.length === 1 ? "" : "s"} short` }
      : allShelf
        ? { tone: "ok" as const, text: "All in stock" }
        : { tone: "ok" as const, text: "Can be made" };
    const litres = Math.round(ls.reduce((n, l) => n + ((l.ml ?? 0) * l.qty) / 1000, 0));
    const sentence = answer.short.length ? `Short: ${answer.short.join("; ")}` : "Everything it needs is in stock now";
    return {
      id: head.id,
      orderNo: no,
      toNo: head.toNo,
      party: head.billing,
      godown: head.godown,
      litres,
      dispatchOn: head.dispatchOn,
      accountsAt: head.accountsCheckedAt ? new Date(head.accountsCheckedAt).toISOString() : null,
      verdict: held ? { tone: "short", text: "On hold" } : verdict,
      held: h ? { department: DEPARTMENT_LABEL[h.department as HoldDepartment] ?? h.department, reason: reasonLabel(h.reason), note: h.internalNote } : held ? { department: "Production", reason: "On hold", note: null } : null,
      goods,
      materials,
      batchLine,
      unknown: answer.unknown,
      actions: mrpActions(no, answer.short.length > 0, sentence, held, decider),
    };
  });
}

/* ============================================================== To Hold board */

/**
 * TO HOLD AS ITS OWN PAGE (`app/erp/to-hold`): every hold from every desk, and
 * the holds released this week, with the history the Release dialog shows —
 * the hold itself and the money confirmed for the party since. The actions are
 * `holdActions`, the list's own.
 */
export type HoldBoardRow = {
  id: string;
  kind: "to" | "order";
  number: string;
  sub: string;
  party: string;
  department: HoldDepartment;
  departmentLabel: string;
  reason: string;
  note: string | null;
  customerText: string | null;
  by: string | null;
  at: string;
  nextUpdateOn: string | null;
  releaseTo: string;
  history: { at: string; text: string; bold?: string }[];
  actions: ActionSpec[];
};

export async function holdBoard(ctx: ErpContext): Promise<{ rows: HoldBoardRow[]; releasedThisWeek: number }> {
  const [rows, released] = await Promise.all([
    allHolds(),
    db.execute(sql`
      select (select count(*)::int from erp_order_holds where kind = 'hold' and resolved_at > now() - interval '7 days')
           + (select count(*)::int from erp_order_intakes where status <> 'hold' and held_at is not null and updated_at > now() - interval '7 days' and updated_at > held_at) as n`) as unknown as Promise<{ n: number }[]>,
  ]);
  const parties = [...new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x))];
  const since = rows.length ? new Date(Math.min(...rows.map((r) => new Date(r.at).getTime()))).toISOString() : null;
  const paid = parties.length && since
    ? ((await db.execute(sql`
        select r.customer_id as "customerId", r.amount, r.mode, r.reference, r.confirmed_at as at, u.name as by
          from payment_receipts r left join users u on u.id = r.confirmed_by_id
         where r.customer_id in (${sql.join(parties.map((x) => sql`${x}`), sql`, `)}) and r.status = 'confirmed' and r.confirmed_at >= ${since}
         order by r.confirmed_at`)) as unknown as { customerId: string; amount: number; mode: string; reference: string | null; at: Date; by: string | null }[])
    : [];
  return {
    releasedThisWeek: Number(released[0]?.n ?? 0),
    rows: rows.map((r): HoldBoardRow => {
      const atIso = new Date(r.at).toISOString();
      const history: HoldBoardRow["history"] = [
        { at: atIso, bold: `Held · ${r.reason}`, text: `${r.by ? ` by ${r.by}` : ""}${r.note ? `\n${r.note}` : ""}` },
        ...paid
          .filter((p) => p.customerId === r.customerId && new Date(p.at).getTime() >= new Date(r.at).getTime())
          .map((p) => ({ at: new Date(p.at).toISOString(), text: `Payment ${money(Number(p.amount))} confirmed${p.by ? ` by ${p.by}` : ""} (${p.mode}${p.reference ? ` ${p.reference}` : ""})` })),
      ];
      return {
        id: holdRowId(r),
        kind: r.kind,
        number: r.number,
        sub: r.kind === "to" ? "No order number yet" : [r.sub, r.taker].filter(Boolean).join(" · "),
        party: r.party,
        department: r.department,
        departmentLabel: DEPARTMENT_LABEL[r.department],
        reason: r.reason,
        note: r.note,
        customerText: r.customerText,
        by: r.by,
        at: atIso,
        nextUpdateOn: r.nextUpdateOn,
        releaseTo: RELEASE_TO[r.department],
        history,
        actions: holdActions(ctx, r),
      };
    }),
  };
}
