import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "../config/store";

/* ---------------------------------------------------------------------------
 * §2 Product selection.
 *
 * One aggregation answers two questions: which products this customer buys
 * regularly (the order form's quick-pick container) and what their product
 * history looks like (the Information tab). They were separate queries once
 * and disagreed about the same customer, which is a thing a telecaller
 * notices and stops trusting.
 *
 * Both CRM-captured and external orders count. The CRM records a product id
 * per line; the external system records a NAME inside the order's line items,
 * so external lines are matched back to the catalogue by name. That match is
 * the weak link — an external line naming a product the catalogue does not
 * carry contributes nothing, by design, because an unmatched name cannot be
 * put on an order form.
 * ------------------------------------------------------------------------- */

export type FrequentProduct = {
  productId: string;
  name: string;
  packSize: string | null;
  /** Name and pack size as one string, the way both screens display it. */
  displayName: string;
  lastPurchaseDate: string | null;
  totalOrderCount: number;
};

type Row = {
  product_id: string;
  name: string;
  pack_size: string | null;
  last_purchase: string | null;
  order_count: number;
};

/**
 * Every product this customer has ordered, most-ordered first, inactive
 * products excluded. `limit` of 0 means all of them — the Information tab
 * wants the whole history, the order form wants the configured handful.
 */
export async function customerProducts(
  customerId: string,
  opts: { limit?: number; ranking?: "orders" | "recency" } = {},
): Promise<FrequentProduct[]> {
  const config = await getConfig();
  const ranking = opts.ranking ?? config["products.frequentRanking"];
  const limit = opts.limit ?? 0;

  // Ranked in SQL rather than in JS: the caller asking for six should not
  // pull four hundred rows to throw away the rest.
  const order =
    ranking === "recency"
      ? sql`last_purchase desc nulls last, order_count desc`
      : sql`order_count desc, last_purchase desc nulls last`;

  const rows = await db.execute<Row>(sql`
    with lines as (
      -- CRM-captured: a product id per line, joined to the interaction that
      -- produced the order.
      select l.product_id, c.started_at::date as purchased_on, c.order_id as order_key
        from interaction_product_lines l
        join calls c on c.id = l.interaction_id
       where c.customer_id = ${customerId} and c.order_id is not null
      union all
      -- External: line items are JSON carrying a product name, so the match
      -- back to the catalogue is by name.
      select p.id, o.ordered_at::date, o.id
        from orders o
        cross join lateral jsonb_array_elements(o.line_items) as li
        join products p
          on lower(p.name) = lower(li->>'product')
          or lower(p.name || coalesce(' ' || p.pack_size, '')) = lower(li->>'product')
       where o.customer_id = ${customerId}
         and o.source = 'external'
         and o.status <> 'cancelled'
         and o.line_items is not null
    )
    select p.id as product_id, p.name, p.pack_size,
           max(lines.purchased_on)::text as last_purchase,
           count(distinct lines.order_key)::int as order_count
      from lines
      join products p on p.id = lines.product_id
     where p.active = true
     group by p.id, p.name, p.pack_size
     order by ${order}
     ${limit > 0 ? sql`limit ${limit}` : sql``}
  `);

  return rows.map(toProduct);
}

/** The order form's quick-pick container. */
export async function frequentProducts(
  customerId: string,
): Promise<FrequentProduct[]> {
  const config = await getConfig();
  return customerProducts(customerId, {
    limit: config["products.frequentCount"],
  });
}

/**
 * Catalogue search, tolerant of the way a name gets typed mid-call. Exact and
 * prefix matches come first, then substring, then anything trigram-similar
 * enough to be a misspelling — "thiner" has to find Thinner, because the
 * telecaller is on a call and will not try twice.
 */
export async function searchProducts(
  query: string,
  customerId?: string,
): Promise<
  Array<{
    productId: string;
    name: string;
    packSize: string | null;
    displayName: string;
    boughtBefore: boolean;
  }>
> {
  const q = query.trim();
  if (!q) return [];

  const rows = await db.execute<{
    product_id: string;
    name: string;
    pack_size: string | null;
    bought_before: boolean;
  }>(sql`
    select p.id as product_id, p.name, p.pack_size,
           ${
             customerId
               ? sql`exists (
                   select 1 from interaction_product_lines l
                     join calls c on c.id = l.interaction_id
                    where l.product_id = p.id
                      and c.customer_id = ${customerId}
                      and c.order_id is not null
                 )`
               : sql`false`
           } as bought_before
      from products p
     where p.active = true
       and (
         p.name ilike ${"%" + q + "%"}
         or coalesce(p.pack_size, '') ilike ${"%" + q + "%"}
         or (p.name || coalesce(' ' || p.pack_size, '')) ilike ${"%" + q + "%"}
         or similarity(p.name, ${q}) > 0.25
       )
     order by
       case
         when lower(p.name) = lower(${q}) then 0
         when p.name ilike ${q + "%"} then 1
         when p.name ilike ${"%" + q + "%"} then 2
         else 3
       end,
       similarity(p.name, ${q}) desc,
       p.display_order, p.name
     limit 25
  `);

  return rows.map((r) => ({
    productId: r.product_id,
    name: r.name,
    packSize: r.pack_size,
    displayName: display(r.name, r.pack_size),
    boughtBefore: r.bought_before,
  }));
}

function display(name: string, packSize: string | null): string {
  return packSize ? `${name} - ${packSize}` : name;
}

function toProduct(r: Row): FrequentProduct {
  return {
    productId: r.product_id,
    name: r.name,
    packSize: r.pack_size,
    displayName: display(r.name, r.pack_size),
    lastPurchaseDate: r.last_purchase,
    totalOrderCount: Number(r.order_count),
  };
}
