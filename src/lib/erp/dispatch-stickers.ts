import "server-only";
import { randomInt } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { STICKER_ALPHABET } from "@/lib/factory/rules";
import type { Ex } from "./stock";

/* ---------------------------------------------------------------------------
 * DISPATCH STICKERS CARRY THEIR OWN ID (`erp_dispatch_stickers`).
 *
 * The id is minted the first time the sticker is printed and is the same on
 * every reprint, so a box never carries two live stickers. A line printed for
 * more pieces than it has ids gains new ones; one printed for fewer cancels
 * its LAST unloaded ones — a sticker already paired with a box is never
 * cancelled from under it. "3 of 10" is the sticker's place among the order's
 * live stickers, line by line in the order they were entered, worked out on
 * read: it is what is printed and what the loading board counts against.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

export type StickerPlace = { id: string; lineId: string; orderNo: number; pos: number; of: number; unitId: string | null; loadedAt: string | null };

function mintId(): string {
  let s = "DS-";
  for (let i = 0; i < 6; i++) s += STICKER_ALPHABET[randomInt(STICKER_ALPHABET.length)];
  return s;
}

/**
 * Make the order's live stickers match what is about to be printed: `want`
 * maps each line to its number of pieces. Lines not named are left alone — a
 * line already dispatched keeps the stickers it left with.
 */
export async function ensureStickers(orderNo: number, want: Map<string, number>, byId: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"stickers:" + orderNo}))`);
    const have = (await tx.execute(sql`
      select id, order_id as "lineId", seq, status, unit_id as "unitId" from erp_dispatch_stickers where order_no = ${orderNo} order by order_id, seq`)) as unknown as { id: string; lineId: string; seq: number; status: string; unitId: string | null }[];
    for (const [lineId, n] of want) {
      const mine = have.filter((h) => h.lineId === lineId);
      const live = mine.filter((h) => h.status === "active");
      if (live.length < n) {
        let seq = mine.reduce((m, h) => Math.max(m, Number(h.seq)), 0);
        for (let i = live.length; i < n; i++) {
          seq += 1;
          /* Thirty-one letters six deep: a clash is a one-in-a-billion retry, not a refusal. */
          for (let tries = 0; ; tries++) {
            const rows = (await tx.execute(sql`
              insert into erp_dispatch_stickers (id, order_id, order_no, seq, printed_by_id)
              values (${mintId()}, ${lineId}, ${orderNo}, ${seq}, ${byId}) on conflict (id) do nothing returning id`)) as unknown as unknown[];
            if (rows.length || tries > 5) break;
          }
        }
      } else if (live.length > n) {
        const spare = live.filter((h) => !h.unitId).slice(-(live.length - n));
        if (spare.length)
          await tx.execute(sql`update erp_dispatch_stickers set status = 'cancelled', cancelled_at = now() where id in ${spare.map((h) => h.id)}`);
      }
    }
    /* A line cancelled since it was printed takes its stickers with it, or "of 10" would count goods that are not going. */
    await tx.execute(sql`
      update erp_dispatch_stickers s set status = 'cancelled', cancelled_at = now()
        from erp_orders o
       where o.id = s.order_id and s.order_no = ${orderNo} and s.status = 'active' and s.unit_id is null and o.status = 'Cancel'`);
  });
}

/** Every live sticker of these orders with its place: line by line as entered, then as minted. */
export async function stickerPlaces(ex: Ex, orderNos: number[]): Promise<StickerPlace[]> {
  if (!orderNos.length) return [];
  const rows = (await ex.execute(sql`
    select s.id, s.order_id as "lineId", s.order_no as "orderNo", s.unit_id as "unitId", s.loaded_at as "loadedAt",
           row_number() over (partition by s.order_no order by o.created_at, o.id, s.seq)::int as pos,
           count(*) over (partition by s.order_no)::int as "of"
      from erp_dispatch_stickers s join erp_orders o on o.id = s.order_id
     where s.status = 'active' and s.order_no in ${orderNos}
     order by s.order_no, pos`)) as unknown as Row[];
  return rows.map((r) => ({
    id: String(r.id),
    lineId: String(r.lineId),
    orderNo: Number(r.orderNo),
    pos: Number(r.pos),
    of: Number(r.of),
    unitId: r.unitId == null ? null : String(r.unitId),
    loadedAt: r.loadedAt == null ? null : new Date(r.loadedAt as string).toISOString(),
  }));
}

export type StickerInfo = {
  id: string;
  status: string;
  lineId: string;
  orderNo: number;
  unitId: string | null;
  skuName: string;
  lineStatus: string;
  transporter: string | null;
  godownId: string;
  delivery: string;
  pos: number | null;
  of: number | null;
};

/** One sticker as a scan reads it: its line, its party and where it stands. */
export async function stickerInfo(ex: Ex, id: string, lock = false): Promise<StickerInfo | null> {
  const [r] = (await ex.execute(sql`
    select s.id, s.status, s.order_id as "lineId", s.order_no as "orderNo", s.unit_id as "unitId", p.name as sku, o.status as "lineStatus",
           o.transporter, o.godown_id as "godownId", coalesce(dc.name, bc.name) as delivery
      from erp_dispatch_stickers s
      join erp_orders o on o.id = s.order_id join products p on p.id = o.sku_id
      join customers bc on bc.id = o.billing_customer_id left join customers dc on dc.id = o.delivery_customer_id
     where s.id = ${id}
     ${lock ? sql`for update of s` : sql``}`)) as unknown as Row[];
  if (!r) return null;
  const place = String(r.status) === "active" ? (await stickerPlaces(ex, [Number(r.orderNo)])).find((x) => x.id === id) : undefined;
  return {
    id: String(r.id),
    status: String(r.status),
    lineId: String(r.lineId),
    orderNo: Number(r.orderNo),
    unitId: r.unitId == null ? null : String(r.unitId),
    skuName: String(r.sku),
    lineStatus: String(r.lineStatus),
    transporter: r.transporter == null ? null : String(r.transporter),
    godownId: String(r.godownId),
    delivery: String(r.delivery),
    pos: place?.pos ?? null,
    of: place?.of ?? null,
  };
}

/** The lines (by id) that carry live stickers: those load by box AND sticker. */
export async function stickeredLines(ex: Ex, lineIds: string[]): Promise<Set<string>> {
  if (!lineIds.length) return new Set();
  const rows = (await ex.execute(sql`select distinct order_id as id from erp_dispatch_stickers where status = 'active' and order_id in ${lineIds}`)) as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** The sticker paired with a box, if any. */
export async function stickerOfUnit(ex: Ex, unitId: string): Promise<string | null> {
  const [r] = (await ex.execute(sql`select id from erp_dispatch_stickers where unit_id = ${unitId} and status = 'active' limit 1`)) as unknown as { id: string }[];
  return r?.id ?? null;
}

/** A box taken back off the lorry gives its sticker back: the sticker can be paired again. */
export async function releaseSticker(ex: Ex, unitId: string): Promise<void> {
  await ex.execute(sql`update erp_dispatch_stickers set unit_id = null, loaded_at = null, loaded_by_id = null where unit_id = ${unitId} and status = 'active'`);
}
