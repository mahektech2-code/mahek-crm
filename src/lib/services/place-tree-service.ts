import "server-only";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { parseCsv } from "@/lib/csv";
import { PLACE_KINDS, placeKey, type PlaceKind } from "@/lib/place-parse";
import {
  chainFromRow,
  indexPlaces,
  matchTypedPlace,
  type PlaceChainStep,
  type PlaceNode,
} from "@/lib/place-tree";

/* ---------------------------------------------------------------------------
 * THE REVIEWED LOCATION TREE, written into `places` and onto every customer.
 *
 * Two passes, and they are two different kinds of answer:
 *
 * `importPlaceTree`    the team's reviewed file — a person checked these, so
 *                      each row is stamped `place_decided_at` and nothing
 *                      unattended may move it afterwards (the Ola pass in
 *                      `place-service.ts` already honours that mark).
 * `resolveTypedPlaces` every shop the review never saw, matched from the
 *                      sheet's own text against the tree the review built.
 *                      Stamped `place_source = 'sheet'` and NOT decided, so it
 *                      is re-read every night and follows the sheet when the
 *                      sheet is corrected.
 *
 * NOTHING HERE TOUCHES `customers.city` OR `customers.region`. Those are the
 * sheet's and the projections rewrite them every pass — see the note on the
 * same columns in `place-service.ts`. The resolution sits beside them.
 * ------------------------------------------------------------------------- */

const DATA_FILE = path.join(process.cwd(), "data", "places", "customer-places.csv");

const newId = () => `pl_${randomUUID().slice(0, 12)}`;

type TreeNode = {
  kind: PlaceKind;
  name: string;
  key: string;
  parent: TreeNode | null;
  children: Map<string, TreeNode>;
  id?: string;
};

export type PlaceTreeImport = {
  rows: number;
  placesCreated: number;
  placesKept: number;
  customersSet: number;
  customersMissing: number;
  refused: number;
  typed: TypedResolveRun | null;
  detail: string;
};

/**
 * Write the reviewed file. Idempotent: a node that exists is found by its key
 * under its parent and reused, and a customer is simply re-pointed.
 *
 * `--dry-run` reads the file and the database and writes nothing, and reports
 * the same counts a real run would.
 */
export async function importPlaceTree(
  options: { dryRun?: boolean; file?: string } = {},
): Promise<PlaceTreeImport> {
  const rows = parseCsv(readFileSync(options.file ?? DATA_FILE, "utf8"));

  /* ---- the tree the file describes ---- */
  const roots = new Map<string, TreeNode>();
  const assignments: Array<{ customerId: string; leaf: TreeNode }> = [];
  let refused = 0;

  for (const row of rows) {
    const customerId = (row.customer_id ?? "").trim();
    const chain = chainFromRow(row);
    if (!customerId || !chain || !chain.length) {
      refused += 1;
      continue;
    }
    let level = roots;
    let parent: TreeNode | null = null;
    for (const step of chain as PlaceChainStep[]) {
      const key = placeKey(step.name);
      let node = level.get(key);
      if (!node) {
        node = { kind: step.kind, name: step.name, key, parent, children: new Map() };
        level.set(key, node);
      }
      parent = node;
      level = node.children;
    }
    assignments.push({ customerId, leaf: parent as TreeNode });
  }

  /* ---- which customers exist, so a missing one is counted, not thrown ---- */
  const existing = new Set(
    (
      (await db.execute<{ id: string }>(sql`select customers.id from customers`)) as unknown as Array<{
        id: string;
      }>
    ).map((r) => r.id),
  );
  const present = assignments.filter((a) => existing.has(a.customerId));
  const customersMissing = assignments.length - present.length;

  const all: TreeNode[] = [];
  const walk = (level: Map<string, TreeNode>) => {
    for (const n of level.values()) {
      all.push(n);
      walk(n.children);
    }
  };
  walk(roots);

  /* ---- nodes, coarsest rung first so a parent always has its id ---- */
  let placesCreated = 0;
  let placesKept = 0;

  for (const kind of PLACE_KINDS) {
    for (const node of all.filter((n) => n.kind === kind)) {
      const parentId = node.parent?.id ?? null;
      /* `is not distinct from`, because a state's parent is NULL and `= null`
         matches nothing — every state would look new on every run. Select
         then insert rather than `on conflict`, because the two unique indexes
         are partial and cannot be named in one; see `resolvePlaces`. */
      const [found] = (await db.execute<{ id: string }>(sql`
        select places.id from places
         where places.kind = ${kind}
           and places.key = ${node.key}
           and places.parent_id is not distinct from ${parentId}
         limit 1
      `)) as unknown as Array<{ id: string }>;

      if (found) {
        node.id = found.id;
        placesKept += 1;
        continue;
      }
      placesCreated += 1;
      if (options.dryRun) {
        node.id = `dry_${placesCreated}`;
        continue;
      }
      const fresh = newId();
      await db.execute(sql`
        insert into places (id, kind, name, key, parent_id, shops, created_at, updated_at)
        values (${fresh}, ${kind}, ${node.name}, ${node.key}, ${parentId}, 0, now(), now())
      `);
      node.id = fresh;
    }
  }

  /* ---- the shops ---- */
  let customersSet = 0;
  if (!options.dryRun) {
    /* In chunks of 500 through one `update … from (values …)`: six thousand
       single-row updates over a tunnel is minutes, and this is seconds. */
    const idsOf = (leaf: TreeNode): Partial<Record<PlaceKind, string>> => {
      const ids: Partial<Record<PlaceKind, string>> = {};
      for (let cur: TreeNode | null = leaf; cur; cur = cur.parent) ids[cur.kind] = cur.id;
      return ids;
    };
    for (let i = 0; i < present.length; i += 500) {
      const chunk = present.slice(i, i + 500);
      const values = sql.join(
        chunk.map((a) => {
          const ids = idsOf(a.leaf);
          return sql`(${a.customerId}, ${ids.state ?? null}, ${ids.district ?? null}, ${ids.city ?? null}, ${ids.area ?? null})`;
        }),
        sql`, `,
      );
      const changed = (await db.execute<{ id: string }>(sql`
        update customers c
           set resolved_state_id = v.state,
               resolved_district_id = v.district,
               resolved_city_id = v.city,
               resolved_area_id = v.area,
               place_source = 'review',
               place_resolved_at = now(),
               place_decided_at = now()
          from (values ${values}) as v(id, state, district, city, area)
         where c.id = v.id
        returning c.id
      `)) as unknown as Array<{ id: string }>;
      customersSet += changed.length;
    }
  } else {
    customersSet = present.length;
  }

  const typed = options.dryRun ? null : await resolveTypedPlaces();
  if (!options.dryRun) await refreshPlaceCounts();

  return {
    rows: rows.length,
    placesCreated,
    placesKept,
    customersSet,
    customersMissing,
    refused,
    typed,
    detail:
      `${options.dryRun ? "DRY RUN — " : ""}${rows.length} reviewed rows; ` +
      `${placesCreated} places created, ${placesKept} already there; ` +
      `${customersSet} customers placed, ${customersMissing} in the file but not in this database, ` +
      `${refused} rows refused` +
      (typed ? `; then ${typed.detail}` : ""),
  };
}

export type TypedResolveRun = {
  considered: number;
  toArea: number;
  toCity: number;
  toStateOnly: number;
  unplaced: number;
  detail: string;
};

/**
 * Place every shop nobody reviewed, from what the sheet typed.
 *
 * Considers a shop with no resolution at all, and one this pass placed before
 * (`place_source = 'sheet'`), so a corrected sheet moves it on the next night.
 * A reviewed, geocoded or hand-picked shop is never touched.
 */
export async function resolveTypedPlaces(
  opts: { ids?: string[] } = {},
): Promise<TypedResolveRun> {
  if (opts.ids && !opts.ids.length) {
    return { considered: 0, toArea: 0, toCity: 0, toStateOnly: 0, unplaced: 0, detail: "nothing to place" };
  }
  const nodes = (await db.execute<{
    id: string;
    kind: PlaceKind;
    name: string;
    key: string;
    parent_id: string | null;
    shops: number;
  }>(sql`select places.id, places.kind, places.name, places.key, places.parent_id, places.shops from places`)) as unknown as Array<{
    id: string;
    kind: PlaceKind;
    name: string;
    key: string;
    parent_id: string | null;
    shops: number;
  }>;
  const index = indexPlaces(
    nodes.map<PlaceNode>((n) => ({
      id: n.id,
      kind: n.kind,
      name: n.name,
      key: n.key,
      parentId: n.parent_id,
      shops: Number(n.shops),
    })),
  );

  const shops = (await db.execute<{
    id: string;
    region: string | null;
    city: string | null;
    address: string | null;
  }>(sql`
    select customers.id, customers.region, customers.city, customers.address
      from customers
     where customers.place_decided_at is null
       and (customers.resolved_state_id is null or customers.place_source = 'sheet')
       ${
         opts.ids
           ? sql`and customers.id in (${sql.join(
               opts.ids.map((v) => sql`${v}`),
               sql`, `,
             )})`
           : sql``
       }
  `)) as unknown as Array<{
    id: string;
    region: string | null;
    city: string | null;
    address: string | null;
  }>;

  let toArea = 0;
  let toCity = 0;
  let toStateOnly = 0;
  let unplaced = 0;
  const writes: Array<{ id: string; ids: Partial<Record<PlaceKind, string>> }> = [];

  for (const shop of shops) {
    const ids = matchTypedPlace(index, shop);
    if (!ids.state) {
      unplaced += 1;
      continue;
    }
    if (ids.area) toArea += 1;
    else if (ids.city) toCity += 1;
    else toStateOnly += 1;
    writes.push({ id: shop.id, ids });
  }

  for (let i = 0; i < writes.length; i += 500) {
    const chunk = writes.slice(i, i + 500);
    const values = sql.join(
      chunk.map(
        (w) =>
          sql`(${w.id}, ${w.ids.state ?? null}, ${w.ids.district ?? null}, ${w.ids.city ?? null}, ${w.ids.area ?? null})`,
      ),
      sql`, `,
    );
    await db.execute(sql`
      update customers c
         set resolved_state_id = v.state,
             resolved_district_id = v.district,
             resolved_city_id = v.city,
             resolved_area_id = v.area,
             place_source = 'sheet',
             place_resolved_at = now()
        from (values ${values}) as v(id, state, district, city, area)
       where c.id = v.id
         and c.place_decided_at is null
    `);
  }

  return {
    considered: shops.length,
    toArea,
    toCity,
    toStateOnly,
    unplaced,
    detail:
      `${shops.length} unreviewed shops matched from their sheet text — ` +
      `${toArea} to an area, ${toCity} to a city, ${toStateOnly} to their state only, ` +
      `${unplaced} with no state the tree knows`,
  };
}

/**
 * Place shops that were just written — a customer added or edited in the CRM,
 * a lead captured — so they can be filtered by place at once rather than after
 * the nightly pass. A courtesy on top of a completed write: it never throws,
 * because a shop is never lost to its town not being found.
 */
export async function placeShopsNow(ids?: string[]): Promise<void> {
  try {
    await resolveTypedPlaces(ids ? { ids } : {});
  } catch (e) {
    console.error("placeShopsNow", e);
  }
}

/**
 * `places.shops` — how many customers sit at or under each node. A CACHE,
 * rebuilt whole: counting up a parent chain in one statement per rung.
 */
export async function refreshPlaceCounts(): Promise<void> {
  await db.execute(sql`
    update places p
       set shops = coalesce(n.shops, 0), updated_at = now()
      from (
        select places.id,
               (select count(*)::int from customers c
                 where c.resolved_state_id = places.id
                    or c.resolved_district_id = places.id
                    or c.resolved_city_id = places.id
                    or c.resolved_area_id = places.id) as shops
          from places
      ) n
     where p.id = n.id
       and p.shops is distinct from coalesce(n.shops, 0)
  `);
}
