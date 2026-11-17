import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { erpOrders } from "@/db/schema";
import { err, fieldErr, okVoid, type Err, type Result } from "@/lib/result";
import { money, stamp } from "@/lib/format";
import { calendarDate } from "@/lib/business-date";
import type { ErpContext } from "../access";
import { erpLink } from "../registry";
import { erpAudit, text, type ScreenModule } from "../server";
import type { ActionSpec, ColSpec, ListRow, PromptSpec, RowField } from "../ui";
import { notifyUsers } from "@/lib/notify";
import { newFormIn } from "../lazy-forms";
import { cancelIntake, intakeById, releaseIntake } from "../order-hub";
import {
  ACCOUNTS_HOLD_REASONS,
  DEPARTMENT_LABEL,
  HOLD_CUSTOMER_TEXT,
  INTAKE_STATUS_LABEL,
  ORIGIN_SOURCE,
  PRODUCTION_HOLD_REASONS,
  RELEASE_TO,
  intakeEditable,
  type HoldDepartment,
  type IntakeStatus,
} from "../engines/order-hub";
import { mrpCheck, type MrpLine, type MrpStock } from "../engines/mrp";
import { closeHold, openHolds, recordHold } from "../order-tracking";
import { reasonLabel } from "../engines/order-tracking";
import { fgLots, packLots, rmLots, sfgLots } from "../stock";
import { intakeForm, orderForm, saveOrder } from "./sales";

/* ---------------------------------------------------------------------------
 * THE ORDER HUB'S SCREENS: the TOs waiting for Accounts (Order Hub; Accounts
 * decide them in the Accounts app), the approved orders waiting for the
 * Production Head's one check and those he holds (MRP check, two tabs),
 * and every hold from every desk in one list (To Hold). The rules are in
 * `engines/order-hub.ts` and `engines/mrp.ts`; the writes in `order-hub.ts`.
 * ------------------------------------------------------------------------- */

const plural = (n: number, one = "line") => `${n} ${one}${n === 1 ? "" : "s"}`;

type IntakeRow = {
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
  correctionNote: string | null;
  holdReason: string | null;
  holdNote: string | null;
  heldBy: string | null;
  heldAt: Date | null;
  cancelReason: string | null;
  declineReason: string | null;
  declinedBy: string | null;
  declinedAt: Date | null;
  duplicateState: string | null;
  duplicateOfTo: number | null;
  duplicateReason: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  orderNo: number | null;
  createdAt: Date;
  updatedAt: Date;
  lines: { sku: string; skuId: string; qty: number; rate: number | null; discount: number | null; ml: number | null }[];
};

async function intakeRows(where: ReturnType<typeof sql>): Promise<IntakeRow[]> {
  const rows = (await db.execute(sql`
    select i.id, i.to_no as "toNo", i.status, i.origin, i.order_source as "orderSource", i.order_date::text as "orderDate",
           i.billing_customer_id as "billingId", bc.name as billing, dc.name as delivery, i.godown_id as "godownId", g.name as godown,
           i.transporter, tu.name as taken, i.taken_by_id as "takenById",
           i.correction_note as "correctionNote", i.hold_reason as "holdReason", i.hold_note as "holdNote", hu.name as "heldBy", i.held_at as "heldAt",
           i.cancel_reason as "cancelReason", i.decline_reason as "declineReason", du.name as "declinedBy", i.declined_at as "declinedAt",
           i.duplicate_state as "duplicateState", di.to_no as "duplicateOfTo", i.duplicate_reason as "duplicateReason",
           (select u.name from erp_orders o join users u on u.id = o.accounts_checked_by_id where o.intake_id = i.id limit 1) as "approvedBy",
           (select max(o.accounts_checked_at) from erp_orders o where o.intake_id = i.id) as "approvedAt",
           i.order_no as "orderNo", i.created_at as "createdAt", i.updated_at as "updatedAt",
           coalesce((select json_agg(json_build_object('sku', p.name, 'skuId', l.sku_id, 'qty', l.qty_cans, 'rate', l.rate_paise, 'discount', l.discount_bp,
                    'ml', coalesce(p.millilitres_per_can, fg.millilitres)) order by l.position)
              from erp_order_intake_lines l join products p on p.id = l.sku_id left join finished_goods fg on fg.id = p.finished_good_id
             where l.intake_id = i.id), '[]'::json) as lines
      from erp_order_intakes i
      join customers bc on bc.id = i.billing_customer_id
      left join customers dc on dc.id = i.delivery_customer_id
      left join erp_godowns g on g.id = i.godown_id
      left join users tu on tu.id = i.taken_by_id
      left join users hu on hu.id = i.held_by_id
      left join users du on du.id = i.declined_by_id
      left join erp_order_intakes di on di.id = i.duplicate_of_id
     where ${where}
     order by i.created_at asc
     limit 1500
  `)) as unknown as IntakeRow[];
  return rows.map((r) => ({
    ...r,
    toNo: Number(r.toNo),
    orderNo: r.orderNo == null ? null : Number(r.orderNo),
    duplicateOfTo: r.duplicateOfTo == null ? null : Number(r.duplicateOfTo),
    lines: (r.lines ?? []).map((l) => ({ ...l, qty: Number(l.qty), rate: l.rate == null ? null : Number(l.rate), discount: l.discount == null ? null : Number(l.discount), ml: l.ml == null ? null : Number(l.ml) })),
  }));
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

/** Where the TO stands with Accounts, in the words the Accounts column draws. */
function accountsWords(r: IntakeRow): string {
  const label = INTAKE_STATUS_LABEL[r.status as IntakeStatus] ?? r.status;
  return r.status === "verified" && r.orderNo ? `${label} · Order ${r.orderNo}` : label;
}

/* ============================================================== Order Hub */

/* Accounts approve, send back, hold and decline a TO in the Accounts app
   (Accounts › Order approvals); approving makes the order number. The hub
   lists the TOs and lets whoever took one edit or cancel it. */

const HUB_COLS = (money: boolean): ColSpec[] => [
  { k: "to", l: "TO", t: "b" },
  { k: "party", l: "Party", t: "t" },
  { k: "taken", l: "Taken by", t: "t" },
  { k: "goods", l: "Goods", t: "t", w: 260 },
  ...(money ? [{ k: "value", l: "Value", t: "m" } as ColSpec] : []),
  { k: "status", l: "Accounts", t: "s" },
  { k: "waiting", l: "Waiting", t: "t" },
];

function hubModule(key: "orderHub" | "hubCorrection" | "hubDone"): ScreenModule {
  const where =
    key === "orderHub"
      ? sql`i.status = 'open'`
      : key === "hubCorrection"
        ? sql`i.status = 'correction'`
        : sql`i.status in ('verified', 'cancelled', 'declined') and i.updated_at > now() - interval '14 days'`;
  return {
    key,
    async load(ctx, scope) {
      const rows = await intakeRows(where);
      const seeMoney = ctx.powers.has("viewSalesAmounts");
      return {
        spec: {
          screen: key,
          cols: HUB_COLS(seeMoney),
          hidden: [],
          sortDefault: ["to", key === "hubDone" ? -1 : 1],
          stats: [{ l: key === "orderHub" ? "Waiting for Accounts" : key === "hubCorrection" ? "Sent back" : "Decided in 14 days" }],
          filters: ["taken", "status"],
          noDataLine: key === "orderHub" ? "Nothing waiting. A new order lands here as a TO number." : key === "hubCorrection" ? "Nothing sent back." : "Nothing decided in the last 14 days.",
          ...(key === "orderHub" ? await newFormIn(scope, async () => ({ ...(await orderForm(ctx)), screen: key })) : {}),
          ...(key === "orderHub" ? { newLabel: "New order" } : {}),
        },
        rows: rows.map((r): ListRow => {
          const live = r.status === "open" || r.status === "correction" || r.status === "hold";
          const possibleDup = live && r.duplicateState === "possible" && r.duplicateOfTo != null;
          const noRate = r.lines.some((l) => l.rate == null);
          const flags = [
            ...(r.status === "open" ? ["hubWaiting"] : []),
            ...(possibleDup ? ["hubDuplicate"] : []),
            ...(noRate && intakeEditable(r.status) ? ["hubNoRate"] : []),
            ...(!r.godownId && intakeEditable(r.status) ? ["hubNoGodown"] : []),
          ];
          const goods = `${r.lines.map((l) => `${l.sku} × ${l.qty}`).join(", ")} · ${litresOf(r)} L`;
          const actions: ActionSpec[] = [];
          if (intakeEditable(r.status)) actions.push({ id: "editTo", l: "Edit TO", loadsForm: true });
          if (live)
            actions.push({
              id: "cancel",
              l: "Cancel TO",
              prompt: { title: `Cancel TO-${r.toNo}`, sub: r.origin !== "erp" ? "The order taken on the call or the Salesman App is cancelled with it." : undefined, submit: "Cancel TO", fields: [{ k: "reason", l: "Why", t: "area", req: true, mic: true }] },
            });
          if (r.orderNo) actions.push({ id: "open", l: `Open order ${r.orderNo}`, primary: true, href: erpLink("orders", { fl: `Order ${r.orderNo}` }) });
          const fields: RowField[] = [
            { l: "Source", v: `${sourceOf(r)}${r.taken ? ` · ${r.taken}` : ""}` },
            { l: "Order date", v: r.orderDate },
            { l: "Godown", v: r.godown ?? "Not picked" },
            { l: "Delivery party", v: r.delivery ?? r.billing },
            { l: "Transporter", v: r.transporter ?? "The delivery party's" },
            { l: "Lines", v: r.lines.map((l) => `${l.sku} × ${l.qty} cans${l.rate == null ? " · no rate" : seeMoney ? ` · ${money(l.rate)}` : ""}`).join("\n") },
            ...(possibleDup ? [{ l: "Possible duplicate", v: `Possible duplicate of TO-${r.duplicateOfTo}` }] : []),
            ...(r.duplicateState === "different" && r.duplicateOfTo != null ? [{ l: "Different order", v: `Different order from TO-${r.duplicateOfTo}: ${r.duplicateReason ?? ""}` }] : []),
            ...(r.approvedAt ? [{ l: "Approved by Accounts", v: `${r.approvedBy ?? ""} · ${stamp(r.approvedAt)}` }] : []),
            ...(r.correctionNote ? [{ l: "Sent back", v: r.correctionNote }] : []),
            ...(r.status === "hold" && r.holdReason ? [{ l: "On hold", v: `${r.holdReason}${r.holdNote ? ` - ${r.holdNote}` : ""}${r.heldBy ? ` · ${r.heldBy}` : ""}` }] : []),
            ...(r.declineReason ? [{ l: "Declined", v: `${r.declineReason}${r.declinedBy ? ` · ${r.declinedBy}` : ""}${r.declinedAt ? ` · ${stamp(r.declinedAt)}` : ""}` }] : []),
            ...(r.cancelReason ? [{ l: "Cancelled", v: r.cancelReason }] : []),
          ];
          const header =
            r.status === "correction" && r.correctionNote
              ? `Sent back: ${r.correctionNote}`
              : r.status === "declined" && r.declineReason
                ? `Declined: ${r.declineReason}`
                : possibleDup
                  ? `Possible duplicate of TO-${r.duplicateOfTo}`
                  : `${accountsWords(r)} · ${plural(r.lines.length)} · ${litresOf(r)} L`;
          return {
            id: r.id,
            v: {
              to: `TO-${r.toNo}`,
              party: r.billing,
              taken: `${sourceOf(r)}${r.taken ? ` · ${r.taken}` : ""}`,
              goods: r.status === "declined" && r.declineReason ? `${goods}\nDeclined: ${r.declineReason}` : goods,
              ...(seeMoney ? { value: valueOf(r) } : {}),
              status: accountsWords(r),
              waiting: ageWords(r.createdAt),
            },
            flags,
            title: `TO-${r.toNo} · ${r.billing}`,
            header,
            fields,
            actions,
          };
        }),
      };
    },
    actions: {
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

/* ONE screen, two tabs: Pending checks (`mrpCheck`) — approved by Accounts,
   waiting for the Production Head's one check — and On hold (`mrpHold`), the
   production holds. Releasing a production hold IS the check: it clears the
   order straight to Under Process. */

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
  accountsBy: string | null;
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
           o.production_check as "productionCheck", o.accounts_checked_at as "accountsCheckedAt", au.name as "accountsBy", o.dispatch_on::text as "dispatchOn",
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
      left join users au on au.id = o.accounts_checked_by_id
     where o.status <> 'Cancel' and o.source = 'erp' and o.accounts_check = 'Approved' and o.production_check = 'Pending'
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

const isProductionHead = (ctx: ErpContext) => ctx.powers.has("productionCheck") || ctx.administrator;

/** The reason a production hold was given, in the MRP check's own words. */
const productionReason = (code: string) => PRODUCTION_HOLD_REASONS.find((r) => r.code === code)?.label ?? reasonLabel(code);

/** The MRP check's hold: the reason, staff remarks, and - only where ticked - what the customer reads. */
const TELL_CUSTOMER = "Tell the customer (shown on their tracking page)";
const holdPrompt = (no: number): PromptSpec => ({
  title: `Hold order ${no}`,
  sub: "It moves to the On hold tab. Release clears it.",
  submit: "Put on hold",
  fields: [
    { k: "reason", l: "Reason", t: "select", req: true, opts: PRODUCTION_HOLD_REASONS.map((r) => r.label) },
    { k: "note", l: "Remarks", t: "area", mic: true, hint: "Staff only. Never reaches the customer." },
    { k: "tell", l: "Customer", t: "multi", untagged: true, opts: [TELL_CUSTOMER] },
    {
      k: "customerText",
      l: "What the customer reads",
      t: "area",
      when: { k: "tell", notEmpty: true },
      fillBy: { by: ["reason"], map: Object.fromEntries(PRODUCTION_HOLD_REASONS.map((r) => [r.label, HOLD_CUSTOMER_TEXT[r.code] ?? HOLD_CUSTOMER_TEXT.other])) },
    },
  ],
});

export const mrpCheckScreen: ScreenModule = {
  key: "mrpCheck",
  async load(ctx) {
    const lines = await waitingForMrp();
    const byOrder = new Map<number, GateLine[]>();
    for (const l of lines) byOrder.set(l.orderNo, [...(byOrder.get(l.orderNo) ?? []), l]);
    const stock = await stockAt([...new Set(lines.map((l) => l.godownId))]);
    const holds = await openHolds([...byOrder.keys()]);
    const decider = isProductionHead(ctx);
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
      /* ANY open hold makes the order held here, not only the MRP check's own.
         An order held from the Office (the orders list, To Hold) kept its
         production check "Pending", so it sat on this list as waiting with a
         "Put on hold" that could only be refused — "already on hold, resolve
         that first" — and read as the button not working (2026-11-17,
         order 10254). It is shown held, and To Hold is where it is released. */
      const h = holds.get(no);
      const fields: RowField[] = [
        ...answer.lines.map((a) => ({ l: a.sku, v: `${a.cans} cans needed · ${a.onShelfCans} on the shelf · ${a.toMakeCans ? `${a.toMakeCans} cans (${a.toMakeLitres} L) to make` : "nothing to make"}${a.boxesToPack ? ` · ${a.boxesToPack} boxes to pack` : ""}` })),
        ...answer.bases.map((b) => ({
          l: `Base · ${b.formulation}`,
          v: `${b.needLitres} L needed · ${b.inTank} L approved in the tank${b.shortLitres ? ` · ${b.shortLitres} L to mix (${b.batches} batch${b.batches === 1 ? "" : "es"}${b.batchGuessed ? ", size not known" : ""})` : ""}${b.materials.length ? `\n${b.materials.map((m) => `${m.name}: ${m.need} needed, ${m.stock} in stock${m.short ? ` - short ${m.short}` : ""}`).join("\n")}` : ""}`,
        })),
        ...answer.cans.map((c) => ({ l: c.name, v: `${c.need} needed · ${c.stock} in stock${c.short ? ` - short ${c.short}` : ""}` })),
        ...(answer.unknown.length ? [{ l: "Not known", v: `${answer.unknown.join(", ")}: the product names no base, so its making cannot be checked.` }] : []),
        { l: "Capacity", v: "Your call: MahekOne does not know the floor's capacity. Confirm it when you clear." },
        ...(h ? [{ l: `On hold · ${DEPARTMENT_LABEL[h.department as HoldDepartment] ?? h.department}`, v: `${reasonLabel(h.reason)}${h.internalNote ? ` - ${h.internalNote}` : ""}` }] : []),
      ];
      const sentence = answer.short.length ? `Short: ${answer.short.join("; ")}` : "All in stock";
      rows.push({
        id: head.id,
        v: {
          order: `Order ${no}`,
          party: head.billing,
          godown: head.godown,
          goods: ls.map((l) => `${l.sku} × ${l.qty}`).join("\n"),
          answer: sentence,
          approved: head.accountsCheckedAt ? `${stamp(head.accountsCheckedAt)}${head.accountsBy ? ` · ${head.accountsBy}` : ""}` : (head.accountsBy ?? ""),
          status: h ? "On hold" : "Waiting for MRP check",
        },
        flags: [h ? "mrpHold" : "mrpPending", ...(answer.short.length ? ["mrpShort"] : [])],
        title: `Order ${no} · ${head.billing}${head.toNo ? ` · TO-${head.toNo}` : ""}`,
        header: sentence,
        fields,
        actions: h
          ? [{ id: "toHold", l: "Open in To Hold", href: erpLink("toHold"), primary: true }]
          : [
              {
                id: "clear",
                l: "Clear",
                primary: true,
                why: decider ? "" : "Only the Production Head clears an order",
                prompt: {
                  title: `Clear order ${no}`,
                  sub: answer.short.length ? `${sentence}. Clear it only if you know the material will arrive in time; that is recorded.` : "It goes to Under Process and the day's production plan.",
                  submit: "Clear",
                  fields: [
                    { k: "capacity", l: "Capacity", t: "select", req: true, opts: ["OK"], hint: "The floor can make it in time." },
                    { k: "note", l: "Note", t: "area", mic: true },
                  ],
                },
              },
              { id: "hold", l: "Hold", why: decider ? "" : "Only the Production Head holds an order here", prompt: holdPrompt(no) },
            ],
      });
    }
    return {
      spec: {
        screen: "mrpCheck",
        cols: [
          { k: "order", l: "Order", t: "b" },
          { k: "party", l: "Party", t: "t" },
          { k: "goods", l: "Goods", t: "t", w: 240 },
          { k: "answer", l: "Materials", t: "t", w: 260 },
          { k: "approved", l: "Approved", t: "t" },
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
      if (!isProductionHead(ctx)) return err("Only the Production Head clears an order.", "not_permitted");
      const capacity = text(v.capacity);
      if (capacity !== "OK" && capacity !== "Yes") return fieldErr("capacity", "Confirm the floor can make it");
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
      if (!isProductionHead(ctx)) return err("Only the Production Head holds an order here.", "not_permitted");
      const reason = PRODUCTION_HOLD_REASONS.find((r) => r.label === text(v.reason));
      if (!reason) return fieldErr("reason", "Pick the reason");
      const [l] = await db.select({ no: erpOrders.orderNo }).from(erpOrders).where(eq(erpOrders.id, id));
      if (!l) return err("That order no longer exists.", "not_found");
      const tell = !!text(v.tell);
      return holdOrder(ctx.user.id, l.no, "production", reason.code, text(v.note), tell ? text(v.customerText) : null, ctx, { customerVisible: tell });
    },
  },
};

/** The open production holds, one row per order, for the On hold tab and its badge. */
async function productionHolds(): Promise<{ id: string; orderNo: number; reason: string; note: string | null; customerText: string; customerVisible: boolean; at: Date; by: string | null; party: string | null; goods: string | null; lineId: string | null }[]> {
  const rows = (await db.execute(sql`
    select h.id, h.order_no as "orderNo", h.reason, h.internal_note as note, h.customer_text as "customerText", h.customer_visible as "customerVisible",
           h.raised_at as at, u.name as by,
           (select c.name from erp_orders o join customers c on c.id = o.billing_customer_id where o.order_no = h.order_no limit 1) as party,
           (select string_agg(p.name || ' × ' || o.qty_cans, E'\n' order by o.created_at) from erp_orders o join products p on p.id = o.sku_id
             where o.order_no = h.order_no and o.status <> 'Cancel') as goods,
           (select o.id from erp_orders o where o.order_no = h.order_no order by o.created_at limit 1) as "lineId"
      from erp_order_holds h left join users u on u.id = h.raised_by_id
     where h.resolved_at is null and h.kind = 'hold' and h.department = 'production'
     order by h.raised_at
  `)) as unknown as { id: string; orderNo: number; reason: string; note: string | null; customerText: string; customerVisible: boolean; at: Date; by: string | null; party: string | null; goods: string | null; lineId: string | null }[];
  return rows.map((r) => ({ ...r, orderNo: Number(r.orderNo) }));
}

export const mrpHoldScreen: ScreenModule = {
  key: "mrpHold",
  async load(ctx) {
    const holds = await productionHolds();
    const decider = isProductionHead(ctx);
    return {
      spec: {
        screen: "mrpHold",
        cols: [
          { k: "order", l: "Order", t: "b" },
          { k: "party", l: "Party", t: "t" },
          { k: "goods", l: "Goods", t: "t", w: 240 },
          { k: "reason", l: "Reason", t: "s" },
          { k: "note", l: "Remarks", t: "t", w: 220 },
          { k: "held", l: "Held", t: "t" },
        ],
        hidden: [],
        stats: [{ l: "On hold" }],
        filters: ["reason"],
        noDataLine: "Nothing on hold. Release clears an order: it goes straight to Under Process, and the person who took it is told.",
      },
      rows: holds.map(
        (h): ListRow => ({
          id: h.id,
          v: { order: `Order ${h.orderNo}`, party: h.party ?? "", goods: h.goods ?? "", reason: productionReason(h.reason), note: h.note, held: `${stamp(new Date(h.at))} · ${ageWords(new Date(h.at))}` },
          flags: h.customerVisible ? [] : ["mrpInternal"],
          title: `Order ${h.orderNo} · ${h.party ?? ""}`,
          header: productionReason(h.reason),
          fields: [
            { l: "Held by", v: `${h.by ?? "-"} · ${stamp(new Date(h.at))}` },
            ...(h.note ? [{ l: "Remarks", v: h.note }] : []),
            { l: "The customer reads", v: h.customerVisible ? h.customerText : "Internal - not shown to the customer" },
          ],
          actions: [
            {
              id: "release",
              l: "Release",
              primary: true,
              why: decider ? "" : "The Production Head releases it",
              prompt: { title: `Release order ${h.orderNo}`, sub: "Release clears it: it goes straight to Under Process, and the person who took it is told.", submit: "Release", fields: [{ k: "resolution", l: "Note", t: "area", mic: true }] },
            },
            ...(h.lineId ? [{ id: "open", l: `Open order ${h.orderNo}`, href: erpLink("orders", { fl: `Order ${h.orderNo}` }) }] : []),
          ],
        }),
      ),
    };
  },
  actions: {
    async release(ctx, id, v) {
      if (!isProductionHead(ctx)) return err("The Production Head releases it.", "not_permitted");
      const [h] = (await db.execute(sql`select order_no as "orderNo" from erp_order_holds where id = ${id} and department = 'production'`)) as unknown as { orderNo: number }[];
      if (!h) return err("That hold is gone.", "not_found");
      const resolution = text(v.resolution);
      const res = await releaseOrderHold(ctx.user.id, Number(h.orderNo), "production", resolution);
      if (res.ok) await erpAudit(ctx, "erp.order.deskRelease", "erp_order", String(h.orderNo), null, { department: "production", resolution });
      return res;
    },
  },
};

/** Who took the order, to be told what the MRP check did with it: the order's author, or the TO's taker. */
async function tellTaker(orderNo: number, byUserId: string, title: string, body: string): Promise<void> {
  const [t] = (await db.execute(sql`
    select coalesce(i.taken_by_id, o.created_by_id) as "userId", i.origin
      from erp_orders o left join erp_order_intakes i on i.id = o.intake_id
     where o.order_no = ${orderNo} order by o.created_at limit 1
  `)) as unknown as { userId: string | null; origin: string | null }[];
  if (!t?.userId || t.userId === byUserId) return;
  const where = t.origin === "mbos" ? { mbosHref: "/orders" } : { href: t.origin === "crm" ? "/crm/my-orders" : erpLink("orders", { fl: `Order ${orderNo}` }) };
  await notifyUsers([{ userId: t.userId, title, body, kind: "info", ...where }]).catch(() => undefined);
}

/**
 * HOLDS AN ORDER AT A DESK (Accounts or the MRP check): one `erp_order_holds`
 * row with its department, and the lines' own check moved to Hold so the
 * order leaves that desk's queue. The lines' status is not touched — they were
 * never in production. The customer is not messaged: an order is confirmed to
 * them only once Accounts approve it. `customerVisible: false` keeps the hold
 * off the customer's tracking page altogether (an internal hold).
 */
export async function holdOrder(
  userId: string,
  orderNo: number,
  department: "accounts" | "production",
  reason: string,
  note: string | null,
  customerText: string | null,
  ctx?: ErpContext,
  opts: { customerVisible?: boolean } = {},
): Promise<Result<unknown>> {
  const sentence = customerText?.trim() || HOLD_CUSTOMER_TEXT[reason] || HOLD_CUSTOMER_TEXT.other;
  const customerVisible = opts.customerVisible ?? true;
  const column = department === "accounts" ? erpOrders.accountsCheck : erpOrders.productionCheck;
  try {
    await db.transaction(async (tx) => {
      const moved = await tx
        .update(erpOrders)
        .set(department === "accounts" ? { accountsCheck: "Hold", updatedAt: new Date(), updatedById: userId } : { productionCheck: "Hold", updatedAt: new Date(), updatedById: userId })
        .where(and(eq(erpOrders.orderNo, orderNo), eq(column, "Pending"), sql`${erpOrders.status} <> 'Cancel'`))
        .returning({ id: erpOrders.id });
      if (!moved.length) throw new Stop(err(`Order ${orderNo} is not waiting at ${department === "accounts" ? "Accounts" : "the MRP check"}.`, "conflict"));
      const r = await recordHold({ user: { id: userId } } as unknown as Pick<ErpContext, "user">, orderNo, { kind: "hold", reason, customerText: sentence, internalNote: note, department, customerVisible }, tx as unknown as typeof db);
      if (!r.ok) throw new Stop(r);
    });
  } catch (e) {
    if (e instanceof Stop) return e.result;
    throw e;
  }
  if (ctx) await erpAudit(ctx, "erp.order.deskHold", "erp_order", String(orderNo), null, { department, reason, note, customerVisible });
  const { syncBookOrders } = await import("../book");
  await syncBookOrders([orderNo]);
  if (department === "production")
    await tellTaker(orderNo, userId, `Order ${orderNo} on hold · MRP check`, `${productionReason(reason)}${note ? ` - ${note}` : ""}. It goes to Under Process once the Production Head releases it.`);
  return okVoid(`Order ${orderNo} is on hold · ${DEPARTMENT_LABEL[department]}`);
}

/**
 * Releases a desk's hold. An Accounts hold goes back to Accounts › Order
 * approvals; a production hold is the MRP check's own answer, so releasing it
 * CLEARS the check (by the releaser) and the order goes straight to Under
 * Process with no second check. The person who took the order is told.
 */
export async function releaseOrderHold(userId: string, orderNo: number, department: "accounts" | "production", resolution: string | null): Promise<Result<unknown>> {
  const h = (await openHolds([orderNo])).get(orderNo);
  if (!h || h.department !== department) return err(`Order ${orderNo} is not on hold with ${DEPARTMENT_LABEL[department]}.`, "rule_violation");
  let closed = false;
  await db.transaction(async (tx) => {
    const c = await closeHold(userId, h.id, resolution, tx as unknown as typeof db);
    if (!c.ok) return;
    closed = true;
    const now = new Date();
    await tx
      .update(erpOrders)
      .set(
        department === "accounts"
          ? { accountsCheck: "Pending", updatedAt: now, updatedById: userId }
          : { productionCheck: "Cleared", productionCheckedById: userId, productionCheckedAt: now, productionNote: resolution, updatedAt: now, updatedById: userId },
      )
      .where(and(eq(erpOrders.orderNo, orderNo), eq(department === "accounts" ? erpOrders.accountsCheck : erpOrders.productionCheck, "Hold")));
  });
  if (!closed) return err(`The hold on order ${orderNo} is already resolved.`, "conflict");
  const { syncBookOrders } = await import("../book");
  await syncBookOrders([orderNo]);
  if (department === "production") {
    await tellTaker(orderNo, userId, `Order ${orderNo} released · Under Process`, `The Production Head released the hold${resolution ? `: ${resolution}` : ""}. It is in Under Process.`);
    return okVoid(`Order ${orderNo} released and cleared · it is in Under Process`);
  }
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
  /** False for an internal hold, which the customer never sees. */
  customerVisible: boolean;
  by: string | null;
  at: Date;
  orderNo: number | null;
  lineId: string | null;
  intakeId: string | null;
};

async function allHolds(): Promise<HoldRow[]> {
  const tos = await intakeRows(sql`i.status = 'hold'`);
  const holds = (await db.execute(sql`
    select h.id, h.order_no as "orderNo", h.department, h.reason, h.internal_note as note, h.customer_text as "customerText", h.customer_visible as "customerVisible", h.raised_at as at, u.name as by,
           (select o.id from erp_orders o where o.order_no = h.order_no order by o.created_at limit 1) as "lineId",
           (select c.name from erp_orders o join customers c on c.id = o.billing_customer_id where o.order_no = h.order_no limit 1) as party,
           (select i.to_no from erp_order_intakes i where i.order_no = h.order_no) as "toNo"
      from erp_order_holds h left join users u on u.id = h.raised_by_id
     where h.resolved_at is null and h.kind = 'hold'
     order by h.raised_at
  `)) as unknown as { id: string; orderNo: number; department: string; reason: string; note: string | null; customerText: string; customerVisible: boolean; at: Date; by: string | null; lineId: string | null; party: string | null; toNo: number | null }[];
  return [
    ...tos.map(
      (t): HoldRow => ({ key: `to:${t.id}`, kind: "to", number: `TO-${t.toNo}`, sub: "No order number yet", party: t.billing, department: "verification", reason: t.holdReason ?? "", note: t.holdNote, customerText: null, customerVisible: true, by: t.heldBy, at: t.heldAt ?? t.updatedAt, orderNo: null, lineId: null, intakeId: t.id }),
    ),
    ...holds.map(
      (h): HoldRow => ({
        key: `hold:${h.id}`,
        kind: "order",
        number: `Order ${h.orderNo}`,
        sub: h.toNo ? `TO-${h.toNo}` : "",
        party: h.party ?? "",
        department: (h.department as HoldDepartment) ?? "office",
        reason: h.department === "production" ? productionReason(h.reason) : reasonLabel(h.reason),
        note: h.note,
        customerText: h.customerText,
        customerVisible: h.customerVisible !== false,
        by: h.by,
        at: h.at,
        orderNo: Number(h.orderNo),
        lineId: h.lineId,
        intakeId: null,
      }),
    ),
  ];
}

function mayRelease(ctx: ErpContext, d: HoldDepartment): string {
  if (ctx.administrator) return "";
  if (d === "verification") return ctx.powers.has("verifyOrders") || ctx.powers.has("productionCheck") ? "" : "Accounts release it, from Order approvals";
  if (d === "production") return ctx.powers.has("productionCheck") ? "" : "The Production Head releases it";
  if (d === "accounts") return "Accounts release it, from Order approvals";
  return "";
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
          { l: "TOs with Accounts", where: { k: "department", in: [DEPARTMENT_LABEL.verification] } },
          { l: "Accounts", where: { k: "department", in: [DEPARTMENT_LABEL.accounts] } },
          { l: "Production", where: { k: "department", in: [DEPARTMENT_LABEL.production] } },
        ],
        filters: ["department"],
        noDataLine: "Nothing on hold. A hold from any desk lands here.",
      },
      rows: rows.map((r): ListRow => {
        const why = mayRelease(ctx, r.department);
        const releaseId = r.kind === "to" ? "releaseTo" : r.department === "office" ? "releaseOffice" : "releaseDesk";
        return {
          id: r.kind === "to" ? r.intakeId! : `${r.department}:${r.orderNo}:${r.lineId ?? ""}`,
          v: { number: r.sub ? `${r.number} · ${r.sub}` : r.number, party: r.party, department: DEPARTMENT_LABEL[r.department], reason: r.reason, note: r.note, by: r.by, at: calendarDate(new Date(r.at)) },
          flags: r.customerVisible ? [] : ["mrpInternal"],
          title: `${r.number} · ${r.party}`,
          header: `${DEPARTMENT_LABEL[r.department]} · ${r.reason}`,
          fields: [
            { l: "Held by", v: `${r.by ?? "—"} · ${stamp(new Date(r.at))}` },
            ...(r.note ? [{ l: "Remarks", v: r.note }] : []),
            ...(r.customerText ? [{ l: "The customer reads", v: r.customerVisible ? r.customerText : "Internal - not shown to the customer" }] : []),
            { l: "Releasing sends it", v: RELEASE_TO[r.department] },
          ],
          actions: [
            {
              id: releaseId,
              l: "Release",
              primary: true,
              why,
              prompt: { title: `Release ${r.number}`, sub: `It goes ${RELEASE_TO[r.department]}.`, submit: "Release", fields: [{ k: "resolution", l: "What changed", t: "area", req: r.department === "accounts" || r.department === "office", mic: true }] },
            },
            ...(r.kind === "to" ? [{ id: "open", l: "Open the Order Hub", href: erpLink("orderHub") }] : r.orderNo ? [{ id: "open", l: `Open order ${r.orderNo}`, href: erpLink("orders", { fl: `Order ${r.orderNo}` }) }] : []),
          ],
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
      if (!resolution && department === "accounts") return fieldErr("resolution", "Say what changed");
      const res = await releaseOrderHold(ctx.user.id, Number(no), department, resolution);
      if (res.ok) await erpAudit(ctx, "erp.order.deskRelease", "erp_order", no, null, { department, resolution });
      return res;
    },
    async releaseOffice(ctx, id, v) {
      const [, , lineId] = id.split(":");
      if (!lineId) return err("That order has no lines.", "not_found");
      const { SALES_SCREENS } = await import("./sales");
      const orders = SALES_SCREENS.find((m) => m.key === "pendingOrders");
      const handler = orders?.actions?.resolveHold;
      if (!handler) return err("The release could not be run.", "conflict");
      return handler(ctx, lineId, { resolution: text(v.resolution) ?? "", notify: "" });
    },
  },
};

/** Rolls a transaction back carrying the answer to give. */
class Stop extends Error {
  constructor(public result: Err) {
    super("stop");
  }
}

/**
 * The sidebar's badges for the hub's screens, read by `erpNavCounts`. Each is
 * the count its own list draws: TOs waiting for Accounts, TOs sent back,
 * orders waiting at the MRP check (not held), the MRP check's own holds,
 * and everything on To Hold.
 */
export async function orderHubCounts(): Promise<{ orderHub: number; hubCorrection: number; mrpCheck: number; mrpHold: number; toHold: number }> {
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
    mrpHold: holds.filter((h) => h.kind === "order" && h.department === "production").length,
    toHold: holds.length,
  };
}

export const ORDER_HUB_SCREENS: ScreenModule[] = [hubModule("orderHub"), hubModule("hubCorrection"), hubModule("hubDone"), mrpCheckScreen, mrpHoldScreen, toHoldScreen];

/* The Accounts app's hold dialog offers these. */
export { ACCOUNTS_HOLD_REASONS };
