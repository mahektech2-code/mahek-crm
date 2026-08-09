import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { randomUUID } from "node:crypto";
import { customers, sheetPartyRows, users } from "@/db/schema";
import { partyNameKey } from "@/lib/sheet-parse";

/* ---------------------------------------------------------------------------
 * The customer master → the customers the CRM already has.
 *
 * The order sheet created 557 customers with no way to reach any of them. This
 * is where they get a phone number, a WhatsApp number, a sales rep, a back
 * office owner, a credit term and a GSTIN.
 *
 * The join is the party name, which the two sheets spell identically: 555 of
 * the 557 match. That is a fact worth stating rather than assuming, and the
 * projection reports the misses instead of quietly covering half the book.
 *
 * Two rules it holds to:
 *
 *   THE SHEET DOES NOT OVERWRITE A PERSON. A phone number typed into the CRM
 *   by a telecaller who rang and got a better one is theirs. The sheet fills
 *   what is EMPTY and refreshes what it already owns; it does not reach in and
 *   correct somebody who was actually on the call.
 *
 *   A NAME IS NOT AN ACCOUNT. Sales Person and Tag Sales Person hold real
 *   people, most of whom have never signed in to MahekOne. Where a name
 *   matches a user it is linked; where it does not, the name is still recorded
 *   on the imported row and the link stays null. Inventing a user to satisfy a
 *   foreign key would put somebody's name on work they cannot see.
 * ------------------------------------------------------------------------- */

export type PartyProjectionReport = {
  matched: number;
  unmatchedParties: number;
  unmatchedCustomers: string[];
  phonesFilled: number;
  whatsappFilled: number;
  salesRepLinked: number;
  backOfficeLinked: number;
  /** Named on a row but holding no MahekOne account. */
  unlinkedPeople: string[];
  deactivated: number;
  leadsAvailable: number;
  leadsCreated: number;
};

export type PartyProjectionOptions = {
  /**
   * Create the parties who have never ordered as leads.
   *
   * Off by default. Roughly half this list has never bought anything, and
   * turning 600-odd rows into leads puts them on somebody's calling list —
   * which is a decision about how a team spends its week, not a consequence of
   * importing a spreadsheet.
   */
  createLeads?: boolean;
  /** Who unowned leads answer to, when they are created at all. */
  leadOwnerId?: string | null;
  dryRun?: boolean;
};

const normal = (s: string | null) => (s ? s.trim().toLowerCase() : null);

export async function projectParties(
  options: PartyProjectionOptions = {},
): Promise<PartyProjectionReport> {
  const parties = await db
    .select()
    .from(sheetPartyRows)
    .where(eq(sheetPartyRows.status, "present"));

  const existing = await db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      whatsappPhone: customers.whatsappPhone,
      salesAmId: customers.salesAmId,
      backOfficeAmId: customers.backOfficeAmId,
      gstin: customers.gstin,
      kind: customers.kind,
    })
    .from(customers);
  const byKey = new Map(existing.map((c) => [partyNameKey(c.name), c]));

  // People named on the sheet, matched to accounts by name where one exists.
  const team = await db.select({ id: users.id, name: users.name }).from(users);
  const userByName = new Map(team.map((u) => [normal(u.name)!, u.id]));

  const report: PartyProjectionReport = {
    matched: 0,
    unmatchedParties: 0,
    unmatchedCustomers: [],
    phonesFilled: 0,
    whatsappFilled: 0,
    salesRepLinked: 0,
    backOfficeLinked: 0,
    unlinkedPeople: [],
    deactivated: 0,
    leadsAvailable: 0,
    leadsCreated: 0,
  };

  const updates: { id: string; values: Partial<typeof customers.$inferInsert> }[] = [];
  const unlinked = new Set<string>();
  const seen = new Set<string>();

  for (const party of parties) {
    const customer = byKey.get(party.partyKey);
    if (!customer) {
      report.unmatchedParties++;
      report.leadsAvailable++;
      continue;
    }
    seen.add(party.partyKey);
    report.matched++;

    const salesId = party.salesPersonName
      ? userByName.get(normal(party.salesPersonName)!)
      : undefined;
    const backId = party.backOfficeName
      ? userByName.get(normal(party.backOfficeName)!)
      : undefined;
    if (party.salesPersonName && !salesId) unlinked.add(party.salesPersonName);
    if (party.backOfficeName && !backId) unlinked.add(party.backOfficeName);
    if (salesId) report.salesRepLinked++;
    if (backId) report.backOfficeLinked++;

    // Only ever fills a blank. A number somebody typed after speaking to the
    // customer beats a number a spreadsheet has not been asked about.
    const fillPhone = !customer.phone.trim() && party.mobileNo;
    const fillWhatsapp = !customer.whatsappPhone?.trim() && party.whatsappNo;
    if (fillPhone) report.phonesFilled++;
    if (fillWhatsapp) report.whatsappFilled++;

    // "Deactive" on the master is the business saying stop, which is a status
    // change and never a deletion.
    const deactive = party.partyStatus?.trim().toLowerCase() === "deactive";
    if (deactive) report.deactivated++;

    if (options.dryRun) continue;

    updates.push({ id: customer.id, values: {
        ...(fillPhone ? { phone: party.mobileNo! } : {}),
        ...(fillWhatsapp ? { whatsappPhone: party.whatsappNo! } : {}),
        ...(salesId ? { salesAmId: salesId } : {}),
        ...(backId ? { backOfficeAmId: backId } : {}),
        ...(party.gstNumber && !customer.gstin ? { gstin: party.gstNumber } : {}),
        ...(party.creditDays !== null
          ? { creditTermDays: party.creditDays, creditDays: party.creditDays }
          : {}),
        ...(party.area ? { city: party.area } : {}),
        ...(party.state ? { region: party.state } : {}),
        ...(party.counterType ? { leadSource: party.counterType } : {}),
        ...(deactive ? { status: "inactive" as const } : {}),
        updatedAt: new Date(),
      } });
  }

  // Written in flights rather than one at a time: 555 sequential round trips
  // to a hosted database is most of a minute for work that takes seconds.
  for (let i = 0; i < updates.length; i += 100) {
    await Promise.all(
      updates.slice(i, i + 100).map((u) =>
        db.update(customers).set(u.values).where(eq(customers.id, u.id)),
      ),
    );
  }

  // Customers the master does not mention. Reported rather than touched: a
  // customer who has ordered is real whatever a master list says.
  for (const [key, c] of byKey) {
    if (!seen.has(key) && c.kind === "customer") report.unmatchedCustomers.push(c.name);
  }

  report.unlinkedPeople = [...unlinked].sort();

  if (options.createLeads && !options.dryRun) {
    for (const party of parties) {
      if (byKey.has(party.partyKey)) continue;
      if (!party.mobileNo) continue; // a lead nobody can ring is not a lead
      await db.insert(customers).values({
        id: `cus_${randomUUID().slice(0, 12)}`,
        name: party.partyName,
        contactPerson: "",
        phone: party.mobileNo,
        whatsappPhone: party.whatsappNo,
        city: party.area ?? "",
        region: party.state,
        kind: "lead",
        leadSource: party.counterType ?? party.segment,
        status: party.partyStatus?.trim().toLowerCase() === "deactive"
          ? "inactive"
          : "active",
        gstin: party.gstNumber,
        creditTermDays: party.creditDays ?? 30,
        creditDays: party.creditDays,
        customerSince: party.sinceDate,
        ownerId: options.leadOwnerId ?? null,
      });
      report.leadsCreated++;
    }
  }

  return report;
}
