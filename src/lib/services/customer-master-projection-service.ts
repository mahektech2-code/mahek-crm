import "server-only";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { customers, sheetCustomerMasterRows } from "@/db/schema";
import { readSheetStatus } from "@/lib/customer-master-parse";
import { APP_TIMEZONE } from "@/lib/business-date";

/* ---------------------------------------------------------------------------
 * Publishing `sheet_customer_master_rows` into `customers`.
 *
 * A SECOND PASS, not part of the sync, for the reason every other import here
 * is built the same way: the staging table holds what the spreadsheet said and
 * the projection holds what MahekOne decided, and keeping them apart is what
 * made `revert-sheet-paid` possible when the order sheet's reading of "paid"
 * turned out to be wrong. This one can be dry-run, and should be.
 *
 * WHAT KIND OF RECORD EACH SHOP BECOMES
 *
 * `customers.kind` is exclusive — lead or customer — and a lead's whole
 * definition is an account that has never ordered. This sheet holds no order
 * history at all, so the kind cannot be read off it directly and is decided
 * from EVIDENCE OF A PURCHASE gathered from the Activity log beside it:
 *
 *   - a Payment Collection visit. You do not collect money from a prospect,
 *     and this is the strongest signal in the data.
 *   - the old app's own pipeline label — "Stage 4 - First-Time Customer",
 *     "Stage 5 - Repeat Customer", "Stage 0 - Inactive Customers". All three
 *     say somebody bought; only the tense differs.
 *   - a value band in the master's own Rating column. You do not rate a shop
 *     High/Medium/Low Value on a conversation.
 *
 * Anything with none of those is a LEAD, which is the honest default: absence
 * of evidence of an order is exactly what a lead is. Every verdict is stored
 * with the evidence that produced it, because "why is this one a customer"
 * is asked months later about one row, and re-running the rule then answers a
 * question about today instead.
 *
 * WHAT IT DELIBERATELY DOES NOT WRITE
 *
 * `third_party` — the schema says in as many words that no import may set it,
 * because leads were filled from a spreadsheet once already and that is the
 * mess the mark exists to sort out. A shop we deliver to and do not bill is a
 * person's judgement plus a named distributor, and this sheet supplies
 * neither. The evidence is kept on the staging row for whoever decides later.
 *
 * `active_in_order_system` — 0021 already cleared what an import wrote into
 * this once, and the queue holds such a customer back. An import must never
 * touch it.
 *
 * `sales_person_name` — the sheet names a salesman for nearly every shop, and
 * writing it would be undone on the next nightly: `recomputeSalesPeople`
 * rewrites that column from the PARTY sheet for every customer without
 * `am_decided_at`, and sets it to null where the party sheet is silent — which
 * it is for all of these. Setting `am_decided_at` to protect it would be a
 * lie (no person decided anything) and would freeze the two manager seats
 * against a future sync as a side effect. So the name stays on the staging
 * row, where it is preserved, queryable, and not fighting a nightly job.
 *
 * `status` beyond deactivation — `customers.status` is derived by
 * `recomputeInactivity` from the buying cycle. The one value it never touches
 * is `deactivated`, because that is a human decision — and the sheet's own
 * `Deactive` is exactly that decision, made in the old app. So Deactive maps
 * to `deactivated` and everything else is left at `active` for the engine.
 * ------------------------------------------------------------------------- */

export type ProjectionOptions = {
  /** Report what would change and write nothing. */
  dryRun?: boolean;
  /** Only project shops the Activity log has seen since this date. */
  visitedSince?: string | null;
  triggeredById?: string | null;
};

export type ProjectionResult = {
  considered: number;
  created: number;
  updated: number;
  skipped: number;
  asLead: number;
  asCustomer: number;
  deactivated: number;
  withGps: number;
  heldReasons: Record<string, number>;
  detail: string;
};

/** The Rating values that assert somebody has traded with this shop. */
const VALUE_BANDS = /(high|medium|low)\s+value/i;

/**
 * Evidence of a purchase, gathered from the Activity log by shop name.
 *
 * Keyed on the same normalisation `partyNameKey` uses, in SQL, because the
 * join is between two free-text columns and doing it in JavaScript would mean
 * pulling 33,000 rows across to answer a question Postgres can group.
 */
type Evidence = {
  paymentCollection: boolean;
  customerStage: boolean;
  visits: number;
  lastVisit: string | null;
};

async function gatherEvidence(): Promise<Map<string, Evidence>> {
  const rows = await db.execute<{
    key: string;
    payment: boolean;
    stage: boolean;
    visits: number;
    last_visit: string | null;
  }>(sql`
    select btrim(regexp_replace(upper(customer_name), '[^A-Z0-9]+', ' ', 'g')) as key,
           bool_or(meeting_purpose ilike '%payment%') as payment,
           bool_or(
             stage_label ilike '%First-Time Customer%'
             or stage_label ilike '%Repeat Customer%'
             or stage_label ilike '%Inactive Customer%'
           ) as stage,
           count(*)::int as visits,
           max(visit_date)::text as last_visit
      from sheet_field_activity_rows
     where status = 'present'
       and nullif(btrim(customer_name), '') is not null
     group by 1
  `);

  const out = new Map<string, Evidence>();
  for (const r of rows) {
    out.set(r.key, {
      paymentCollection: Boolean(r.payment),
      customerStage: Boolean(r.stage),
      visits: Number(r.visits),
      lastVisit: r.last_visit,
    });
  }
  return out;
}

/** Coordinates, from the GPS pin export, by the same folded name. */
async function gatherPins(): Promise<Map<string, { lat: number; lng: number }>> {
  const rows = await db.execute<{ key: string; lat: number; lng: number }>(sql`
    select btrim(regexp_replace(upper(name), '[^A-Z0-9]+', ' ', 'g')) as key,
           avg(lat)::double precision as lat,
           avg(lng)::double precision as lng
      from field_customer_pins
     where lat is not null and lng is not null
     group by 1
  `);
  const out = new Map<string, { lat: number; lng: number }>();
  for (const r of rows) out.set(r.key, { lat: Number(r.lat), lng: Number(r.lng) });
  return out;
}

/**
 * The same fold the staging table's `name_key` uses, but stripping punctuation
 * too — `K. RAMSING SALES` and `K RAMSING SALES` are one shop, and the
 * Activity log and the master spell the same name both ways.
 */
const foldHard = (name: string) =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

export async function projectCustomerMaster(
  options: ProjectionOptions = {},
): Promise<ProjectionResult> {
  const dryRun = options.dryRun ?? false;

  const staged = await db
    .select()
    .from(sheetCustomerMasterRows)
    .where(eq(sheetCustomerMasterRows.status, "present"));

  const evidence = await gatherEvidence();
  const pins = await gatherPins();

  // Every existing customer, folded, so a shop already in MahekOne is UPDATED
  // rather than duplicated. Two reads of "who are our customers" is how two
  // screens come to disagree about one; two WRITES of it is worse.
  const existing = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers);
  const existingByKey = new Map<string, string>();
  for (const c of existing) {
    const k = foldHard(c.name);
    if (!existingByKey.has(k)) existingByKey.set(k, c.id);
  }

  const result: ProjectionResult = {
    considered: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    asLead: 0,
    asCustomer: 0,
    deactivated: 0,
    withGps: 0,
    heldReasons: {},
    detail: "",
  };

  const hold = (reason: string) => {
    result.skipped++;
    result.heldReasons[reason] = (result.heldReasons[reason] ?? 0) + 1;
  };

  for (const row of staged) {
    result.considered++;

    const key = foldHard(row.customerName);
    const ev = evidence.get(key);

    if (options.visitedSince) {
      if (!ev?.lastVisit || ev.lastVisit < options.visitedSince) {
        hold(`not visited since ${options.visitedSince}`);
        continue;
      }
    }

    // `customers.phone` is NOT NULL and a shop nobody can ring is not a lead,
    // it is a note. Held rather than filled with something invented.
    if (!row.mobile) {
      hold("no usable mobile number");
      continue;
    }

    // `customers.city` is NOT NULL. The state is a poor city and a better
    // nothing — a record placed in the wrong town is worse than one held.
    const city = row.locationText ?? row.state;
    if (!city) {
      hold("no town");
      continue;
    }

    const reasons: string[] = [];
    if (ev?.paymentCollection) reasons.push("a payment was collected from this shop");
    if (ev?.customerStage) reasons.push("the old app filed it at a customer stage");
    if (row.rating && VALUE_BANDS.test(row.rating)) {
      reasons.push(`rated "${row.rating}", which is a judgement about trade`);
    }

    const kind: "lead" | "customer" = reasons.length ? "customer" : "lead";
    if (!reasons.length) reasons.push("no evidence of any order — a lead by definition");

    const sheetStatus = readSheetStatus(row.sheetStatus);
    const status: "active" | "deactivated" =
      sheetStatus === "deactive" ? "deactivated" : "active";
    if (status === "deactivated") {
      reasons.push("the sheet marks it Deactive — a decision somebody made");
    }

    const pin = pins.get(key);
    if (pin) reasons.push("coordinates from the field pin export");

    if (kind === "lead") result.asLead++;
    else result.asCustomer++;
    if (status === "deactivated") result.deactivated++;
    if (pin) result.withGps++;

    const existingId = existingByKey.get(key);

    /*
     * Counted HERE rather than inside the write, so a dry run reports the one
     * thing it exists to report. Incrementing these only where the row is
     * actually written made `--dry-run` answer "0 created, 0 enriched" for a
     * run that would have created three thousand customers — a review that
     * cannot be wrong because it says nothing.
     */
    if (existingId) result.updated++;
    else {
      result.created++;
      // Claimed even on a dry run. `foldHard` strips punctuation, so
      // "K. RAMSING SALES" and "K RAMSING SALES" are two staging rows and one
      // shop — without this the dry run counts the second as a second
      // creation and overstates exactly the number somebody is reviewing.
      if (dryRun) existingByKey.set(key, "(dry-run)");
    }

    if (!dryRun) {
      let customerId: string;

      if (existingId) {
        /*
         * An account MahekOne already holds is enriched, never re-kinded.
         * The record here may already have orders, a cycle, a debt and a
         * reassignment behind it, and this sheet knows about none of that —
         * so `kind`, `status`, both manager seats and every derived cache are
         * left exactly as they are. What a shop master can honestly add to a
         * record that already exists is contact detail nobody had.
         */
        await db
          .update(customers)
          .set({
            phone: sql`coalesce(nullif(${customers.phone}, ''), ${row.mobile})`,
            altPhone: sql`coalesce(${customers.altPhone}, ${row.altMobile})`,
            address: sql`coalesce(${customers.address}, ${row.address})`,
            gpsLat: pin ? sql`coalesce(${customers.gpsLat}, ${pin.lat})` : undefined,
            gpsLng: pin ? sql`coalesce(${customers.gpsLng}, ${pin.lng})` : undefined,
            updatedAt: new Date(),
          })
          .where(eq(customers.id, existingId));
        customerId = existingId;
      } else {
        customerId = `cus_${randomUUID().slice(0, 12)}`;
        await db.insert(customers).values({
          id: customerId,
          name: row.customerName,
          phone: row.mobile,
          altPhone: row.altMobile,
          address: row.address,
          city,
          region: row.state,
          kind,
          status,
          // Where these came from, permanently and on the row itself. The
          // staging table records it too, but a lead source is what somebody
          // reads on the customer's own screen.
          /* SHORT, because it is rendered in a 140px table column and the
           * long form ("Mahek EMP 2.0 shop master") was clipped to nothing
           * useful. A source is a label somebody scans, not a sentence. */
          leadSource: kind === "lead" ? "Mahek EMP 2.0" : null,
          gpsLat: pin?.lat,
          gpsLng: pin?.lng,
          // ownerId is deliberately null. On an imported book it would be
          // whoever ran the import — one person on five thousand rows — and
          // every scoped list would then read as their book. Unassigned is
          // said in words on a team list; a false owner is not said at all.
        });
        existingByKey.set(key, customerId);
      }

      await db
        .update(sheetCustomerMasterRows)
        .set({
          matchedCustomerId: customerId,
          customerMatchStatus: "matched",
          resolvedKind: kind,
          resolvedStatus: status,
          evidence: reasons,
          projectedCustomerId: customerId,
          projectedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sheetCustomerMasterRows.id, row.id));
    }
  }

  const held = Object.entries(result.heldReasons)
    .map(([r, n]) => `${n} ${r}`)
    .join("; ");
  result.detail =
    `${result.considered} shops considered — ` +
    `${result.created} created, ${result.updated} enriched, ${result.skipped} held` +
    (held ? ` (${held})` : "") +
    `; ${result.asLead} leads, ${result.asCustomer} customers, ` +
    `${result.deactivated} deactivated, ${result.withGps} with coordinates` +
    (dryRun ? " — DRY RUN, nothing written" : "");

  return result;
}

/** Kept for the caller that wants only the recently-worked shops. */
export const RECENTLY_VISITED_WINDOW_DAYS = 365;

export function visitedSinceDate(days = RECENTLY_VISITED_WINDOW_DAYS): string {
  // Named zone, never a bare local getter — a date derived from an instant
  // that does not name its zone is the same bug in different clothes.
  const now = new Date();
  const shifted = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE }).format(shifted);
}
