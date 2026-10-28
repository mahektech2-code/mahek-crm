import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { dispatchBoard, scanOntoOrder, unscanUnit } from "@/lib/erp/dispatch";
import { looksLikeUnitId, normaliseCode } from "@/lib/erp/engines/trace";
import { FREIGHT_TERMS, uploadedLrs, uploadLrs, transporters as transporterDir, type UploadedLr } from "@/lib/erp/logistics";
import { lrReadingOn, readUploadedLr } from "@/lib/erp/lr-upload-read";
import { bootstrap, erpCtxFor, factoryAudit, orderKey, orderNoOf, type FactoryCtx } from "./server";
import type { BoxInfo, BoxScan, LoadBoard, LrBatchSave, LrFields, LrKit, LrReading, LrRecent, LrSave } from "./types";
import { LR_BATCH_MAX } from "./types";

/* ---------------------------------------------------------------------------
 * THE FLOOR'S TWO DOORS INTO LOGISTICS, and neither decides anything itself.
 *
 * A box scanned on the lorry goes through `scanOntoOrder` — the Dispatch
 * desk's own function, the same lock, the same verdict, the same scan row —
 * so the box counts towards the order's scan gate the moment the loader
 * scans it, and the desk shows it without anybody scanning it twice.
 *
 * An LR photographed at the transporter goes through `uploadLrs` — the
 * register the ERP's Upload LRs button writes — after `readUploadedLr` has
 * read it, exactly as the office modal does. Attaching it to bills stays on
 * the LR desk: that is where the customer is messaged, and that is
 * logistics' decision, not the floor's.
 *
 * Only the dispatch department and the Production Head reach either.
 * ------------------------------------------------------------------------- */

const NOT_YOURS = { title: "Not your work", text: "Loading and LRs are the dispatch team's.", fix: "Ask the Production Head." };

/** The ERP context, with the screens these two jobs belong to. */
function ctxFor(fc: FactoryCtx) {
  const c = erpCtxFor(fc);
  return { ...c, screens: new Set([...c.screens, "dispatch", "transport"]) };
}

/** An order key the phone sends ("SO-1042"), as the ERP's number — or null when it is not one. */
function orderNumber(key: string): number | null {
  const n = Number(orderNoOf(String(key ?? "")));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The order must be one this floor loads: at this godown, not yet verified. */
async function orderHere(fc: FactoryCtx, orderNo: number): Promise<boolean> {
  const rows = (await db.execute(sql`
    select 1 from erp_orders o left join erp_order_details d on d.order_id = o.id
     where o.order_no = ${orderNo} and o.godown_id = ${fc.godown.id} and o.status <> 'Cancel' and coalesce(d.verification, '') <> 'Verified'
     limit 1`)) as unknown as unknown[];
  return rows.length > 0;
}

async function boardOf(orderNo: number): Promise<LoadBoard> {
  const b = await dispatchBoard(orderNo);
  const boxes = (b?.units ?? []).filter((u) => u.status === "scanned").map((u) => ({ id: u.id, lot: u.lotCode, sku: u.sku, at: u.scannedAt, by: u.by }));
  const perLot: Record<string, number> = {};
  for (const x of boxes) perLot[x.lot] = (perLot[x.lot] ?? 0) + 1;
  return { order: orderKey(orderNo), boxes, perLot };
}

const VERDICT_TITLE: Record<string, [string, string]> = {
  unknown: ["We do not know this box", "Scan the box label again, closer. If it is torn, tell the dispatch head."],
  duplicate: ["Already scanned", "Scan the next box."],
  mismatch: ["Wrong stock — do not load", "Keep this box aside. Load only what the order shows."],
  blocked: ["Do not load this box", "Keep this box aside. Ask the dispatch head."],
};

/** The order's boxes, for the Load step. */
export async function loadBoard(fc: FactoryCtx, order: string): Promise<LoadBoard | null> {
  if (!fc.dispatch) return null;
  const no = orderNumber(order);
  if (!no || !(await orderHere(fc, no))) return null;
  return boardOf(no);
}

/** One box label scanned on the lorry, judged and written by the ERP. */
export async function scanBox(fc: FactoryCtx, order: string, raw: string): Promise<BoxScan> {
  const code = normaliseCode(String(raw ?? ""));
  if (!fc.dispatch) return { ok: false, code, ...NOT_YOURS, board: null };
  const no = orderNumber(order);
  if (!no || !(await orderHere(fc, no)))
    return { ok: false, code, title: "This order is not here", text: "It is not waiting to be loaded at " + fc.godown.name + ".", fix: "Go back and open the order again.", board: null };
  if (!code) return { ok: false, code, title: "Nothing was read", text: "The label was empty.", fix: "Scan the box label again.", board: null };
  const res = await scanOntoOrder(ctxFor(fc), no, code);
  const board = await boardOf(no);
  if (!res.ok) return { ok: false, code, title: "Not counted", text: res.error, fix: "Scan it again. If it keeps failing, tell the dispatch head.", board };
  const v = res.data.verdict;
  if (!v.ok) {
    const [title, fix] = VERDICT_TITLE[v.result] ?? VERDICT_TITLE.blocked;
    /* Scanned again while it is on this order: no harm, and the loader is not stopped for it. */
    const repeat = v.result === "duplicate" && board.boxes.some((b) => b.id === code);
    return { ok: false, code, title, text: v.message, fix, board, repeat };
  }
  await factoryAudit(fc, "factory.dispatch.box", null, `${code} loaded for ${orderKey(no)} · ${v.allocation}`, { order: no });
  /* A scan that allocated or swapped a lot changed the order the phone holds. A box's answer does not wait for that: the phone fetches it in the background. A lot label's does, because the next question about the lot is asked from it. */
  if (looksLikeUnitId(code)) return { ok: true, code, message: v.message, board, data: null, stale: v.allocation !== "matched" };
  return { ok: true, code, message: v.message, board, data: v.allocation === "matched" ? null : await bootstrap(fc) };
}

/** A box taken back off the lorry before the order is sent. */
export async function unloadBox(fc: FactoryCtx, order: string, unitId: string): Promise<BoxScan> {
  const code = String(unitId ?? "");
  if (!fc.dispatch) return { ok: false, code, ...NOT_YOURS, board: null };
  const no = orderNumber(order);
  if (!no || !(await orderHere(fc, no))) return { ok: false, code, title: "This order is not here", text: "It is not waiting to be loaded.", fix: "Go back and open the order again.", board: null };
  const before = await boardOf(no);
  if (!before.boxes.some((b) => b.id === code)) return { ok: false, code, title: "Not on this order", text: code + " is not scanned onto " + orderKey(no) + ".", fix: "Pull the list down to refresh it.", board: before };
  const res = await unscanUnit(ctxFor(fc), code);
  const board = await boardOf(no);
  if (!res.ok) return { ok: false, code, title: "Not taken off", text: res.error, fix: "Ask the dispatch head.", board };
  await factoryAudit(fc, "factory.dispatch.unbox", null, `${code} taken off ${orderKey(no)}`, { order: no });
  return { ok: true, code, message: code + " taken off " + orderKey(no) + ".", board, data: null };
}

const STATUS_WORD: Record<string, string> = { available: "in stock", scanned: "scanned onto an order", dispatched: "dispatched", cancelled: "cancelled" };

/** A box label scanned from the home screen: what it is and where it stands. Writes nothing. */
export async function boxInfo(raw: string): Promise<BoxInfo> {
  const code = normaliseCode(String(raw ?? ""));
  if (!looksLikeUnitId(code)) return { ok: false, title: "We do not know this QR", text: "This is not a box label.", fix: "Scan the box label (BX-…)." };
  const [u] = (await db.execute(sql`
    select u.id, u.status, p.name as sku, u.lot_code as lot, g.name as godown, o.order_no as "orderNo"
      from erp_units u join products p on p.id = u.sku_id join erp_godowns g on g.id = u.godown_id
      left join erp_orders o on o.id = u.order_id
     where u.id = ${code}`)) as unknown as { id: string; status: string; sku: string; lot: string; godown: string; orderNo: number | null }[];
  if (!u) return { ok: false, title: "We do not know this box", text: "No box carries " + code + ".", fix: "Scan it again, closer. If it is torn, tell the dispatch head." };
  return { ok: true, line: `${u.id} · ${u.sku} · lot ${u.lot} · ${STATUS_WORD[u.status] ?? u.status}${u.orderNo ? " · " + orderKey(u.orderNo) : ""} · ${u.godown}` };
}

/* ================================================================== LRs */

const recentOf = (rows: UploadedLr[]): LrRecent[] =>
  rows
    .slice(0, 15)
    .map((r) => ({ id: r.id, lrNo: r.lrNo, lrDate: r.lrDate, transporter: r.transporter, destination: r.destination, packages: r.packages, status: r.status, bills: r.bills, uploadedBy: r.uploadedBy }));

/** What the Upload LR screen needs: the transporters to pick from, whether photos are read, and the latest uploads. */
export async function lrKit(fc: FactoryCtx): Promise<LrKit> {
  if (!fc.dispatch) return { ok: false, ...NOT_YOURS };
  const [dir, canRead, recent] = await Promise.all([transporterDir(), lrReadingOn(), uploadedLrs({ status: "all" })]);
  return { ok: true, transporters: dir.filter((t) => t.active).map((t) => t.name), canRead, recent: recentOf(recent), terms: FREIGHT_TERMS };
}

/** Reads an LR photo the phone has just uploaded — the office modal's reading, unchanged. */
export async function readLr(fc: FactoryCtx, fileId: string): Promise<LrReading> {
  if (!fc.dispatch) return { ok: false, text: NOT_YOURS.text };
  const r = await readUploadedLr(ctxFor(fc), String(fileId ?? ""));
  if (!r.ok) return { ok: false, text: r.error };
  const s = r.data.suggestion;
  return {
    ok: true,
    readingId: r.data.readingId,
    fields: { lrNo: s.lrNo, lrDate: s.lrDate, transporter: s.transporter, destination: s.destination, packages: s.packages, freightTerm: s.freightTerm, freightRupees: s.freightRupees },
    check: s.checkNumber,
    notes: s.notes,
  };
}

/** Saves one LR into the register. Sent twice with the same photo, it answers with the first save. */
export async function saveLr(fc: FactoryCtx, input: LrFields & { fileId: string | null; readingId: string | null; note?: string | null }): Promise<LrSave> {
  if (!fc.dispatch) return { ok: false, ...NOT_YOURS };
  const fileId = input?.fileId ? String(input.fileId) : null;
  if (fileId) {
    const [had] = (await db.execute(sql`select id, lr_no as "lrNo" from erp_lrs where file_id = ${fileId} and status <> 'void' limit 1`)) as unknown as { id: string; lrNo: string | null }[];
    if (had) return { ok: true, id: had.id, msg: "LR " + (had.lrNo ?? "") + " is uploaded.", replay: true, recent: recentOf(await uploadedLrs({ status: "all" })) };
  }
  if (!fileId && !String(input?.lrNo ?? "").trim()) return { ok: false, title: "Take the LR photo", text: "An LR needs its photo or its number.", fix: "Take a photo of the LR.", field: "photo" };
  const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const res = await uploadLrs(ctxFor(fc), [
    {
      lrNo: input.lrNo,
      lrDate: input.lrDate,
      transporter: input.transporter,
      destination: input.destination,
      packages: num(input.packages),
      freightRupees: num(input.freightRupees),
      freightTerm: input.freightTerm,
      fileId,
      readingId: input.readingId,
      note: input.note ?? null,
    },
  ]);
  if (!res.ok) {
    const field = res.fieldErrors?.[0]?.field?.replace(/^l\d+\./, "");
    return { ok: false, title: "Not uploaded", text: res.error.replace(/^Row 1: /, ""), fix: field === "lrNo" ? "Check the LR number." : "Check what you typed and try again.", field };
  }
  const id = res.data.ids[0];
  await factoryAudit(fc, "factory.dispatch.lr", null, `Uploaded LR ${(input.lrNo ?? "").toUpperCase() || "(photo only)"}${input.transporter ? " · " + input.transporter : ""}`, { lr: id });
  return { ok: true, id, msg: "LR uploaded. Logistics will attach it to the bills.", recent: recentOf(await uploadedLrs({ status: "all" })) };
}

/**
 * MANY LRs IN ONE PRESS. The dispatch team comes back from the transporter
 * with a stack of receipts, so the phone uploads up to twenty photos and this
 * stores each as its own photo-only LR — the same row the ERP's Upload LRs
 * writes — for logistics to match to the bills on the LR desk. Reading the
 * photos is SECONDARY: the caller runs `readStoredLrs` after answering, and
 * an LR it cannot read simply waits on the desk to be typed.
 *
 * Safe to send twice: a photo already on an LR answers as already stored. A
 * file that is not this person's own fresh upload is refused, not stored.
 */
export async function saveLrPhotos(fc: FactoryCtx, fileIds: string[]): Promise<LrBatchSave & { newIds?: string[] }> {
  if (!fc.dispatch) return { ok: false, ...NOT_YOURS };
  const ids = [...new Set((Array.isArray(fileIds) ? fileIds : []).map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (!ids.length) return { ok: false, title: "Add the LR photos", text: "No photo came with this upload.", fix: "Add the photos, then upload." };
  if (ids.length > LR_BATCH_MAX) return { ok: false, title: "Too many at once", text: `Upload up to ${LR_BATCH_MAX} LRs at a time.`, fix: `Send the first ${LR_BATCH_MAX}, then the rest.` };
  const list = sql.join(ids.map((i) => sql`${i}`), sql`, `);
  const had = (await db.execute(sql`select file_id as "fileId", id from erp_lrs where status <> 'void' and file_id in (${list})`)) as unknown as { fileId: string; id: string }[];
  const already = new Set(had.map((h) => h.fileId));
  const mine = (await db.execute(sql`
    select id from attachments where id in (${list}) and uploaded_by_id = ${fc.user.id} and status = 'available' and parent_id is null`)) as unknown as { id: string }[];
  const fresh = ids.filter((i) => !already.has(i) && mine.some((m) => m.id === i));
  const refused = ids.length - already.size - fresh.length;
  let newIds: string[] = [];
  if (fresh.length) {
    const res = await uploadLrs(ctxFor(fc), fresh.map((fileId) => ({ fileId })));
    if (!res.ok) return { ok: false, title: "Not uploaded", text: res.error, fix: "Try again. The photos are kept on this phone." };
    newIds = res.data.ids;
    await factoryAudit(fc, "factory.dispatch.lrBatch", null, `Uploaded ${newIds.length} LR photo${newIds.length === 1 ? "" : "s"}`, { lrs: newIds });
  }
  const reading = newIds.length > 0 && (await lrReadingOn());
  const stored = newIds.length;
  const parts = [
    stored ? `${stored} LR${stored === 1 ? "" : "s"} uploaded` : "",
    already.size ? `${already.size} already uploaded` : "",
    refused ? `${refused} could not be used — take ${refused === 1 ? "it" : "them"} again` : "",
  ].filter(Boolean);
  return {
    ok: true,
    ids: [...had.map((h) => h.id), ...newIds],
    newIds,
    stored,
    already: already.size,
    refused,
    reading,
    msg: parts.join(" · ") + (stored ? (reading ? ". The numbers are being read from the photos; logistics will attach them to the bills." : ". Logistics will read them and attach them to the bills.") : "."),
    recent: recentOf(await uploadedLrs({ status: "all" })),
  };
}
