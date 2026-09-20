import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  PLACE_KINDS,
  PLACE_PARENT,
  parsePlace,
  placeChain,
  placeKey,
  type PlaceKind,
  type ReverseGeocodeResult,
} from "@/lib/place-parse";
import { reverseGeocode, reverseGeocodeReady } from "./ola-reverse-geocode-service";

/* ---------------------------------------------------------------------------
 * THE PLACE MASTER, in three passes that are three different costs.
 *
 * `lookupPlaces`   spends the API and writes only `customer_place_lookups`.
 * `proposePlaces`  reads those lookups, builds the tree it WOULD write, and
 *                  writes nothing at all.
 * `resolvePlaces`  writes `places` and the four ids on each customer.
 *
 * Splitting them is the whole design and it is the split the sheet jobs
 * already keep — sync, project, reparse. The first is the only one that costs
 * anything outside this deployment and it is the only one that cannot be
 * undone by running it again; the second is how somebody reads 1,165 strings
 * collapsing into a tree BEFORE a single row changes; the third is idempotent
 * and re-runnable, because it derives everything from the stored answers.
 *
 * A CHANGED READING COSTS NOTHING. That is what the lookup table buys and it
 * is the lesson `taken-order-reparse` exists for: a hash-driven sync re-reads
 * nothing when the RULE changes, and 294 rows once stayed muted on the
 * strength of a decision already reversed in the code. Improving `parsePlace`
 * here means re-running the third pass, not re-spending 4,930 requests.
 *
 * NOTHING HERE TOUCHES `customers.city` OR `customers.region`. Those are the
 * sheet's and two projections rewrite them every pass; a cleaned value would
 * be gone within half an hour, which is the `sales_person_name` failure this
 * codebase already records. The resolution sits BESIDE them.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

/* ══════════════════════════════════════════════ pass one — ask the geocoder */

export type LookupRun = {
  attempted: number;
  answered: number;
  unanswered: number;
  remaining: number;
  detail: string;
};

/**
 * Reverse-geocode the shops that carry a pin and have never been asked about.
 *
 * SERIAL, deliberately, and bounded per run. This runs unattended against
 * somebody else's rate limit, and twenty concurrent requests is how a free
 * tier turns into a 429 for everything else the deployment does — including
 * the Live map's snap-to-road, which a manager may be looking at right now.
 * The reasoning and the shape are `geocode-job-service.ts`'s, one table over.
 *
 * `gps_lat` IS PREFERRED OVER `geocoded_lat` and they are recorded as
 * different sources. A field pin is somebody standing in the shop; a geocoded
 * one is Ola's reading of an address line, which outside the metros is the
 * centre of a locality. Both are usable for "which district is this in" and
 * only one of them is usable for "which street" — so both are asked and the
 * row says which answered, rather than the weaker one being dropped or the
 * two being silently mixed.
 */
export async function lookupPlaces(limit = 500): Promise<LookupRun> {
  if (!(await reverseGeocodeReady())) {
    return {
      attempted: 0,
      answered: 0,
      unanswered: 0,
      remaining: 0,
      detail:
        "No Ola Maps key is set, so nothing was asked. " +
        "Admin Console → Platform → Maps.",
    };
  }

  const rows = (await db.execute<{
    id: string;
    lat: number;
    lng: number;
    source: string;
  }>(sql`
    select c.id,
           coalesce(c.gps_lat, c.geocoded_lat) as lat,
           coalesce(c.gps_lng, c.geocoded_lng) as lng,
           case when c.gps_lat is not null then 'gps' else 'geocode' end as source
      from customers c
      left join customer_place_lookups l on l.customer_id = c.id
     where l.customer_id is null
       and coalesce(c.gps_lat, c.geocoded_lat) is not null
       and coalesce(c.gps_lng, c.geocoded_lng) is not null
     order by c.id asc
     limit ${limit}
  `)) as unknown as Array<{ id: string; lat: number; lng: number; source: string }>;

  let answered = 0;

  for (const row of rows) {
    const result = await reverseGeocode(row.lat, row.lng);
    if (result) answered += 1;

    /* The row is written whether or not an answer came back, so a run does not
       spend its budget re-asking the unanswerable every night. `ok` is what
       tells "we asked and got nothing" from "nobody has asked", which are two
       different facts about a shop. */
    await db.execute(sql`
      insert into customer_place_lookups
        (customer_id, source, lat, lng, raw, ok, looked_up_at)
      values (${row.id}, ${row.source}, ${row.lat}, ${row.lng},
              ${result ? JSON.stringify(result) : null}::jsonb,
              ${Boolean(result)}, now())
      on conflict (customer_id) do update
        set source = excluded.source,
            lat = excluded.lat,
            lng = excluded.lng,
            raw = excluded.raw,
            ok = excluded.ok,
            looked_up_at = excluded.looked_up_at
    `);
  }

  const [{ remaining }] = (await db.execute<{ remaining: number }>(sql`
    select count(*)::int as remaining
      from customers c
      left join customer_place_lookups l on l.customer_id = c.id
     where l.customer_id is null
       and coalesce(c.gps_lat, c.geocoded_lat) is not null
  `)) as unknown as Array<{ remaining: number }>;

  return {
    attempted: rows.length,
    answered,
    unanswered: rows.length - answered,
    remaining,
    detail:
      `${rows.length} asked, ${answered} answered, ${rows.length - answered} did not; ` +
      `${remaining} shops with a pin still to ask about`,
  };
}

/* ═══════════════════════════════════════ passes two and three — read them */

type Chain = Array<{ kind: PlaceKind; name: string }>;

type Resolution = {
  customerId: string;
  source: string;
  chain: Chain;
};

/** Every stored answer, read back and parsed. No I/O beyond the one select. */
async function storedResolutions(): Promise<Resolution[]> {
  const rows = (await db.execute<{
    customer_id: string;
    source: string;
    raw: ReverseGeocodeResult | null;
  }>(sql`
    select l.customer_id, l.source, l.raw
      from customer_place_lookups l
     where l.ok = true
  `)) as unknown as Array<{
    customer_id: string;
    source: string;
    raw: ReverseGeocodeResult | null;
  }>;

  const out: Resolution[] = [];
  for (const row of rows) {
    const chain = placeChain(parsePlace(row.raw ?? undefined));
    if (!chain.length) continue;
    out.push({ customerId: row.customer_id, source: row.source, chain });
  }
  return out;
}

/** A node of the tree as it is being built, before anything is written. */
type Node = {
  kind: PlaceKind;
  name: string;
  key: string;
  parent: Node | null;
  children: Map<string, Node>;
  /** Shops resolving to exactly this rung, and to it or anything under it. */
  own: number;
  shops: number;
  /** Filled by the write pass. */
  id?: string;
};

function newNode(kind: PlaceKind, name: string, parent: Node | null): Node {
  return {
    kind,
    name,
    key: placeKey(name),
    parent,
    children: new Map(),
    own: 0,
    shops: 0,
  };
}

/**
 * The tree the stored answers make, with a count on every node.
 *
 * `shops` is the count INCLUDING everything below, because that is the figure
 * a picker needs — a district showing only the shops with no city under them
 * would read as almost empty on exactly the districts that are busiest.
 * `own` is kept beside it for the opposite question, which is how many shops
 * stop at this rung because the geocoder had nothing finer to say.
 */
function buildTree(resolutions: Resolution[]): Map<string, Node> {
  const roots = new Map<string, Node>();

  for (const r of resolutions) {
    let level = roots;
    let parent: Node | null = null;

    for (const step of r.chain) {
      const key = placeKey(step.name);
      let node = level.get(key);
      if (!node) {
        node = newNode(step.kind, step.name, parent);
        level.set(key, node);
      }
      node.shops += 1;
      parent = node;
      level = node.children;
    }
    if (parent) parent.own += 1;
  }

  return roots;
}

function walk(level: Map<string, Node>, visit: (n: Node) => void): void {
  for (const node of [...level.values()]) {
    visit(node);
    walk(node.children, visit);
  }
}

export type PlaceProposal = {
  /** How many nodes of each rung the tree would have. */
  counts: Record<PlaceKind, number>;
  /** Shops that would resolve, by the rung their chain stops at. */
  resolvedAt: Record<PlaceKind, number>;
  /** Shops with no usable answer, and why — the honest denominator. */
  unresolved: {
    noLookup: number;
    lookupFailed: number;
    total: number;
  };
  customers: number;
  /** What `customers.city` costs today, for the comparison that justifies this. */
  distinctCityStrings: number;
  /** The tree itself, flattened for printing, biggest first inside each parent. */
  tree: Array<{ kind: PlaceKind; name: string; path: string; shops: number; own: number }>;
  detail: string;
};

/**
 * WHAT THE MASTER WOULD BE, writing nothing.
 *
 * The point of this pass is that somebody reads the tree before it exists.
 * 1,165 strings collapsing to a few hundred nodes is either obviously right or
 * obviously wrong at a glance, and the glance has to come first: a place
 * master is what every territory and every journey will be picked from
 * afterwards, and a wrong node is not a row somebody notices, it is a shop
 * that quietly stops appearing on a list.
 */
export async function proposePlaces(): Promise<PlaceProposal> {
  const resolutions = await storedResolutions();
  const roots = buildTree(resolutions);

  const counts = { state: 0, district: 0, city: 0, area: 0 } as Record<PlaceKind, number>;
  const tree: PlaceProposal["tree"] = [];

  const path = (n: Node): string => {
    const parts: string[] = [];
    for (let cur: Node | null = n; cur; cur = cur.parent) parts.unshift(cur.name);
    return parts.join(" › ");
  };

  /* Biggest first inside each parent, for the same reason `knownPlaces` sorts
     that way: the place somebody means is almost always one of the few with
     real shop counts, and the long tail is below it. */
  const emit = (level: Map<string, Node>) => {
    const ordered = [...level.values()].sort(
      (a, b) => b.shops - a.shops || a.name.localeCompare(b.name),
    );
    for (const node of ordered) {
      counts[node.kind] += 1;
      tree.push({
        kind: node.kind,
        name: node.name,
        path: path(node),
        shops: node.shops,
        own: node.own,
      });
      emit(node.children);
    }
  };
  emit(roots);

  const resolvedAt = { state: 0, district: 0, city: 0, area: 0 } as Record<PlaceKind, number>;
  for (const r of resolutions) {
    const last = r.chain[r.chain.length - 1];
    if (last) resolvedAt[last.kind] += 1;
  }

  const [totals] = (await db.execute<{
    customers: number;
    distinct_city: number;
    looked_up: number;
    failed: number;
  }>(sql`
    select (select count(*)::int from customers) as customers,
           (select count(distinct lower(trim(city)))::int from customers) as distinct_city,
           (select count(*)::int from customer_place_lookups) as looked_up,
           (select count(*)::int from customer_place_lookups where ok = false) as failed
  `)) as unknown as Array<{
    customers: number;
    distinct_city: number;
    looked_up: number;
    failed: number;
  }>;

  const resolved = resolutions.length;
  const unresolved = {
    noLookup: totals.customers - totals.looked_up,
    lookupFailed: totals.failed,
    total: totals.customers - resolved,
  };

  return {
    counts,
    resolvedAt,
    unresolved,
    customers: totals.customers,
    distinctCityStrings: totals.distinct_city,
    tree,
    detail:
      `${resolved} of ${totals.customers} shops resolve; ` +
      `${counts.state} states, ${counts.district} districts, ` +
      `${counts.city} cities, ${counts.area} areas ` +
      `(against ${totals.distinct_city} distinct city strings today); ` +
      `${unresolved.total} unresolved — ${unresolved.noLookup} never asked, ` +
      `${unresolved.lookupFailed} asked and unanswered`,
  };
}

export type ResolveRun = {
  nodes: number;
  resolved: number;
  unresolved: number;
  respected: number;
  detail: string;
};

/**
 * Write the tree and point every shop at its leaf.
 *
 * IDEMPOTENT, and it derives everything from the stored lookups — so running
 * it twice is running it once, and running it after a change to `parsePlace`
 * is the reparse. Nodes are upserted on their natural key rather than
 * recreated, because an id is what a territory row and a journey stop will
 * hold: dropping and rebuilding the table would silently repoint every one of
 * them at a row that no longer exists.
 *
 * A DECIDED ROW IS LEFT ALONE. `place_decided_at` is the mark somebody chose,
 * and a job that runs unattended must not undo a decision — the same guard
 * `am_decided_at` gives the manager seats, arrived at the hard way there.
 */
export async function resolvePlaces(): Promise<ResolveRun> {
  const resolutions = await storedResolutions();
  const roots = buildTree(resolutions);

  /* ---- the nodes, coarsest rung first so a parent always has its id ---- */

  let nodes = 0;
  for (const kind of PLACE_KINDS) {
    const atThisRung: Node[] = [];
    walk(roots, (n) => {
      if (n.kind === kind) atThisRung.push(n);
    });

    for (const node of atThisRung) {
      const parentId = node.parent?.id ?? null;
      /* The parent's rung is checked rather than assumed. A city whose
         district is missing cannot be written under the state instead — the
         hole would make every count above it a count of two different things,
         which is the rule `placeChain` already refuses to allow. */
      if (PLACE_PARENT[kind] !== null && !parentId) continue;

      /*
       * SELECT, THEN INSERT — not `on conflict`, and the reason is the two
       * partial indexes. A partial unique index cannot be named in an
       * `on conflict` clause, and conflicting on the primary key instead
       * would never fire: the id is a fresh uuid every time, so a second run
       * would insert a duplicate and then be refused by the very index that
       * was supposed to prevent it. Idempotence is the whole contract of this
       * pass, so the existing node is looked up first.
       *
       * `is not distinct from` rather than `=`, because the parent of a state
       * is NULL and `= null` is null, which matches nothing — every state
       * would look new on every run.
       */
      const [found] = (await db.execute<{ id: string }>(sql`
        select places.id from places
         where places.kind = ${kind}
           and places.key = ${node.key}
           and places.parent_id is not distinct from ${parentId}
         limit 1
      `)) as unknown as Array<{ id: string }>;

      if (found) {
        node.id = found.id;
        /* The name is NOT rewritten on an existing node. The first spelling
           seen wins, which the schema says, and a later answer spelling it
           differently is not a correction — it is the same place. Only the
           count moves, because the count is the cache. */
        await db.execute(sql`
          update places set shops = ${node.shops}, updated_at = now()
           where places.id = ${node.id}
        `);
      } else {
        const fresh = id("pl");
        await db.execute(sql`
          insert into places (id, kind, name, key, parent_id, shops, created_at, updated_at)
          values (${fresh}, ${kind}, ${node.name}, ${node.key}, ${parentId},
                  ${node.shops}, now(), now())
        `);
        node.id = fresh;
      }
      nodes += 1;
    }
  }

  /* ---- the shops ---- */

  let resolved = 0;
  let respected = 0;

  for (const r of resolutions) {
    let level = roots;
    const ids: Partial<Record<PlaceKind, string>> = {};
    for (const step of r.chain) {
      const node = level.get(placeKey(step.name));
      if (!node?.id) break;
      ids[node.kind] = node.id;
      level = node.children;
    }
    if (!ids.state) continue;

    const changed = (await db.execute<{ id: string }>(sql`
      update customers
         set resolved_state_id = ${ids.state ?? null},
             resolved_district_id = ${ids.district ?? null},
             resolved_city_id = ${ids.city ?? null},
             resolved_area_id = ${ids.area ?? null},
             place_source = ${r.source},
             place_resolved_at = now()
       where customers.id = ${r.customerId}
         and customers.place_decided_at is null
      returning customers.id
    `)) as unknown as Array<{ id: string }>;

    if (changed.length) resolved += 1;
    else respected += 1;
  }

  const [{ unresolved }] = (await db.execute<{ unresolved: number }>(sql`
    select count(*)::int as unresolved from customers
     where customers.resolved_state_id is null
  `)) as unknown as Array<{ unresolved: number }>;

  return {
    nodes,
    resolved,
    unresolved,
    respected,
    detail:
      `${nodes} places written, ${resolved} shops resolved, ` +
      `${respected} left alone because somebody had decided them, ` +
      `${unresolved} still unresolved`,
  };
}
