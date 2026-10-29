import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { customers, erpCustomerProfiles, erpRefValues, erpTransporters, sheetPartyRows } from "@/db/schema";
import { listedTransporter } from "./engines/lr-read";
import { sheetKeys } from "@/lib/customer-rename";
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
 * It never sets `pending_activation`: whether a party may be supplied is
 * Accounts' decision now (customers are opened only in Accounts), and the
 * sheet's "Pending" is an older answer to it. Email and company name land on
 * the customer itself, blanks only, and an email shared by three or more
 * parties is a placeholder and is skipped.
 *
 * It also seeds the open reference lists with the values the sheet actually
 * uses. Not the transporter: that is picked from the Transporters list, so the
 * sheet's "Transport Detail" fills the profile only where it IS a listed
 * transporter (as the list spells it) and is left blank where it is not —
 * the sheet does not get to add a fourth spelling of one company.
 * ------------------------------------------------------------------------- */

/** "Abc @gmail .com" → "abc@gmail.com"; null where what is left is not an address. */
export function sheetEmail(raw: string | null): string | null {
  const v = (raw ?? "").replace(/\s+/g, "").toLowerCase();
  return /^[^@]+@[^@]+\.[a-z]{2,}$/.test(v) ? v : null;
}

/**
 * An address on three or more parties is a placeholder or an office inbox, not
 * the party's own — found by counting, never by a literal, because the next
 * sheet will use a different placeholder (`flagSharedMobiles`' rule).
 */
export function sharedEmails(emails: (string | null)[]): Set<string> {
  const n = new Map<string, number>();
  for (const e of emails) if (e) n.set(e, (n.get(e) ?? 0) + 1);
  return new Set([...n].filter(([, c]) => c >= 3).map(([e]) => e));
}

export async function seedErpCustomerProfiles(): Promise<{ matched: number; created: number; filled: number; customersFilled: number; refAdded: number }> {
  const parties = await db.select().from(sheetPartyRows).where(eq(sheetPartyRows.status, "present"));
  const all = await db.select({ id: customers.id, name: customers.name, sheetName: customers.sheetName, email: customers.email, companyName: customers.companyName }).from(customers);
  const byId = new Map(all.map((c) => [c.id, c]));
  const shared = sharedEmails(parties.map((p) => sheetEmail(p.email)));
  let customersFilled = 0;
  // A renamed party is still found under the name the sheet uses.
  const byKey = new Map(all.flatMap((c) => sheetKeys(c).map((k) => [k, c.id] as const)));
  const carriers = (await db.select({ name: erpTransporters.name }).from(erpTransporters)).map((t) => t.name);
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
      transporter: p.transportDetail?.trim() ? listedTransporter(p.transportDetail, carriers).name : null,
      weightType: p.weightType,
      segment: p.segment,
      grade: p.grade,
      standingInstructions: p.standingInstructions,
      allocateEmail: p.allocateEmail,
    };
    /* The party's own email and legal name, onto the customer record — blanks only, like the profile. */
    const c = byId.get(customerId);
    const email = sheetEmail(p.email);
    const onCustomer: { email?: string; companyName?: string } = {};
    if (c && !c.email && email && !shared.has(email)) onCustomer.email = email;
    if (c && !c.companyName && p.companyName?.trim()) onCustomer.companyName = p.companyName.trim();
    if (Object.keys(onCustomer).length) {
      await db.update(customers).set(onCustomer).where(eq(customers.id, customerId));
      customersFilled++;
    }
    const have = existing.get(customerId);
    if (!have) {
      await db.insert(erpCustomerProfiles).values({ customerId, ...fromSheet, counterTypes: counters }).onConflictDoNothing();
      created++;
      continue;
    }
    const patch: Record<string, unknown> = {};
    (Object.keys(fromSheet) as (keyof typeof fromSheet)[]).forEach((k) => {
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
  return { matched, created, filled, customersFilled, refAdded };
}
