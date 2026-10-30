/* ---------------------------------------------------------------------------
 * What the override, special-price and shop-price screens are handed. Pure
 * types, client-safe: the reads behind them are in
 * `services/price-override-service.ts`, which is server-only.
 * ------------------------------------------------------------------------- */

import type { OverrideView } from "@/lib/price-book-views";

/** The facts a special price is weighed on — the same on asking and on deciding. */
export type ShopProductFacts = {
  customerId: string;
  customerName: string;
  city: string;
  productId: string;
  productName: string;
  gstBp: number;
  /** What the shop pays today, from whichever list prices it. */
  payToday: { ex: number; incl: number; listName: string } | null;
  /** What its book charges without any special price. */
  book: { ex: number; incl: number; listName: string } | null;
  /** The book's next scheduled revision for this product, where one is dated. */
  scheduled: { date: string; ex: number; incl: number; listName: string } | null;
  /** Average cans a month over the last six whole months; null where nothing was bought. */
  avgCansPerMonth: number | null;
  /** What it was actually billed over six months (ex-GST), where billed. */
  billed: { lines: number; minEx: number; medianEx: number } | null;
  payment: {
    outstandingPaise: number;
    overduePaise: number;
    daysOverdue: number;
    slowPayer: boolean;
    creditBlocked: boolean;
    creditLimitPaise: number | null;
  };
  /** Other shops in the same city: what they pay for this product, ex-GST. Names are not shown. */
  nearby: { shops: number; minEx: number | null; medianEx: number | null; maxEx: number | null; ratesEx: number[] };
  liveOverride: { rateExGstPaise: number; rateInclGstPaise: number; validTo: string | null } | null;
};

export type AiVerdict = "approve" | "counter" | "refuse";

export type RequestAdvice = {
  provider: "openai" | "anthropic";
  label: string;
  ok: boolean;
  reason: string | null;
  verdict: AiVerdict | null;
  priceInclGstPaise: number | null;
  months: number | null;
  minCansPerMonth: number | null;
  reasons: string[];
  risk: string | null;
  at: string | null;
};

export type RequestContext = {
  requestId: string;
  status: string;
  reason: string;
  requestedByName: string | null;
  requestedExGstPaise: number;
  requestedInclGstPaise: number;
  facts: ShopProductFacts;
  advice: RequestAdvice[];
  aiReady: { enabled: boolean; openai: boolean; anthropic: boolean };
};

export type ShopPriceSource = "override" | "agreed" | "book";

export type ShopPriceRow = {
  productId: string;
  productName: string;
  millilitresPerCan: number | null;
  payEx: number;
  payIncl: number;
  offered: boolean;
  source: ShopPriceSource;
  listName: string;
  /** The book's rate where the shop pays something else. */
  bookEx: number | null;
  bookIncl: number | null;
  override: { id: string; validTo: string | null; minCansPerMonth: number | null } | null;
  /** Other slabs, where the list prices by quantity. */
  slabs: number;
};

export type ShopPricesView = {
  customer: { id: string; name: string; city: string; region: string | null };
  /** The lists that name the shop, narrowest first, and why each is there. */
  chain: Array<{ listId: string; listName: string; agreed: boolean; sentence: string }>;
  rows: ShopPriceRow[];
  next: { date: string; changes: Array<{ productId: string; productName: string; fromIncl: number | null; toIncl: number | null; listName: string }> } | null;
  overrides: OverrideView[];
  answers: Array<{ question: string; answer: string; by: string; at: string }>;
  aiReady: boolean;
};
