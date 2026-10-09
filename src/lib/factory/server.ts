import "server-only";
import { cache } from "react";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { User } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { levelInApp } from "@/lib/access-control";
import { listUserApps } from "@/lib/access";
import { calendarDate } from "@/lib/business-date";
import { getConfig } from "@/lib/config/store";
import type { ErpContext } from "@/lib/erp/access";
import { erpId } from "@/lib/erp/server";
import { fgLots, packLots, rmLevelAvailable, rmLots, sfgLots } from "@/lib/erp/stock";
import { dayLine, hhmm } from "./time";
import type { Area, BoxSku, Emp, FactoryData, FgSku, Lot, Order, Proc, ReviewItem, SfgProduct, Task, Team } from "./types";
import { PROCS } from "./types";

/* ---------------------------------------------------------------------------
 * Who is on the floor, where, and what the floor looks like right now.
 *
 * `bootstrap` reshapes the ERP's own masters, lots and orders into what one
 * phone screen draws (`types.ts`). It owns no stock: every number in it is
 * read from the ERP's ledgers at the moment of asking.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;
const q = async <T = Row>(s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as T[];
const n = (v: unknown) => Number(v ?? 0) || 0;
/** `(a, b, c)` as bound parameters — never `null` for an empty list, which matches nothing either way. */
export const inList = (ids: string[]) => (ids.length ? sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql`(null)`);

/** A colour per product family, from the design's palette, stable by name. */
const PALETTE = ["#2B5CBF", "#B77B08", "#1D7A45", "#5223E0", "#B3261E", "#3D4453", "#0E7C86", "#8A5C05"];
const colourOf = (name: string) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

export type FactoryCtx = {
  user: User;
  level: "associate" | "manager" | "admin";
  /** A Production Head: manager or admin on the Factory grant, or a staff row saying so. */
  head: boolean;
  area: Area;
  roleLabel: string | null;
  godown: { id: string; name: string };
  lang: "en" | "hi" | "mr";
};

export class FactoryNotPermitted extends Error {}

/** The godown somebody works at: their ERP working location, else their first assigned one, else the first active. */
async function godownFor(userId: string): Promise<{ id: string; name: string } | null> {
  const rows = await q<{ id: string; name: string }>(sql`
    select g.id, g.name from erp_godowns g
     where g.status = 'active' and not g.reserved
     order by (g.id = (select working_godown_id from erp_user_settings where user_id = ${userId})) desc,
              exists (select 1 from erp_godown_staff s where s.godown_id = g.id and s.user_id = ${userId}) desc,
              g.name
     limit 1`);
  return rows[0] ?? null;
}

/** The signed-in person's factory context, or null when nobody is signed in or the app is not theirs. */
export const factoryContext = cache(async function factoryContext(): Promise<FactoryCtx | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  return contextFor(user);
});

export async function contextFor(user: User): Promise<FactoryCtx | null> {
  const apps = await listUserApps(user.id);
  if (!apps.includes("factory")) return null;
  const level = ((await levelInApp(user, "factory")) ?? "associate") as FactoryCtx["level"];
  const [staff] = await q<{ area: Area; role_label: string | null; lang: FactoryCtx["lang"] }>(
    sql`select area, role_label, lang from factory_staff where user_id = ${user.id}`,
  );
  const godown = await godownFor(user.id);
  if (!godown) return null;
  const head = level !== "associate" || staff?.area === "head";
  return {
    user,
    level,
    head,
    area: head ? "head" : (staff?.area ?? "mixing"),
    roleLabel: staff?.role_label ?? null,
    godown,
    lang: staff?.lang ?? "en",
  };
}

export async function requireFactory(): Promise<FactoryCtx> {
  const ctx = await factoryContext();
  if (!ctx) throw new FactoryNotPermitted("The Factory app is not on your account.");
  return ctx;
}

/**
 * The ERP context the factory posts under. The person is the author of every
 * document — `created_by_id` is them, never a system account — and the
 * godown is the one they are standing in. It carries exactly the production
 * screens the handlers belong to and no powers: the floor app can write a
 * batch, a fill or a packing line, and nothing an ERP screen would let a
 * manager do on top.
 */
export function erpCtxFor(fc: FactoryCtx): ErpContext {
  const g = { id: fc.godown.id, name: fc.godown.name, reserved: false };
  return {
    user: fc.user,
    actor: fc.user,
    viewingAs: null,
    level: "associate",
    administrator: false,
    powers: new Set(),
    screens: new Set(["sfgBatches", "fgFill", "packBatches"]),
    assignedGodowns: [g],
    workingGodown: g,
    designation: null,
    department: null,
  };
}

export const today = () => calendarDate(new Date());
export const nowHM = () => hhmm(new Date());

/** Writes one line of the job's history — the audit log is the history, there is no second copy. */
export async function factoryAudit(fc: FactoryCtx, action: string, taskId: string | null, detail: string, extra?: Record<string, unknown>) {
  await db.execute(sql`
    insert into audit_log (id, actor_id, actor_role, actor_app, action, entity_type, entity_id, after_state)
    values (${erpId("aud")}, ${fc.user.id}, ${fc.level}, 'factory', ${action}, 'factory_task', ${taskId}, ${JSON.stringify({ detail, ...(extra ?? {}) })}::jsonb)`);
}

/** T-1001, T-1002 … from the ERP's own series table, inside the caller's transaction. */
export async function nextTaskId(ex: { execute: (s: ReturnType<typeof sql>) => Promise<unknown> } = db): Promise<string> {
  const rows = (await ex.execute(sql`
    insert into erp_series (key, last) values ('factoryTask', 1001)
    on conflict (key) do update set last = erp_series.last + 1
    returning last`)) as unknown as { last: number }[];
  return "T-" + Number(rows[0].last);
}

/* ======================================================= the masters */

type Masters = Pick<FactoryData, "rm" | "sfg" | "sku" | "pm" | "box"> & {
  /** finished good id → formulation id, for naming an FG lot's base. */
  fgSfg: Record<string, string>;
};

export async function masters(): Promise<Masters> {
  const cfg = await getConfig();
  const tol = Number(cfg["erp.factory.mixTolerancePercent"] ?? 1.5);
  const packBatch = Number(cfg["erp.factory.packBatchBoxes"] ?? 50);

  const mats = await q<{ id: string; name: string; code: string | null; type: string | null }>(
    sql`select id, name, code, material_type as type from erp_raw_materials where active order by name`,
  );
  const rm: Masters["rm"] = {};
  const pm: Masters["pm"] = {};
  for (const m of mats) {
    if (m.type === "Can" || m.type === "Drum") pm[m.id] = m.name;
    else if (m.type !== "Box" && m.type !== "Stationary")
      rm[m.id] = { n: m.name, col: colourOf(m.name), code: (m.code || m.name.replace(/[^A-Za-z]/g, "").slice(0, 3)).toUpperCase().slice(0, 4) };
  }

  const recipe = await q<{ fid: string; fname: string; rm: string | null; qty: number | null }>(sql`
    select f.id as fid, f.name as fname, r.raw_material_id as rm, r.qty_per_batch::float8 as qty
      from product_formulations f
      left join erp_recipes r on r.formulation_id = f.id
     where f.active
     order by f.name, r.qty_per_batch desc nulls last, r.raw_material_id`);
  const sfg: Record<string, SfgProduct> = {};
  for (const r of recipe) {
    const f = (sfg[r.fid] ??= {
      n: r.fname,
      short: r.fname.split(/\s+/)[0].toUpperCase().slice(0, 5),
      col: colourOf(r.fname),
      batch: 0,
      tol,
      recipe: [],
    });
    if (r.rm && r.qty) {
      f.recipe.push([r.rm, n(r.qty)]);
      f.batch += n(r.qty);
    }
  }

  /* What each finished good fills into, size by size — the same join the
     ERP's own fill form offers (`fgCatalogue`). */
  const fills = await q<{ fg: string; fgName: string; brand: string | null; fid: string; fgMl: number; ml: number | null; canUse: string | null; canType: string | null }>(sql`
    select fg.id as fg, fg.name as "fgName", b.name as brand, fg.formulation_id as fid, fg.millilitres as "fgMl", p.millilitres_per_can as ml,
           m.id as "canUse", m.material_type as "canType"
      from finished_goods fg
      left join product_brands b on b.id = fg.brand_id
      left join products p on p.finished_good_id = fg.id and p.active
      left join erp_product_packing pk on pk.product_id = p.id
      left join erp_raw_materials m on m.id = pk.can_use_material_id
     where fg.active
     order by fg.name`);
  const sku: Record<string, FgSku> = {};
  const fgSfg: Record<string, string> = {};
  for (const r of fills) {
    fgSfg[r.fg] = r.fid;
    const litres = n(r.ml ?? r.fgMl) / 1000;
    if (!litres) continue;
    const key = r.fg + ":" + litres;
    const kind = r.canType === "Drum" || litres >= 20 ? "drum" : "can";
    const size = litres < 1 ? Math.round(litres * 1000) + " ml" : litres + " L";
    const prev = sku[key];
    if (prev && prev.pm) continue;
    sku[key] = {
      /* The brand is the name on the can; the finished good's own name
         repeats the size the tile already shows. */
      n: r.brand ?? r.fgName,
      size,
      tag: size.replace(" ", ""),
      l: litres,
      kind,
      sfg: r.fid,
      pm: r.canUse ?? prev?.pm ?? "",
      col: sfg[r.fid]?.col ?? colourOf(r.fgName),
    };
  }

  const boxed = await q<{ id: string; fg: string; ml: number; cpb: number; boxType: string | null }>(sql`
    select p.id, p.finished_good_id as fg, p.millilitres_per_can as ml, p.cans_per_box as cpb, pk.box_type as "boxType"
      from products p join erp_product_packing pk on pk.product_id = p.id
     where p.active and pk.empty_boxes_required > 0 and p.finished_good_id is not null`);
  const box: Record<string, BoxSku> = {};
  for (const b of boxed) {
    const key = b.fg + ":" + n(b.ml) / 1000;
    if (!sku[key]) continue;
    box[b.id] = { sku: key, cpb: n(b.cpb), batch: packBatch, type: b.boxType ?? "Carton" };
  }
  return { rm, sfg, sku, pm, box, fgSfg };
}

/* ======================================================= the lots */

export async function lotsFor(godown: { id: string; name: string }, m: Masters): Promise<Record<string, Lot>> {
  const lots: Record<string, Lot> = {};
  const [rms, sfgs, fgs, packs, levelAvail, qc, sizes, open] = await Promise.all([
    rmLots(),
    sfgLots(),
    fgLots(),
    packLots(),
    rmLevelAvailable(),
    q<{ lot: string; status: string }>(sql`select lot_code as lot, status from erp_sfg_qc`),
    q<{ lot: string; fg: string; size: number }>(sql`select distinct on (lot_code) lot_code as lot, finished_good_id as fg, can_size::float8 as size from erp_fg_fills order by lot_code, created_at`),
    openPackBatches(godown.id),
  ]);
  const qcOf = new Map(qc.map((r) => [r.lot, r.status]));
  const sizeOf = new Map(sizes.map((r) => [r.lot, r.fg + ":" + n(r.size)]));

  for (const l of rms) {
    const here = l.godownId === godown.id;
    if (!here && l.stock <= 0) continue;
    const isPm = !!m.pm[l.rawMaterialId];
    if (!isPm && !m.rm[l.rawMaterialId]) continue;
    const prev = lots[l.lotNo];
    if (prev && prev.loc === godown.name) continue;
    lots[l.lotNo] = {
      code: l.lotNo,
      type: isPm ? "pm" : "rm",
      item: l.rawMaterialId,
      /* Cans are counted by the item's level at the godown, not lot by lot —
         that is the number the ERP's fill refuses on. */
      avail: isPm ? Math.max(0, levelAvail(l.materialType, l.rawMaterialId, l.godownId)) : Math.max(0, l.stock),
      loc: l.godown,
      status: l.stock <= 0 ? "used" : "ok",
    };
  }
  for (const l of sfgs) {
    if (l.godownId !== godown.id && l.stock <= 0) continue;
    if (lots[l.lotCode]?.loc === godown.name) continue;
    const verdict = qcOf.get(l.lotCode) ?? "Pending";
    lots[l.lotCode] = {
      code: l.lotCode,
      type: "sfg",
      item: l.formulationId,
      avail: Math.max(0, l.stock),
      loc: l.godown,
      /* Not filled until quality approves it — the ERP refuses the fill, so the
         phone says "do not use this yet" at the scan instead of at the end. */
      status: l.stock <= 0 ? "used" : verdict === "Approved" ? "ok" : "hold",
    };
  }
  for (const l of fgs) {
    if (l.godownId !== godown.id && l.stock <= 0) continue;
    const item = sizeOf.get(l.lotCode);
    if (!item) continue;
    if (lots[l.lotCode]?.loc === godown.name) continue;
    lots[l.lotCode] = { code: l.lotCode, type: "fg", item, avail: Math.max(0, l.stock), loc: l.godown, status: l.stock <= 0 ? "used" : "ok" };
  }
  for (const l of packs) {
    if (!m.box[l.skuId]) continue;
    if (l.godownId !== godown.id && l.stock <= 0) continue;
    lots[l.batchNo] = { code: l.batchNo, type: "pb", item: l.skuId, avail: Math.max(0, l.stock), loc: l.godown, status: "ok" };
  }
  for (const b of open) {
    if (!m.box[b.skuId]) continue;
    lots[b.batchNo] = { code: b.batchNo, type: "pb", item: b.skuId, avail: Math.floor(b.cans / Math.max(1, b.cpb)), loc: godown.name, status: "incomplete" };
  }
  return lots;
}

export type OpenBatch = { batchNo: string; serial: number; skuId: string; boxes: number; cpb: number; cans: number };

/** Packing batches at this godown whose lines do not yet draw all their cans — not stock until they do. */
export async function openPackBatches(godownId: string): Promise<OpenBatch[]> {
  const rows = await q<{ batchNo: string; serial: number; skuId: string; boxes: number; cpb: number; cans: number }>(sql`
    select l.batch_no as "batchNo", min(l.batch_serial) as serial, min(l.sku_id) as "skuId", max(l.boxes) as boxes,
           max(p.cans_per_box) as cpb, sum(l.cans)::float8 as cans
      from erp_pack_lines l join products p on p.id = l.sku_id
     where l.godown_id = ${godownId}
     group by l.batch_no
    having sum(l.cans) < max(l.boxes) * max(p.cans_per_box)`);
  return rows.map((r) => ({ ...r, serial: n(r.serial), boxes: n(r.boxes), cpb: n(r.cpb), cans: n(r.cans) }));
}

/* ======================================================= the orders */

export const orderKey = (no: number | string) => "SO-" + no;
export const orderNoOf = (key: string) => key.replace(/^SO-/, "");

export async function ordersFor(godown: { id: string; name: string }, m: Masters, lots: Record<string, Lot>): Promise<Record<string, Order>> {
  const rows = await q<{
    id: string; no: number; status: string; skuId: string; qty: number; name: string; cpb: number; fg: string | null; ml: number | null;
    boxed: boolean; cust: string | null; city: string | null; transporter: string | null; verification: string | null;
  }>(sql`
    select o.id, o.order_no as no, o.status, o.sku_id as "skuId", o.qty_cans as qty, p.name, p.cans_per_box as cpb,
           p.finished_good_id as fg, p.millilitres_per_can as ml,
           coalesce(pk.empty_boxes_required, 0) > 0 as boxed,
           c.name as cust, c.city, o.transporter, od.verification
      from erp_orders o
      join products p on p.id = o.sku_id
      left join erp_product_packing pk on pk.product_id = p.id
      left join customers c on c.id = coalesce(o.delivery_customer_id, o.billing_customer_id)
      left join erp_order_details od on od.order_id = o.id
     where o.godown_id = ${godown.id}
       and o.status <> 'Cancel'
       and coalesce(od.verification, '') <> 'Verified'
       and (o.dispatch_on is null or o.dispatch_on <= ${today()}::date + 1)
     order by o.order_no`);
  if (!rows.length) return {};
  const ids = rows.map((r) => r.id);
  const alloc = await q<{ orderId: string; lot: string; lotFrom: string; qty: number }>(sql`
    select order_id as "orderId", lot_code as lot, lot_from as "lotFrom", quantity::float8 as qty
      from erp_batch_codes where order_id in ${inList(ids)}`);
  const out: Record<string, Order> = {};
  for (const r of rows) {
    const key = orderKey(r.no);
    const o = (out[key] ??= { cust: r.cust ?? "—", city: r.city ?? "—", vehicle: "—", trans: r.transporter ?? "—", lines: [] });
    const skuKey = r.fg ? r.fg + ":" + n(r.ml) / 1000 : r.skuId;
    const fgSku = m.sku[skuKey];
    const unit = r.boxed ? "boxes" : fgSku?.kind === "drum" ? "drums" : "cans";
    const qty = r.boxed ? Math.round(n(r.qty) / Math.max(1, n(r.cpb))) : n(r.qty);
    const mine = alloc.filter((a) => a.orderId === r.id);
    o.lines.push({ sku: r.boxed ? r.skuId : skuKey, label: r.name, qty, unit, alloc: mine.map((a) => [a.lot, n(a.qty)]) });
    for (const a of mine) {
      /* Allocation takes stock off the ledger the moment it is written, so the
         lot the loaders scan may read empty in free stock: give it a lot of
         its own carrying what this order takes from it. */
      const x = lots[a.lot];
      if (!x) lots[a.lot] = { code: a.lot, type: a.lotFrom === "pack" ? "pb" : "fg", item: a.lotFrom === "pack" ? r.skuId : skuKey, avail: n(a.qty), loc: godown.name, status: "ok", order: key };
      else x.order = key;
    }
    if (r.status !== "Ready") o.blocked = "This order is not ready yet. Wait for the office.";
    else if (!mine.length || mine.reduce((a, b) => a + n(b.qty), 0) < qty) o.blocked = "The office has not given lots for this order yet. Wait for the office.";
  }
  return out;
}

/* ======================================================= the people */

const AREA_WORD: Record<string, string> = { head: "Production Head", mixing: "Mixing", filling: "Filling", packing: "Packing", dispatch: "Dispatch", qc: "Quality" };

export async function people(godownId: string): Promise<{ emp: Record<string, Emp>; hours: Record<string, number> }> {
  const rows = await q<{ id: string; name: string; phone: string | null; area: Area; roleLabel: string | null; badge: string | null; code: string | null; confirmed: boolean; empId: string | null }>(sql`
    select u.id, u.name, u.phone, s.area, s.role_label as "roleLabel", s.badge_code as badge, e.employee_code as code,
           s.hr_confirmed as confirmed, u.employee_id as "empId"
      from factory_staff s
      join users u on u.id = s.user_id and u.active
      left join employees e on e.id = u.employee_id
     order by case s.area when 'head' then 0 when 'mixing' then 1 when 'filling' then 2 when 'packing' then 3 when 'dispatch' then 4 else 5 end, u.name`);
  const emp: Record<string, Emp> = {};
  for (const r of rows) {
    emp[r.id] = {
      key: r.id,
      n: r.name,
      ph: "",
      role: AREA_WORD[r.area] + (r.roleLabel ? " · " + r.roleLabel.toLowerCase() : ""),
      area: r.area,
      id: r.code ?? "—",
      badge: r.badge ?? r.code ?? undefined,
      confirm: !r.confirmed || undefined,
    };
  }
  /* Hours on the floor today, from HRMS attendance — context beside a job
     count, never a figure anybody is paid on here. */
  const att = await q<{ id: string; checkIn: string; checkOut: string | null; stop: number }>(sql`
    select u.id, a.check_in as "checkIn", a.check_out as "checkOut", a.stoppage_min as stop
      from hrms_attendance a join users u on u.employee_id = a.employee_id
     where a.date = ${today()}::date`);
  const hours: Record<string, number> = {};
  const now = nowHM();
  const mins = (s: string) => {
    const [h, m2] = s.slice(0, 5).split(":").map(Number);
    return (h || 0) * 60 + (m2 || 0);
  };
  for (const a of att) {
    const m2 = Math.max(0, mins(a.checkOut ?? now) - mins(a.checkIn) - n(a.stop));
    hours[a.id] = Math.round((m2 / 60) * 2) / 2;
  }
  void godownId;
  return { emp, hours };
}

export async function teamDefaults(): Promise<Record<Proc, Team>> {
  const rows = await q<{ proc: Proc; role: string; userId: string }>(sql`select proc, role, user_id as "userId" from factory_team_defaults order by user_id`);
  const t = Object.fromEntries(PROCS.map((p) => [p, { owner: null, op: null, helpers: [], ver: null } as Team])) as Record<Proc, Team>;
  for (const r of rows) {
    const team = t[r.proc];
    if (r.role === "owner") team.owner = r.userId;
    else if (r.role === "operator") team.op = r.userId;
    else if (r.role === "helper") team.helpers.push(r.userId);
    else if (r.role === "verifier") team.ver = r.userId;
  }
  return t;
}

/* ======================================================= the tasks */

/**
 * Every open ERP order at this godown that is due has one loading job. Made
 * here rather than by a person because the office already decided it when it
 * allocated the lots; the unique index on the order is what keeps a second
 * bootstrap from making two.
 */
async function ensureDispatchTasks(fc: FactoryCtx, orders: Record<string, Order>, teams: Record<Proc, Team>) {
  const keys = Object.keys(orders);
  if (!keys.length) return;
  const have = await q<{ no: string }>(sql`select order_no as no from factory_tasks where proc = 'dispatch' and status <> 'cancelled'`);
  const known = new Set(have.map((h) => h.no));
  const cfg = await getConfig();
  const due = String(cfg["erp.factory.dispatchDue"] ?? "17:00");
  for (const k of keys) {
    const no = orderNoOf(k);
    if (known.has(no)) continue;
    await db.transaction(async (tx) => {
      const id = await nextTaskId(tx);
      const made = (await tx.execute(sql`
        insert into factory_tasks (id, proc, godown_id, work_date, due, status, order_no, created_by_id)
        values (${id}, 'dispatch', ${fc.godown.id}, ${today()}::date, ${due}, 'ready', ${no}, null)
        on conflict do nothing returning id`)) as unknown as { id: string }[];
      if (made.length) await writeTeam(tx, id, teams.dispatch, null);
    });
  }
}

export async function writeTeam(ex: { execute: (s: ReturnType<typeof sql>) => Promise<unknown> }, taskId: string, team: Team, byId: string | null) {
  await ex.execute(sql`delete from factory_task_members where task_id = ${taskId}`);
  const rows: [string, string][] = [];
  if (team.owner) rows.push([team.owner, "owner"]);
  if (team.op) rows.push([team.op, "operator"]);
  for (const h of team.helpers) rows.push([h, "helper"]);
  if (team.ver) rows.push([team.ver, "verifier"]);
  for (const [u, r] of rows)
    await ex.execute(sql`insert into factory_task_members (task_id, user_id, role, assigned_by_id) values (${taskId}, ${u}, ${r}, ${byId}) on conflict do nothing`);
}

export async function tasksFor(godownId: string, open: OpenBatch[]): Promise<Task[]> {
  const rows = await q<{ id: string; proc: Proc; due: string; status: string; item: string | null; batches: number | null; target: number | null; sfgLot: string | null; orderNo: string | null; out: Task["out"] | null }>(sql`
    select id, proc, due, status, item, batches, target, sfg_lot as "sfgLot", order_no as "orderNo", out
      from factory_tasks
     where godown_id = ${godownId} and status <> 'cancelled'
       and (work_date = ${today()}::date or (status = 'ready' and work_date < ${today()}::date))
     order by due, id`);
  if (!rows.length) return [];
  const members = await q<{ taskId: string; userId: string; role: string }>(sql`
    select task_id as "taskId", user_id as "userId", role from factory_task_members
     where task_id in (select id from factory_tasks where godown_id = ${godownId} and (work_date >= ${today()}::date - 7))`);
  const held = new Set(
    (await q<{ id: string }>(sql`select distinct task_id as id from factory_submissions where status = 'held' and task_id in ${inList(rows.map((r) => r.id))}`)).map((h) => h.id),
  );
  return rows.map((r) => {
    const team: Team = { owner: null, op: null, helpers: [], ver: null };
    for (const m of members.filter((x) => x.taskId === r.id)) {
      if (m.role === "owner") team.owner = m.userId;
      else if (m.role === "operator") team.op = m.userId;
      else if (m.role === "helper") team.helpers.push(m.userId);
      else team.ver = m.userId;
    }
    const t: Task = { id: r.id, proc: r.proc, due: r.due, status: r.status === "done" ? "done" : held.has(r.id) ? "held" : "ready", team };
    if (r.item) t.item = r.item;
    if (r.batches != null) t.batches = n(r.batches);
    if (r.target != null) t.target = n(r.target);
    if (r.sfgLot) t.sfg = r.sfgLot;
    if (r.orderNo) t.order = orderKey(r.orderNo);
    if (r.out) t.out = r.out;
    if (t.proc === "packing" && t.status !== "done") {
      const carry = open.find((b) => b.skuId === t.item);
      if (carry) {
        t.carry = Math.floor(carry.cans / Math.max(1, carry.cpb));
        t.carryPb = carry.batchNo;
      }
    }
    return t;
  });
}

/* ======================================================= the bootstrap */

export async function bootstrap(fc: FactoryCtx): Promise<FactoryData> {
  const cfg = await getConfig();
  const m = await masters();
  const [lots, { emp, hours }, teams, open] = await Promise.all([lotsFor(fc.godown, m), people(fc.godown.id), teamDefaults(), openPackBatches(fc.godown.id)]);
  const orders = await ordersFor(fc.godown, m, lots);
  await ensureDispatchTasks(fc, orders, teams);
  const tasks = await tasksFor(fc.godown.id, open);
  for (const t of tasks) {
    if (t.proc === "dispatch" && t.status !== "done" && t.order && orders[t.order]?.blocked) t.status = "blocked";
  }
  /* Tasks may name people who have no factory row (an admin who assigned
     work, somebody since moved out): they still need a name on the screen. */
  const named = new Set(Object.keys(emp));
  const missing = new Set<string>();
  for (const t of tasks) for (const k of [t.team.owner, t.team.op, t.team.ver, ...t.team.helpers]) if (k && !named.has(k)) missing.add(k);
  if (!named.has(fc.user.id)) missing.add(fc.user.id);
  if (missing.size) {
    const extra = await q<{ id: string; name: string }>(sql`select id, name from users where id in ${inList([...missing])}`);
    for (const u of extra) emp[u.id] = { key: u.id, n: u.name, ph: "", role: u.id === fc.user.id && fc.head ? "Production Head" : "Not on the factory list", area: u.id === fc.user.id ? fc.area : "qc", id: "—" };
  }
  if (fc.user.phone) emp[fc.user.id].ph = fc.user.phone.replace(/\D/g, "").slice(-10);

  const taskIds = tasks.map((t) => t.id);
  const [review, audit, down, dup, corr] = await Promise.all([
    q<{ id: string; kind: ReviewItem["kind"]; taskId: string; title: string; body: string; meta: string }>(sql`
      select r.id, r.kind, r.task_id as "taskId", r.title, r.body, r.meta from factory_reviews r
        join factory_tasks t on t.id = r.task_id
       where r.status = 'open' and t.godown_id = ${fc.godown.id}
       order by r.created_at desc`),
    q<{ task: string; at: string; who: string; detail: string | null }>(sql`
      select a.entity_id as task, a.at as at, coalesce(u.name, 'System') as who, a.after_state->>'detail' as detail
        from audit_log a left join users u on u.id = a.actor_id
       where a.actor_app = 'factory' and a.entity_type = 'factory_task' and a.entity_id in ${inList(taskIds)}
       order by a.at desc limit 400`),
    q<{ reason: string; min: number }>(sql`
      select reason, sum(minutes)::int as min from factory_downtime
       where godown_id = ${fc.godown.id} and recorded_at > now() - interval '7 days' group by reason`),
    q<{ c: number }>(sql`select count(*)::int as c from audit_log where actor_app = 'factory' and action = 'factory.duplicate' and at > now() - interval '7 days'`),
    q<{ c: number }>(sql`select count(*)::int as c from factory_reviews where kind = 'correction' and decision = 'approved' and decided_at > now() - interval '7 days'`),
  ]);
  const ACTS: Record<string, string[]> = {
    tolerance: ["Accept with reason", "Send for re-check"],
    manual: ["Confirm lot", "Reject — scan again"],
    correction: ["Approve correction", "Decline"],
    attribution: ["Add helper", "Mark as correct"],
    issue: ["Fix and reassign", "Close"],
    unposted: ["Put it in the ERP", "Close — not needed"],
  };
  const now = new Date();
  return {
    loc: fc.godown.name,
    locId: fc.godown.id,
    shift: String(cfg["erp.factory.shift"] ?? "Shift A · 06:00–14:00"),
    dateLine: dayLine(now),
    at: now.toISOString(),
    emp,
    teams,
    hours,
    rm: m.rm,
    sfg: m.sfg,
    sku: m.sku,
    pm: m.pm,
    box: m.box,
    orders,
    lots,
    tasks,
    review: review.map((r) => ({ id: r.id, kind: r.kind, task: r.taskId, title: r.title, text: r.body, meta: r.meta, acts: ACTS[r.kind] ?? ACTS.issue })),
    audit: audit.map((a) => ({ task: a.task, at: hhmm(new Date(String(a.at))), who: a.who, t: a.detail ?? "" })),
    down: Object.fromEntries(down.map((d) => [d.reason, n(d.min)])),
    dup: n(dup[0]?.c),
    corr: n(corr[0]?.c),
  };
}
