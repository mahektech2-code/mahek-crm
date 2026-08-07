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
  /** The formulation, shown under the name so near-identical names separate. */
  subtitle: string | null;
  /** Packing, so a quantity in cans reads back as litres and boxes too. */
  millilitresPerCan: number | null;
  cansPerBox: number;
  lastPurchaseDate: string | null;
  totalOrderCount: number;
};

type Row = {
  product_id: string;
  name: string;
  pack_size: string | null;
  formulation: string | null;
  millilitres_per_can: number | null;
  cans_per_box: number;
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
      select l.product_id, (c.started_at at time zone 'Asia/Kolkata')::date as purchased_on, c.order_id as order_key
        from interaction_product_lines l
        join calls c on c.id = l.interaction_id
       where c.customer_id = ${customerId} and c.order_id is not null
      union all
      -- External: line items are JSON carrying a product NAME, so the match
      -- back to the catalogue is by name — and legacy text was typed by
      -- whoever typed it. So the comparison is on the match key, casing,
      -- spacing and punctuation stripped, exactly as lib/catalogue.ts defines
      -- it. Aliases count too: the losing side of a resolved duplicate, and
      -- any spelling somebody has taught the catalogue, must still resolve or
      -- the history silently loses orders it should have found.
      select p.id, (o.ordered_at at time zone 'Asia/Kolkata')::date, o.id
        from orders o
        cross join lateral jsonb_array_elements(o.line_items) as li
        join products p
          on regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g')
             = regexp_replace(lower(li->>'product'), '[^a-z0-9]', '', 'g')
          or regexp_replace(lower(p.name || coalesce(' ' || p.pack_size, '')), '[^a-z0-9]', '', 'g')
             = regexp_replace(lower(li->>'product'), '[^a-z0-9]', '', 'g')
          or exists (
               select 1 from product_aliases a
                where a.product_id = p.id
                  and regexp_replace(lower(a.name), '[^a-z0-9]', '', 'g')
                      = regexp_replace(lower(li->>'product'), '[^a-z0-9]', '', 'g')
             )
       where o.customer_id = ${customerId}
         and o.source = 'external'
         and o.status in ('captured','confirmed','dispatched')
         and o.line_items is not null
    )
    select p.id as product_id, p.name, p.pack_size, f.name as formulation,
           p.millilitres_per_can, p.cans_per_box,
           max(lines.purchased_on)::text as last_purchase,
           count(distinct lines.order_key)::int as order_count
      from lines
      join products p on p.id = lines.product_id
      left join product_formulations f on f.id = p.formulation_id
     where p.active = true
     group by p.id, p.name, p.pack_size, f.name, p.millilitres_per_can, p.cans_per_box
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
 * What the picker offers before anybody types and before the customer has any
 * history of their own — the book's best sellers, most-ordered first.
 *
 * This exists because the whole catalogue used to be shipped to the browser as
 * a prop. That was reasonable at sixteen products and is not at two hundred:
 * it is a payload on every page load, and a list nobody can read mid-call. A
 * telecaller opening the panel wants a handful of likely answers and a search
 * box, not the catalogue.
 *
 * Held SKUs are excluded by `active`, so a product whose legacy ID nobody has
 * settled can never be offered.
 */
export async function popularProducts(): Promise<FrequentProduct[]> {
  const config = await getConfig();
  const limit = config["products.starterListCount"];
  if (limit <= 0) return [];

  const rows = await db.execute<Row>(sql`
    select p.id as product_id, p.name, p.pack_size, f.name as formulation,
           p.millilitres_per_can, p.cans_per_box,
           max(c.started_at at time zone 'Asia/Kolkata')::date::text as last_purchase,
           count(distinct c.order_id)::int as order_count
      from products p
      join interaction_product_lines l on l.product_id = p.id
      join calls c on c.id = l.interaction_id and c.order_id is not null
      left join product_formulations f on f.id = p.formulation_id
     where p.active = true
     group by p.id, p.name, p.pack_size, f.name, p.millilitres_per_can, p.cans_per_box
     order by order_count desc, p.display_order, p.name
     limit ${limit}
  `);

  // A book with no order history yet would return nothing, which is a blank
  // list rather than a starting point. Fall back to the front of the
  // catalogue, which is the order a manager arranged it in.
  if (rows.length > 0) return rows.map(toProduct);

  const fallback = await db.execute<Row>(sql`
    select p.id as product_id, p.name, p.pack_size, f.name as formulation,
           p.millilitres_per_can, p.cans_per_box,
           null::text as last_purchase, 0 as order_count
      from products p
      left join product_formulations f on f.id = p.formulation_id
     where p.active = true
     order by p.display_order, p.name
     limit ${limit}
  `);
  return fallback.map(toProduct);
}

/**
 * Catalogue search, tolerant of the way a name gets typed mid-call. Exact and
 * prefix matches come first, then substring, then anything trigram-similar
 * enough to be a misspelling — "thiner" has to find Thinner, because the
 * telecaller is on a call and will not try twice.
 *
 * It searches the FORMULATION and the BRAND as well as the SKU name, because
 * one liquid sells under several names: M5x4 is what the factory calls what
 * the customer calls Nano, and a telecaller who was told "M5x4" has to find
 * the Nano SKUs or they will conclude we do not stock it. Aliases are searched
 * too — an old name a customer still uses must resolve to whatever it became.
 *
 * The formulation comes back as a subtitle, which is what makes a list of
 * near-identical names usable: "Astar Nano Thinner - 20 Liter (Loose)" and
 * "Nano Thinner - 20 Liter (Loose)" are distinguishable only by what is
 * underneath them.
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
    /** The formulation, shown under the name. Null on pre-catalogue rows. */
    subtitle: string | null;
    brand: string | null;
    millilitresPerCan: number | null;
    cansPerBox: number;
    /** Why this row matched, when it was not the name — "matched M5x4". */
    matchedOn: string | null;
    boughtBefore: boolean;
  }>
> {
  const q = query.trim();
  if (!q) return [];

  const like = `%${q}%`;

  const rows = await db.execute<{
    product_id: string;
    name: string;
    pack_size: string | null;
    formulation: string | null;
    brand: string | null;
    millilitres_per_can: number | null;
    cans_per_box: number;
    matched_on: string | null;
    bought_before: boolean;
  }>(sql`
    select p.id as product_id, p.name, p.pack_size,
           f.name as formulation, b.name as brand,
           p.millilitres_per_can, p.cans_per_box,
           -- What matched, where it was not the thing on the label. A row that
           -- appears for a word the telecaller cannot see has to explain itself.
           case
             when p.name ilike ${like} then null
             when f.name ilike ${like} then f.name
             when b.name ilike ${like} then b.name
             when a.name is not null then a.name
             else null
           end as matched_on,
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
      left join product_formulations f on f.id = p.formulation_id
      left join product_brands b on b.id = p.brand_id
      left join lateral (
        select al.name
          from product_aliases al
         where al.product_id = p.id
           and (al.name ilike ${like} or similarity(al.name, ${q}) > 0.25)
         limit 1
      ) a on true
     where p.active = true
       and (
         p.name ilike ${like}
         or coalesce(p.pack_size, '') ilike ${like}
         or (p.name || coalesce(' ' || p.pack_size, '')) ilike ${like}
         or similarity(p.name, ${q}) > 0.25
         or coalesce(f.name, '') ilike ${like}
         or similarity(coalesce(f.name, ''), ${q}) > 0.35
         or coalesce(b.name, '') ilike ${like}
         or similarity(coalesce(b.name, ''), ${q}) > 0.35
         or a.name is not null
       )
     order by
       case
         when lower(p.name) = lower(${q}) then 0
         when p.name ilike ${q + "%"} then 1
         when p.name ilike ${like} then 2
         when coalesce(b.name, '') ilike ${like} then 3
         when coalesce(f.name, '') ilike ${like} then 4
         else 5
       end,
       similarity(p.name, ${q}) desc,
       p.display_order, p.name
     limit 25
  `);

  return rows.map((r) => ({
    productId: r.product_id,
    name: r.name,
    packSize: r.pack_size,
    displayName: r.name,
    subtitle: r.formulation,
    brand: r.brand,
    millilitresPerCan: r.millilitres_per_can,
    cansPerBox: Number(r.cans_per_box) || 1,
    matchedOn: r.matched_on,
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
    subtitle: r.formulation,
    millilitresPerCan: r.millilitres_per_can,
    cansPerBox: Number(r.cans_per_box) || 1,
    lastPurchaseDate: r.last_purchase,
    totalOrderCount: Number(r.order_count),
  };
}
