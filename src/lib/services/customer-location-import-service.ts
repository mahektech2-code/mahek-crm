import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { fieldCustomerPins, users } from "@/db/schema";
import { parseCsv } from "@/lib/csv";
import {
  isBlankCustomerLocationRow,
  parseCustomerLocationRow,
  type ParsedCustomerLocationRow,
} from "@/lib/customer-location-parse";
import { matchSalesmanName, type MatchResult } from "@/lib/field-activity-match";
import { shopNameMatcher } from "./shop-name-match-service";
import { hashRow, newSyncId, WRITE_BATCH } from "./sheet-sync-core";

/* ---------------------------------------------------------------------------
 * Landing a third-party field-tracking app's one-time customer/shop export
 * into `field_customer_pins` — parsing, matching and staging, no live-sheet
 * machinery (no `sheet_sync_runs`, no watermark). Matching reuses the exact
 * technique `field-activity-sync-service.ts` already uses against the same
 * `customers` table, because a shop name matched against a book of real
 * customers is the same question in both places.
 *
 * `rowHash` is the whole raw row and IS the identity — there is no ID column
 * in the source. An identical re-import is a no-op; a row whose cells
 * genuinely changed lands as a NEW row rather than an update, because there
 * is nothing to key an update on. What DOES get refreshed on every run,
 * whatever the hash, is the match: a name unmatched on the first pass may
 * match a customer created since, so every row is re-matched every time.
 * ------------------------------------------------------------------------- */

export type CustomerLocationImportOutcome = {
  rowsRead: number;
  rowsCreated: number;
  rowsUnchanged: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  withIssues: number;
  detail: string;
};

function toRow(
  cells: Record<string, string>,
  parsed: ParsedCustomerLocationRow,
  hash: string,
  addedBy: MatchResult,
  customer: MatchResult,
): typeof fieldCustomerPins.$inferInsert {
  return {
    id: newSyncId("fcpin"),
    rowHash: hash,
    raw: cells,

    name: parsed.name,
    printAs: parsed.printAs,
    locationText: parsed.locationText,
    territory: parsed.territory,
    industryLabel: parsed.industryLabel,
    address: parsed.address,

    lat: parsed.lat,
    lng: parsed.lng,

    sourceAddedByName: parsed.sourceAddedByName,
    sourceAddedAt: parsed.sourceAddedAt,
    sourceUpdatedByName: parsed.sourceUpdatedByName,
    sourceUpdatedAt: parsed.sourceUpdatedAt,

    addedByUserId: addedBy.matchedId,
    addedByMatchStatus: addedBy.status,

    matchedCustomerId: customer.matchedId,
    customerMatchStatus: customer.status,
    matchNote: customer.note,

    issues: parsed.issues,
    updatedAt: new Date(),
  };
}

/**
 * Every non-identity, non-permanent column — refreshed on every upsert.
 * `id`, `rowHash`, `raw`, `createdAt` never change once written, and
 * `gpsAppliedAt` is deliberately excluded: a re-import must not forget that a
 * pin's coordinates already reached its customer just because the row it was
 * read from happened to be seen again.
 */
const REFRESH_COLUMNS = [
  "name", "printAs", "locationText", "territory", "industryLabel", "address",
  "lat", "lng",
  "sourceAddedByName", "sourceAddedAt", "sourceUpdatedByName", "sourceUpdatedAt",
  "addedByUserId", "addedByMatchStatus",
  "matchedCustomerId", "customerMatchStatus", "matchNote",
  "issues", "updatedAt",
] as const;

const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function upsertColumns() {
  const set: Record<string, unknown> = {};
  for (const column of REFRESH_COLUMNS) set[column] = sql.raw(`excluded.${toSnake(column)}`);
  return set;
}

/** Reads the whole CSV text, parses, matches and stages every row. */
export async function importCustomerLocationsCsv(
  csvText: string,
): Promise<CustomerLocationImportOutcome> {
  const records = parseCsv(csvText).filter((cells) => !isBlankCustomerLocationRow(cells));
  const salesmen = await db.select({ id: users.id, name: users.name }).from(users);
  // Exact name or a person's decision only — a pin on the wrong shop is a
  // shop every later check-in is refused at.
  const matcher = await shopNameMatcher();

  let created = 0;
  let unchanged = 0;
  let matched = 0;
  let ambiguous = 0;
  let unmatched = 0;
  let withIssues = 0;

  for (let i = 0; i < records.length; i += WRITE_BATCH) {
    const slice = records.slice(i, i + WRITE_BATCH);
    const prepared = slice.map((cells) => ({
      cells,
      parsed: parseCustomerLocationRow(cells),
      hash: hashRow(cells),
    }));

    const hashes = prepared.map((p) => p.hash);
    const existing = await db
      .select({ rowHash: fieldCustomerPins.rowHash })
      .from(fieldCustomerPins)
      .where(inArray(fieldCustomerPins.rowHash, hashes));
    const known = new Set(existing.map((e) => e.rowHash));

    const rows: (typeof fieldCustomerPins.$inferInsert)[] = [];
    for (const { cells, parsed, hash } of prepared) {
      if (known.has(hash)) unchanged++;
      else created++;
      if (parsed.issues.length) withIssues++;

      const addedBy = matchSalesmanName(parsed.sourceAddedByName, salesmen);
      const customer = await matcher.match(parsed.name);
      if (customer.status === "matched") matched++;
      else if (customer.status === "ambiguous") ambiguous++;
      else unmatched++;

      rows.push(toRow(cells, parsed, hash, addedBy, customer));
    }

    if (rows.length) {
      await db
        .insert(fieldCustomerPins)
        .values(rows)
        .onConflictDoUpdate({ target: fieldCustomerPins.rowHash, set: upsertColumns() });
    }
  }

  const detail =
    `${records.length} read: ${created} new, ${unchanged} unchanged. ` +
    `Customer match — ${matched} matched, ${ambiguous} ambiguous, ${unmatched} unmatched` +
    (withIssues ? `, ${withIssues} with issues` : "");

  return {
    rowsRead: records.length,
    rowsCreated: created,
    rowsUnchanged: unchanged,
    matched,
    ambiguous,
    unmatched,
    withIssues,
    detail,
  };
}

export type ApplyGpsOutcome = { applied: number };

/**
 * Writes coordinates from every confidently-matched, not-yet-applied pin
 * onto its customer — the one step in this pipeline that touches `customers`
 * at all. `gps_lat IS NULL` on the customer is the guard that keeps a real
 * MBOS-captured fix from ever being overwritten by this import, on this run
 * or any later one.
 */
export async function applyMatchedGps(): Promise<ApplyGpsOutcome> {
  return db.transaction(async (tx) => {
    const applied = await tx.execute<{ id: string }>(sql`
      update customers c
         set gps_lat = p.lat,
             gps_lng = p.lng,
             gps_captured_at = coalesce(p.source_added_at, now())
        from field_customer_pins p
       where p.matched_customer_id = c.id
         and p.customer_match_status = 'matched'
         and p.lat is not null and p.lng is not null
         and p.gps_applied_at is null
         and c.gps_lat is null and c.gps_lng is null
      returning p.id
    `);
    const pinIds = applied.map((r) => r.id);
    if (pinIds.length) {
      await tx
        .update(fieldCustomerPins)
        .set({ gpsAppliedAt: new Date(), updatedAt: new Date() })
        .where(inArray(fieldCustomerPins.id, pinIds));
    }
    return { applied: pinIds.length };
  });
}
