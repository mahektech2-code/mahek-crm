import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { decideOverride, loadingLines, lotInfo, requestOverride, scanOntoOrder, unitInfo, unscanUnit, type LoadingLine } from "@/lib/erp/dispatch";
import { looksLikeUnitId, normaliseCode } from "@/lib/erp/engines/trace";
import { stickerInfo, stickerPlaces, stickeredLines, type StickerInfo } from "@/lib/erp/dispatch-stickers";
import { lorryKeyOf, lorryLeft, lorryName, stickerCode } from "./rules";
import { bootstrap, erpCtxFor, factoryAudit, inList, nextTaskId, nowHM, teamDefaults, today, writeTeam, type FactoryCtx } from "./server";
import type { Lorry, LorryBoard, LorryFind, LorryHalf, LorryItem, LorryScan, LorryStickers, Team } from "./types";

/* ---------------------------------------------------------------------------
 * LOADING IS BY TRANSPORTER, ITEM BY ITEM.
 *
 * A lorry is every Ready line at this godown, not yet dispatch-verified,
 * whatever its day, whose transporter folds to one name — the ERP Dispatch
 * desk's own queue, read line by line (`loadingLines`). The loader picks the
 * transport once, on Home, and scans what goes on; this file picks the ORDER
 * each scan goes onto, and the desk's `scanOntoOrder` judges it there and
 * writes it — the same lock, the same verdict, the same scan row, so a box
 * loaded from the phone is a box counted at the desk.
 *
 * Which order: one whose allocated lot the box is from, then the soonest due,
 * then the lowest order number. Taking the soonest first would swap lots the
 * office had already given. An approved override names its own line and wins.
 *
 * A lot label (stock with no box ids, and loose cans) fills orders soonest due
 * first until the lot runs out, one `scanOntoOrder` per order.
 *
 * A loading job is made at the FIRST SCAN, not when a transport is opened:
 * looking starts nothing, and "Suresh is loading" must mean somebody is.
 *
 * AN ORDER WHOSE DISPATCH STICKERS CARRY IDS LOADS BY BOX AND STICKER. The box
 * label says what is in the box and which lot; the dispatch sticker says which
 * order and which piece of it. Scanned in either order, the first is held on
 * the phone as a `LorryHalf` and sent back with the second, and only the pair
 * is judged and written — the box against the sticker's own line, the sticker
 * claimed in the same transaction. An order printed before stickers had ids
 * has none, and its boxes load alone as they always did.
 * ------------------------------------------------------------------------- */

const NOT_YOURS = { title: "Not your work", text: "Loading is the dispatch team's.", fix: "Ask the Production Head." };

function ctxFor(fc: FactoryCtx) {
  const c = erpCtxFor(fc);
  return { ...c, screens: new Set([...c.screens, "dispatch", "transport"]) };
}

const unitWord = (boxed: boolean) => (boxed ? "boxes" : "cans");
/** What a line has on the lorry: boxes scanned, or — for stock with no box ids — what its lot labels allocated. */
const loadedOf = (l: LoadingLine) => (l.unitsExist ? l.scanned : Math.min(l.target, l.allocated));
const dueOrder = (a: LoadingLine, b: LoadingLine) => (a.dispatchOn ?? "9999") < (b.dispatchOn ?? "9999") ? -1 : (a.dispatchOn ?? "9999") > (b.dispatchOn ?? "9999") ? 1 : a.orderNo - b.orderNo;

type OpenJob = { id: string; item: string; owner: string | null; done: boolean };

/** Lorry jobs running now, and those sent today — a fully loaded lorry the office has not verified yet is waiting on them, not on a loader. */
async function openJobs(godownId: string): Promise<OpenJob[]> {
  return (await db.execute(sql`
    select t.id, t.item, t.status = 'done' as done,
           (select m.user_id from factory_task_members m where m.task_id = t.id and m.role = 'owner' limit 1) as owner
      from factory_tasks t
     where t.godown_id = ${godownId} and t.proc = 'dispatch' and t.order_no is null and t.item like 'L:%'
       and (t.status = 'ready' or (t.status = 'done' and t.work_date = ${today()}::date))
     order by t.created_at`)) as unknown as OpenJob[];
}

/** The lorries waiting at a godown, from the desk's lines. */
export function lorriesOf(lines: LoadingLine[], jobs: OpenJob[], todayIso: string): Record<string, Lorry> {
  const out: Record<string, Lorry> = {};
  const groups = new Map<string, LoadingLine[]>();
  for (const l of lines) {
    const k = lorryKeyOf(l.transporter);
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  for (const [key, ls] of groups) {
    const items = new Map<string, LorryItem & { _due: string }>();
    for (const l of [...ls].sort(dueOrder)) {
      const late = !!l.dispatchOn && l.dispatchOn < todayIso;
      const it = items.get(l.skuId) ?? { sku: l.skuId, label: l.skuName, unit: unitWord(l.boxed), target: 0, loaded: 0, orders: 0, late: false, notBilled: false, byLot: true, _due: l.dispatchOn ?? "9999" };
      it.target += l.target;
      it.loaded += loadedOf(l);
      it.orders += 1;
      it.late ||= late;
      it.notBilled ||= !l.billed;
      it.byLot &&= !l.unitsExist && l.scanned === 0;
      items.set(l.skuId, it);
    }
    /* The name as somebody typed it: the commonest spelling of the fold. */
    const spell = new Map<string, number>();
    for (const l of ls) if (l.transporter?.trim()) spell.set(l.transporter.trim(), (spell.get(l.transporter.trim()) ?? 0) + 1);
    const name = [...spell].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const list = [...items.values()].sort((a, b) => (a._due < b._due ? -1 : a._due > b._due ? 1 : a.label.localeCompare(b.label))).map(({ _due, ...i }) => (void _due, i));
    const job = jobs.find((j) => j.item === key && !j.done);
    const loaded = list.reduce((a, i) => a + Math.min(i.loaded, i.target), 0);
    const target = list.reduce((a, i) => a + i.target, 0);
    out[key] = {
      key,
      name,
      items: list,
      target,
      loaded,
      orders: new Set(ls.map((l) => l.orderNo)).size,
      late: list.filter((i) => i.late).length,
      due: ls.map((l) => l.dispatchOn).filter((d): d is string => !!d).sort()[0] ?? null,
      task: job?.id ?? null,
      loader: job?.owner ?? null,
      sent: !job && loaded >= target && jobs.some((j) => j.item === key && j.done),
    };
  }
  return out;
}

/** Every lorry at the person's godown — for the bootstrap and for the check before sending. */
export async function lorriesFor(godownId: string): Promise<Record<string, Lorry>> {
  const [lines, jobs] = await Promise.all([loadingLines(db, godownId), openJobs(godownId)]);
  return lorriesOf(lines, jobs, today());
}

async function linesOf(fc: FactoryCtx, key: string): Promise<LoadingLine[]> {
  return loadingLines(db, fc.godown.id, (t) => lorryKeyOf(t) === key);
}

async function boardOf(fc: FactoryCtx, key: string, lines?: LoadingLine[]): Promise<LorryBoard> {
  const ls = lines ?? (await linesOf(fc, key));
  const jobs = await openJobs(fc.godown.id);
  const lorry = lorriesOf(ls, jobs, today())[key] ?? null;
  const ids = ls.map((l) => l.id);
  const [boxes, overrides] = ids.length
    ? await Promise.all([
        db.execute(sql`
          select u.id, p.name as sku, u.lot_code as lot, s.id as sticker from erp_units u join products p on p.id = u.sku_id
            left join erp_dispatch_stickers s on s.unit_id = u.id and s.status = 'active'
           where u.order_id in ${inList(ids)} and u.status = 'scanned' order by u.scanned_at desc nulls last, u.id`) as unknown as Promise<{ id: string; sku: string; lot: string; sticker: string | null }[]>,
        db.execute(sql`
          select o.id, o.unit_id as unit, op.name as ordered, sp.name as scanned, o.reason, o.status, ru.name as by, o.requested_by_id as "byId",
                 du.name as "decidedBy", o.decision_note as note
            from erp_dispatch_overrides o
            join products op on op.id = o.ordered_sku_id join products sp on sp.id = o.scanned_sku_id
            left join users ru on ru.id = o.requested_by_id left join users du on du.id = o.decided_by_id
           where o.order_id in ${inList(ids)} and (o.status in ('Pending', 'Approved') or o.decided_at > now() - interval '1 day')
           order by o.requested_at desc`) as unknown as Promise<{ id: string; unit: string; ordered: string; scanned: string; reason: string; status: string; by: string | null; byId: string | null; decidedBy: string | null; note: string | null }[]>,
      ])
    : [[], []];
  const c = ctxFor(fc);
  return {
    lorry,
    boxes,
    overrides: overrides.map(({ byId, ...o }) => ({ ...o, mine: byId === fc.user.id })),
    canDecide: c.administrator || c.powers.has("dispatchOverride"),
    stickers: await stickerCounts(ls),
  };
}

/** Per order on the lorry with stickers: how many are on, and the numbers still off. */
async function stickerCounts(ls: LoadingLine[]): Promise<LorryStickers[]> {
  const nos = [...new Set(ls.map((l) => l.orderNo))];
  const places = await stickerPlaces(db, nos);
  if (!places.length) return [];
  const withIds = [...new Set(places.map((p) => p.orderNo))];
  const parties = (await db.execute(sql`
    select distinct on (o.order_no) o.order_no as no, coalesce(dc.name, bc.name) as party
      from erp_orders o join customers bc on bc.id = o.billing_customer_id left join customers dc on dc.id = o.delivery_customer_id
     where o.order_no in ${withIds}
     order by o.order_no, o.created_at`)) as unknown as { no: number; party: string }[];
  return withIds.map((no) => {
    const mine = places.filter((p) => p.orderNo === no);
    return {
      orderNo: no,
      party: parties.find((p) => Number(p.no) === no)?.party ?? "",
      total: mine.length,
      loaded: mine.filter((p) => p.unitId).length,
      missing: mine.filter((p) => !p.unitId).map((p) => p.pos),
    };
  });
}

/** The lorry's screen: what is left, what is on, and the overrides. */
export async function lorryBoard(fc: FactoryCtx, key: string): Promise<LorryBoard | null> {
  if (!fc.dispatch) return null;
  return boardOf(fc, String(key ?? ""));
}

/**
 * The lorry's loading job: the one running, or a new one in charge of whoever
 * scanned first, with the dispatch crew around them. One per lorry at a time:
 * an advisory lock keeps two first scans from making two.
 */
async function jobFor(fc: FactoryCtx, key: string, asked: string | null): Promise<{ id: string; made: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"florry:" + fc.godown.id + ":" + key}))`);
    const [have] = (await tx.execute(sql`
      select id from factory_tasks where godown_id = ${fc.godown.id} and proc = 'dispatch' and order_no is null and item = ${key} and status = 'ready'
       order by (id = ${asked ?? ""}) desc, created_at limit 1`)) as unknown as { id: string }[];
    if (have) return { id: have.id, made: false };
    const id = await nextTaskId(tx);
    const due = nowHM();
    await tx.execute(sql`
      insert into factory_tasks (id, proc, godown_id, work_date, due, status, item, created_by_id)
      values (${id}, 'dispatch', ${fc.godown.id}, ${today()}::date, ${due}, 'ready', ${key}, ${fc.user.id})`);
    const crew = (await teamDefaults()).dispatch;
    const team: Team = { owner: fc.user.id, op: crew.op && crew.op !== fc.user.id ? crew.op : crew.owner && crew.owner !== fc.user.id ? crew.owner : null, helpers: crew.helpers.filter((h) => h !== fc.user.id), ver: crew.ver };
    await writeTeam(tx, id, team, fc.user.id);
    return { id, made: true };
  });
}

/** The desk speaks of one order; a loader is loading a lorry and is never shown an order. */
export function lorryWords(m: string): string {
  return m
    .replace(/\border \d+ leaves from\b/g, "this lorry leaves from")
    .replace(/\b(on|onto) order \d+/g, "$1 another order")
    .replace(/\bthis order\b/g, "this lorry")
    .replace(/\bThis order\b/g, "This lorry");
}

const VERDICT: Record<string, [string, string]> = {
  unknown: ["We do not know this label", "Scan it again, closer. If it is torn, tell the dispatch head."],
  duplicate: ["Already on the lorry", "Scan the next box."],
  mismatch: ["Wrong stock — do not load", "Keep it aside. Load only what this lorry shows, or ask for an override."],
  blocked: ["Do not load this", "Keep it aside. Ask the dispatch head."],
};

/** The order a box goes onto: an approved override's line, then one whose lot it is from, then the soonest due. */
async function orderForBox(lines: LoadingLine[], code: string): Promise<number> {
  const unit = await unitInfo(code);
  if (unit) {
    const [ov] = lines.length
      ? ((await db.execute(sql`select order_id as line from erp_dispatch_overrides where unit_id = ${unit.id} and status = 'Approved' and order_id in ${inList(lines.map((l) => l.id))} limit 1`)) as unknown as { line: string }[])
      : [];
    const byOverride = ov && lines.find((l) => l.id === ov.line);
    if (byOverride) return byOverride.orderNo;
    const same = lines.filter((l) => l.skuId === unit.skuId);
    const open = same.filter((l) => l.scanned < l.target).sort((a, b) => {
      const la = a.alloc.some((x) => x.lotCode === unit.lotCode && x.scanned < x.qty) ? 0 : 1;
      const lb = b.alloc.some((x) => x.lotCode === unit.lotCode && x.scanned < x.qty) ? 0 : 1;
      return la - lb || dueOrder(a, b);
    });
    if (open.length) return open[0].orderNo;
    /* Nothing on the lorry wants it: the desk still says why — already on, full, or the wrong stock. */
    if (unit.orderNo != null && lines.some((l) => l.orderNo === unit.orderNo)) return unit.orderNo;
    if (same.length) return [...same].sort(dueOrder)[0].orderNo;
    const product = lines.filter((l) => l.productId != null && l.productId === unit.productId && l.scanned < l.target).sort(dueOrder)[0];
    if (product) return product.orderNo;
  }
  return [...lines].sort(dueOrder)[0].orderNo;
}

/** "Box 3 of 10" for a sticker's piece, or just the sticker's id where its place is not known. */
const pieceOf = (s: StickerInfo) => (s.pos != null && s.of != null ? `${s.pos} of ${s.of}` : s.id);

/**
 * A box, a dispatch sticker or a lot label scanned on the lorry: the order
 * chosen here, the verdict and the write the desk's. `held` is the half of a
 * box-and-sticker pair scanned just before, which the phone sends back; every
 * answer says which half the phone should hold next — none, once a pair is in.
 */
export async function lorryScan(fc: FactoryCtx, key: string, raw: string, taskId: string | null, held: string | null = null): Promise<LorryScan> {
  key = String(key ?? "");
  const sticker = stickerCode(String(raw ?? ""));
  const code = sticker ?? normaliseCode(String(raw ?? ""));
  const heldSticker = held ? stickerCode(held) : null;
  const heldBox = held && !heldSticker && looksLikeUnitId(normaliseCode(held)) ? normaliseCode(held) : null;
  /* What the phone keeps holding when this scan changes nothing: the half it already had. */
  const keep: LorryHalf | null = heldSticker ? { kind: "sticker", code: heldSticker, says: "Now scan the box this sticker is on" } : heldBox ? { kind: "box", code: heldBox, says: "Now scan the dispatch sticker on this box" } : null;
  const fail = (title: string, text: string, fix: string, board: LorryBoard | null, task: string | null, override: { sku: string; label: string }[] | null = null, repeat = false, half: LorryHalf | null = keep): LorryScan => ({ ok: false, code, title, text, fix, board, task, override, repeat, half });
  if (!fc.dispatch) return fail(NOT_YOURS.title, NOT_YOURS.text, NOT_YOURS.fix, null, null, null, false, null);
  if (!code) return fail("Nothing was read", "The label was empty.", "Scan the label again.", null, null);
  const lines = await linesOf(fc, key);
  if (!lines.length) return fail("Nothing left for this transport", "Everything going with it is loaded, or the office has sent it.", "Go back to Home.", await boardOf(fc, key, lines), null, null, false, null);
  const ctx = ctxFor(fc);
  /* The job is made by the first scan that puts something on — a wrong label starts nothing. */
  const asked = taskId && /^T-/.test(taskId) ? taskId : null;

  /* The pair is in: the box is judged against the sticker's own line and the sticker claimed with it. */
  const pair = async (box: string, s: StickerInfo): Promise<LorryScan> => {
    const res = await scanOntoOrder(ctx, s.orderNo, box, { id: s.id, lineId: s.lineId });
    if (!res.ok || !res.data.verdict.ok) {
      const board = await boardOf(fc, key, lines);
      if (!res.ok) return fail("Not counted", res.error, "Scan the box and its sticker again.", board, board.lorry?.task ?? null, null, false, null);
      const v = res.data.verdict;
      if (!v.ok && v.result === "duplicate" && board.boxes.some((b) => b.id === box && b.sticker === s.id))
        return fail("Already on", `Box ${box} with sticker ${s.id} is already on this lorry.`, "Scan the next box.", board, board.lorry?.task ?? null, null, true, null);
      if (!v.ok && v.result === "mismatch")
        return fail("Box and sticker do not match", `Sticker ${s.id} is for ${s.skuName} (order ${s.orderNo}). ${lorryWords(v.message)}`, "Find the box this sticker belongs to, then scan both again.", board, board.lorry?.task ?? null, null, false, null);
      const [title, fix] = VERDICT[v.ok ? "blocked" : v.result] ?? VERDICT.blocked;
      return fail(title, lorryWords(v.message), fix, board, board.lorry?.task ?? null, null, false, null);
    }
    const v = res.data.verdict;
    const job = await jobFor(fc, key, asked);
    const board = await boardOf(fc, key);
    await factoryAudit(fc, "factory.dispatch.box", job.id, `${box} with sticker ${s.id} (order ${s.orderNo}, ${pieceOf(s)}) loaded on ${lorryName(board.lorry?.name)} · ${v.allocation}`, { lorry: key, order: s.orderNo, sticker: s.id });
    return {
      ok: true,
      code,
      tone: v.allocation === "swap" ? "warn" : "ok",
      title: v.allocation === "swap" ? "Lot swapped" : "On the lorry",
      message: `${s.delivery} · ${pieceOf(s)}. ${lorryWords(v.message)}`,
      board,
      task: job.id,
      data: null,
      stale: v.allocation !== "matched" || job.made,
      half: null,
    };
  };

  if (sticker) {
    const s = await stickerInfo(db, sticker);
    const board = () => boardOf(fc, key, lines);
    if (!s) return fail("We do not know this sticker", `No dispatch sticker is ${sticker}.`, "Type the code printed under the QR again. If it is torn, tell the dispatch head.", await board(), null);
    if (s.status !== "active") return fail("This sticker was cancelled", `${sticker} was taken off order ${s.orderNo} when it changed.`, "Peel it off. Print the order's stickers again.", await board(), null);
    if (s.unitId) {
      const b = await board();
      if (b.boxes.some((x) => x.id === s.unitId)) return fail("Already on", `Sticker ${sticker} is on box ${s.unitId}, already on this lorry.`, "Scan the next box.", b, b.lorry?.task ?? null, null, true);
      return fail("Sticker already used", `Sticker ${sticker} is on box ${s.unitId}.`, "Keep this box aside. Ask the dispatch head.", b, b.lorry?.task ?? null);
    }
    if (!lines.some((l) => l.id === s.lineId)) {
      const b = await board();
      if (s.godownId !== fc.godown.id) return fail("Not loaded here", `Sticker ${sticker} is for order ${s.orderNo}, which leaves from another godown.`, "Keep it aside. Ask the dispatch head.", b, b.lorry?.task ?? null);
      if (lorryKeyOf(s.transporter) !== key)
        return fail("Not for this lorry", `Sticker ${sticker} is order ${s.orderNo} for ${s.delivery}, going with ${lorryName(s.transporter)}.`, "Keep it aside. Load it on that lorry.", b, b.lorry?.task ?? null);
      return fail("Do not load this", `Order ${s.orderNo} for ${s.delivery} is not ready to load, or has already left.`, "Keep it aside. Ask the dispatch head.", b, b.lorry?.task ?? null);
    }
    if (heldSticker && heldSticker !== sticker)
      return fail("Scan its box first", `Sticker ${heldSticker} is waiting for its box.`, "Scan the box that sticker is on, or press Cancel.", await board(), null);
    if (heldBox) return pair(heldBox, s);
    const b = await board();
    return { ok: true, code, tone: "ok", title: "Sticker read", message: `${s.delivery} · ${s.skuName} · ${pieceOf(s)}.`, board: b, task: b.lorry?.task ?? "", data: null, half: { kind: "sticker", code: sticker, says: "Now scan the box this sticker is on" } };
  }

  if (looksLikeUnitId(code)) {
    if (heldSticker) {
      const s = await stickerInfo(db, heldSticker);
      if (!s || s.status !== "active" || s.unitId) return fail("Scan the sticker again", `Sticker ${heldSticker} cannot be used any more.`, "Scan the sticker, then its box.", await boardOf(fc, key, lines), null, null, false, null);
      return pair(code, s);
    }
    if (heldBox) {
      if (heldBox === code) return fail("Now its sticker", `Box ${code} is read.`, "Scan the dispatch sticker on this box.", await boardOf(fc, key, lines), null, null, true);
      return fail("Scan its sticker first", `Box ${heldBox} is waiting for its dispatch sticker.`, "Scan the sticker on that box, or press Cancel.", await boardOf(fc, key, lines), null);
    }
    /* A box an order with stickers still wants is not loaded alone: the phone asks for its sticker. */
    const unit = await unitInfo(code);
    if (unit && unit.status === "available" && unit.godownId === fc.godown.id) {
      const wanting = lines.filter((l) => l.skuId === unit.skuId && l.scanned < l.target);
      if ((await stickeredLines(db, wanting.map((l) => l.id))).size) {
        const b = await boardOf(fc, key, lines);
        return { ok: true, code, tone: "ok", title: "Box read", message: `${unit.skuName} · lot ${unit.lotCode}.`, board: b, task: b.lorry?.task ?? "", data: null, half: { kind: "box", code, says: "Now scan the dispatch sticker on this box" } };
      }
    }
    const orderNo = await orderForBox(lines, code);
    const res = await scanOntoOrder(ctx, orderNo, code);
    if (!res.ok || !res.data.verdict.ok) {
      /* Nothing was written: the lines read a moment ago are still the lorry's. */
      const board = await boardOf(fc, key, lines);
      if (!res.ok) return fail("Not counted", res.error, "Scan it again. If it keeps failing, tell the dispatch head.", board, board.lorry?.task ?? null);
      const v = res.data.verdict;
      const [title, fix] = VERDICT[v.ok ? "blocked" : v.result] ?? VERDICT.blocked;
      /* A mismatch can be asked about: in place of which item still short on this lorry. */
      const short = !v.ok && v.result === "mismatch" ? (board.lorry?.items ?? []).filter((i) => lorryLeft(i) > 0).map((i) => ({ sku: i.sku, label: i.label })) : null;
      /* The same box scanned again while it is on this lorry is no harm: the phone says so and does not stop the loader. */
      const repeat = !v.ok && v.result === "duplicate" && board.boxes.some((b) => b.id === code);
      return fail(title, lorryWords(v.message), fix, board, board.lorry?.task ?? null, short?.length ? short : null, repeat);
    }
    const v = res.data.verdict;
    const job = await jobFor(fc, key, asked);
    const task = job.id;
    const board = await boardOf(fc, key);
    await factoryAudit(fc, "factory.dispatch.box", task, `${code} loaded on ${lorryName(board.lorry?.name)} · ${v.allocation}`, { lorry: key, order: orderNo });
    /* The box's answer does not wait for the whole factory's data to be rebuilt: the phone fetches that in the background. */
    return { ok: true, code, tone: v.allocation === "swap" ? "warn" : "ok", title: v.allocation === "swap" ? "Lot swapped" : "On the lorry", message: lorryWords(v.message), board, task, data: null, stale: v.allocation !== "matched" || job.made, half: null };
  }

  if (keep) return fail(keep.kind === "box" ? "Scan its sticker first" : "Scan its box first", keep.kind === "box" ? `Box ${keep.code} is waiting for its dispatch sticker.` : `Sticker ${keep.code} is waiting for its box.`, "Finish that one, or press Cancel.", await boardOf(fc, key, lines), null);

  /* A lot label: the orders on this lorry that are short of what the lot is, soonest due first. */
  const lot = await lotInfo(code);
  const fits = (l: LoadingLine) => !!lot && (lot.stage === "pack" ? l.boxed && l.skuId === lot.skuId : lot.stage === "fg" && !l.boxed && l.finishedGoodId != null && l.finishedGoodId === lot.finishedGoodId);
  const short = lines.filter((l) => fits(l) && l.allocated < l.target - 1e-9).sort(dueOrder);
  /* Nothing short of it: an order already given this lot says how many to load from it; else the desk says why not. */
  const given = lines.filter((l) => l.alloc.some((a) => a.lotCode === code)).sort(dueOrder);
  const orders = [...new Set((short.length ? short : given.length ? given : [...lines].sort(dueOrder)).map((l) => l.orderNo))];
  const said: string[] = [];
  let firstFail: string | null = null, failKind = "blocked", wrote = false;
  for (const no of orders) {
    const res = await scanOntoOrder(ctx, no, code);
    if (!res.ok) { firstFail ??= res.error; break; }
    const v = res.data.verdict;
    if (!v.ok) { if (!said.length) { firstFail = v.message; failKind = v.result; } break; }
    said.push(v.message);
    if (v.allocation === "allocate") wrote = true;
    if (!short.length || v.allocation !== "allocate") break;
  }
  if (!said.length) {
    const board = await boardOf(fc, key, lines);
    const [title, fix] = VERDICT[failKind] ?? VERDICT.blocked;
    return fail(title, lorryWords(firstFail ?? "This label does not go on this lorry."), fix, board, board.lorry?.task ?? null);
  }
  const job = await jobFor(fc, key, asked);
  const task = job.id;
  const board = await boardOf(fc, key);
  await factoryAudit(fc, "factory.dispatch.lot", task, `Lot ${code} loaded on ${lorryName(board.lorry?.name)} · ${said.length} order${said.length > 1 ? "s" : ""}`, { lorry: key, lot: code });
  return { ok: true, code, tone: "ok", title: "On the lorry", message: lorryWords(said.join(" ")), board, task, data: wrote || job.made ? await bootstrap(fc) : null };
}

/** A box taken back off the lorry before it is sent. */
export async function lorryUnload(fc: FactoryCtx, key: string, unitId: string): Promise<LorryScan> {
  const code = String(unitId ?? "");
  key = String(key ?? "");
  if (!fc.dispatch) return { ok: false, code, ...NOT_YOURS, board: null, task: null, override: null };
  const before = await boardOf(fc, key);
  if (!before.boxes.some((b) => b.id === code)) return { ok: false, code, title: "Not on this lorry", text: code + " is not loaded on " + lorryName(before.lorry?.name) + ".", fix: "Pull the list down to refresh it.", board: before, task: before.lorry?.task ?? null, override: null };
  const res = await unscanUnit(ctxFor(fc), code);
  const board = await boardOf(fc, key);
  if (!res.ok) return { ok: false, code, title: "Not taken off", text: res.error, fix: "Ask the dispatch head.", board, task: board.lorry?.task ?? null, override: null };
  await factoryAudit(fc, "factory.dispatch.unbox", board.lorry?.task ?? null, `${code} taken off ${lorryName(board.lorry?.name)}`, { lorry: key });
  return { ok: true, code, tone: "ok", title: "Taken off", message: code + " is off the lorry.", board, task: board.lorry?.task ?? "", data: null };
}

/** Asking for a box of other stock to go in place of an item still short on this lorry. */
export async function lorryOverride(fc: FactoryCtx, key: string, raw: string, sku: string, reason: string): Promise<{ ok: true; message: string; board: LorryBoard } | { ok: false; error: string }> {
  if (!fc.dispatch) return { ok: false, error: NOT_YOURS.text };
  const lines = await linesOf(fc, String(key ?? ""));
  const line = lines.filter((l) => l.skuId === sku && l.scanned < l.target).sort(dueOrder)[0];
  if (!line) return { ok: false, error: "That item is not short on this lorry any more." };
  const res = await requestOverride(ctxFor(fc), line.orderNo, raw, String(reason ?? ""), line.id);
  if (!res.ok) return { ok: false, error: res.fieldErrors?.[0]?.message ?? res.error };
  await factoryAudit(fc, "factory.dispatch.override", null, `Override asked: ${normaliseCode(raw)} in place of ${line.skuName}`, { lorry: key });
  return { ok: true, message: "Asked. Somebody with the override power decides it; then scan the box again.", board: await boardOf(fc, key) };
}

/** A supervisor deciding an override from the lorry's screen — the desk's rule: not their own, and a reason to decline. */
export async function lorryDecide(fc: FactoryCtx, key: string, id: string, approve: boolean, note: string | null): Promise<{ ok: true; message: string; board: LorryBoard } | { ok: false; error: string }> {
  if (!fc.dispatch) return { ok: false, error: NOT_YOURS.text };
  const board = await boardOf(fc, String(key ?? ""));
  if (!board.overrides.some((o) => o.id === id)) return { ok: false, error: "That override is not on this lorry." };
  const res = await decideOverride(ctxFor(fc), id, !!approve, note?.trim() ? note.trim() : null);
  if (!res.ok) return { ok: false, error: res.fieldErrors?.[0]?.message ?? res.error };
  return { ok: true, message: approve ? "Approved. Scan the box again to put it on." : "Declined.", board: await boardOf(fc, String(key ?? "")) };
}

/** A box scanned on Home: the lorries at this godown still short of its item. Writes nothing. */
export async function lorryFind(fc: FactoryCtx, raw: string): Promise<LorryFind> {
  const code = normaliseCode(String(raw ?? ""));
  if (!fc.dispatch) return { ok: false, ...NOT_YOURS };
  /* A dispatch sticker names its order, and so its one lorry. */
  const sticker = stickerCode(String(raw ?? ""));
  if (sticker) {
    const s = await stickerInfo(db, sticker);
    if (!s) return { ok: false, title: "We do not know this sticker", text: "No dispatch sticker is " + sticker + ".", fix: "Type the code printed under the QR again. If it is torn, tell the dispatch head." };
    if (s.status !== "active") return { ok: false, title: "This sticker was cancelled", text: sticker + " was taken off order " + s.orderNo + " when it changed.", fix: "Peel it off. Print the order's stickers again." };
    if (s.unitId) return { ok: false, title: "Already on a lorry", text: "Sticker " + sticker + " is on box " + s.unitId + ".", fix: "Keep it aside. Scan the next one." };
    if (s.godownId !== fc.godown.id) return { ok: false, title: "Not loaded here", text: "Order " + s.orderNo + " leaves from another godown.", fix: "Keep it aside. Ask the dispatch head." };
    const lines = await loadingLines(db, fc.godown.id, (t) => lorryKeyOf(t) === lorryKeyOf(s.transporter));
    if (!lines.some((l) => l.id === s.lineId)) return { ok: false, title: "Do not load this", text: "Order " + s.orderNo + " for " + s.delivery + " is not ready to load, or has already left.", fix: "Keep it aside. Ask the dispatch head." };
    return { ok: true, code: sticker, name: s.skuName, lorries: [{ key: lorryKeyOf(s.transporter), name: s.transporter?.trim() || null, need: 1 }] };
  }
  const unit = looksLikeUnitId(code) ? await unitInfo(code) : null;
  if (!unit) return { ok: false, title: "We do not know this box", text: "No box carries " + code + ".", fix: "Scan it again, closer. If it is torn, tell the dispatch head." };
  if (unit.status === "scanned" || unit.status === "dispatched") return { ok: false, title: "Already on a lorry", text: code + " is " + (unit.status === "scanned" ? "already loaded" : "already dispatched") + ".", fix: "Keep it aside. Scan the next box." };
  if (unit.status !== "available") return { ok: false, title: "Do not load this box", text: code + " cannot be dispatched.", fix: "Keep it aside. Ask the dispatch head." };
  if (unit.godownId !== fc.godown.id) return { ok: false, title: "This box is at " + unit.godownName, text: "It is not here at " + fc.godown.name + ".", fix: "Use one that is here. Ask the store team." };
  const lines = await loadingLines(db, fc.godown.id);
  const need = new Map<string, { name: string | null; need: number }>();
  for (const l of lines)
    if (l.skuId === unit.skuId && l.scanned < l.target) {
      const k = lorryKeyOf(l.transporter);
      const x = need.get(k) ?? { name: l.transporter?.trim() || null, need: 0 };
      x.need += l.target - l.scanned;
      need.set(k, x);
    }
  if (!need.size) return { ok: false, title: "No lorry needs this box", text: "No transport at " + fc.godown.name + " is short of " + unit.skuName + ".", fix: "Keep it aside. Scan a box of what a lorry shows." };
  return { ok: true, code, name: unit.skuName, lorries: [...need].map(([key, x]) => ({ key, name: x.name, need: x.need })).sort((a, b) => b.need - a.need) };
}

/** Once a lorry's loading is sent: the one-order jobs an older page made for its orders are done too. */
export async function closeOrderLoads(godownId: string, orderNos: number[]): Promise<void> {
  if (!orderNos.length) return;
  await db.execute(sql`
    update factory_tasks set status = 'done', done_at = now(), out = ${JSON.stringify({ good: 1, unit: "order", at: nowHM(), byLorry: true })}::jsonb
     where godown_id = ${godownId} and proc = 'dispatch' and status = 'ready' and order_no in ${inList(orderNos.map(String))}`);
}

/** The orders a lorry's lines belong to — for closing their older one-order jobs. */
export async function lorryOrderNos(fc: FactoryCtx, key: string): Promise<number[]> {
  return [...new Set((await linesOf(fc, key)).map((l) => l.orderNo))];
}

