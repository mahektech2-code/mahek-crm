import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers, erpCustomerProfiles, erpRefValues, sheetPartyRows } from "@/db/schema";
import { partyNameKey } from "@/lib/sheet-parse";
import { erpId } from "./server";

/* ---------------------------------------------------------------------------
 * The ERP customer profile starts from what the Sales Party sheet already
 * says — transporter, grade, weight type, standing instructions, counter
 * types, the party's own status — rather than from nothing (spec §4.4).
 *
 * Matched on the SAME name key the party projection uses, so a customer the
 * CRM matched to a sheet row is the customer this matches too. It fills
 * BLANKS only: a value somebody has set in the ERP is a decision, and a re-run
 * must never put the sheet's older answer back over it. Idempotent.
 *
 * It also seeds the open reference lists with the values the sheet actually
 * uses, because an empty "Transporter" list on day one is a form nobody can
 * fill in.
 * ------------------------------------------------------------------------- */

export async function seedErpCustomerProfiles(): Promise<{ matched: number; created: number; filled: number; refAdded: number }> {
  const parties = await db.select().from(sheetPartyRows).where(eq(sheetPartyRows.status, "present"));
  const all = await db.select({ id: customers.id, name: customers.name }).from(customers);
  const byKey = new Map(all.map((c) => [partyNameKey(c.name), c.id]));
  const existing = new Map(
    (await db.select().from(erpCustomerProfiles)).map((p) => [p.customerId, p]),
  );

  let matched = 0;
  let created = 0;
  let filled = 0;
  for (const p of parties) {
    const customerId = byKey.get(p.partyKey);
    if (!customerId) continue;
    matched++;
    const counters = (p.counterType ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const fromSheet = {
      state: p.state,
      transporter: p.transportDetail,
      weightType: p.weightType,
      segment: p.segment,
      grade: p.grade,
      standingInstructions: p.standingInstructions,
      allocateEmail: p.allocateEmail,
      monthlyTargetPaise: p.monthlyTargetPaise,
      pendingActivation: (p.partyStatus ?? "").trim().toLowerCase() === "pending",
    };
    const have = existing.get(customerId);
    if (!have) {
      await db.insert(erpCustomerProfiles).values({ customerId, ...fromSheet, counterTypes: counters }).onConflictDoNothing();
      created++;
      continue;
    }
    const patch: Record<string, unknown> = {};
    (Object.keys(fromSheet) as (keyof typeof fromSheet)[]).forEach((k) => {
      if (k === "pendingActivation") return;
      if ((have[k] == null || have[k] === "") && fromSheet[k] != null && fromSheet[k] !== "") patch[k] = fromSheet[k];
    });
    if (have.counterTypes.length === 0 && counters.length) patch.counterTypes = counters;
    if (Object.keys(patch).length) {
      await db.update(erpCustomerProfiles).set({ ...patch, updatedAt: new Date() }).where(eq(erpCustomerProfiles.customerId, customerId));
      filled++;
    }
  }

  /* The open lists, from what the sheet uses. */
  const lists: [string, (string | null)[]][] = [
    ["area", parties.map((p) => p.area)],
    ["state", parties.map((p) => p.state)],
    ["transporter", parties.map((p) => p.transportDetail)],
    ["segment", parties.map((p) => p.segment)],
    ["counterType", parties.flatMap((p) => (p.counterType ?? "").split(","))],
  ];
  let refAdded = 0;
  for (const [listKey, raw] of lists) {
    const values = Array.from(new Set(raw.map((v) => (v ?? "").trim()).filter(Boolean))).sort();
    for (const value of values) {
      const res = await db
        .insert(erpRefValues)
        .values({ id: erpId("erprv"), listKey, value })
        .onConflictDoNothing()
        .returning({ id: erpRefValues.id });
      refAdded += res.length;
    }
  }
  return { matched, created, filled, refAdded };
}
