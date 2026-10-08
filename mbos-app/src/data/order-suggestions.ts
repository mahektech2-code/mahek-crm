import { getKv, setKv } from '../db';
import { orderProducts } from '../sync/api';
import { productsByIds } from './customers';

/**
 * WHAT THE ORDER FORM OFFERS BEFORE ANYTHING IS TYPED.
 *
 * This shop's usual products, from the office's whole order history, and the
 * best sellers for a shop with none. Both used to be guessed on the phone and
 * both guesses were wrong: "usual" counted only orders placed on THIS handset,
 * which is nearly always none, and the starter list was the first eight SKUs
 * alphabetically — eight pack sizes of one thinner, at every counter.
 *
 * The office answers (`/api/mbos/order-products`) and the last answer is kept
 * per shop in `kv`, so a counter this phone has served before is offered the
 * same list with no signal. Only ids travel; the products themselves are the
 * catalogue already on the phone, so a SKU withdrawn since is simply not drawn.
 */
export type Suggested = Awaited<ReturnType<typeof productsByIds>>[number];

export type OrderSuggestions = {
  usual: (Suggested & { orderCount: number; lastPurchaseDate: string | null })[];
  starter: Suggested[];
  /** False while the list is the remembered one rather than today's answer. */
  fresh: boolean;
};

type Stored = {
  usual: { productId: string; orderCount: number; lastPurchaseDate: string | null }[];
  starter: string[];
};

const usualKey = (customerId: string) => `orderUsual:${customerId}`;
const STARTER_KEY = 'orderStarter';

async function resolve(stored: Stored, fresh: boolean): Promise<OrderSuggestions> {
  const products = await productsByIds([...new Set([...stored.usual.map((u) => u.productId), ...stored.starter])]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const usual = stored.usual.flatMap((u) => {
    const p = byId.get(u.productId);
    return p ? [{ ...p, orderCount: u.orderCount, lastPurchaseDate: u.lastPurchaseDate }] : [];
  });
  const usualIds = new Set(usual.map((u) => u.id));
  /* A best seller this shop already buys is drawn once, under "usual". */
  const starter = stored.starter.flatMap((id) => {
    const p = byId.get(id);
    return p && !usualIds.has(id) ? [p] : [];
  });
  return { usual, starter, fresh };
}

/** What was last known for this shop — instant, and works with no signal. */
export async function rememberedSuggestions(customerId: string): Promise<OrderSuggestions> {
  const [usual, starter] = await Promise.all([getKv(usualKey(customerId)), getKv(STARTER_KEY)]);
  const parse = <V>(raw: string | null, fallback: V): V => {
    try {
      return raw ? (JSON.parse(raw) as V) : fallback;
    } catch {
      return fallback;
    }
  };
  return resolve({ usual: parse(usual, []), starter: parse(starter, []) }, false);
}

/** Today's answer from the office, remembered for next time. Null offline. */
export async function freshSuggestions(customerId: string): Promise<OrderSuggestions | null> {
  const answer = await orderProducts(customerId);
  if (!answer.ok) return null;
  await Promise.all([
    setKv(usualKey(customerId), JSON.stringify(answer.usual)),
    setKv(STARTER_KEY, JSON.stringify(answer.starter)),
  ]);
  return resolve({ usual: answer.usual, starter: answer.starter }, true);
}
