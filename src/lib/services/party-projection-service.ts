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

/**
 * Why a customer is closed, when the customer master is what closed them.
 * Kept as a marker so a later sync can reopen what it shut, and only that.
 */
const DEACTIVATED_BY_MASTER = "Marked Deactive on the customer master";

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
      status: customers.status,
      deactivatedAt: customers.deactivatedAt,
      deactivationReason: customers.deactivationReason,
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

    // "Deactive" on the master is the business saying stop — which is
    // `deactivated`, not `inactive`.
    //
    // Those two words are nearly synonyms in English and opposites here.
    // `inactive` means a customer has gone quiet, and the queue keeps them on
    // purpose: winning them back is the one thing you must still be able to do
    // (queue-service.ts says so where it filters). `deactivated` is the one
    // that means stop, and it is what leaves the queue.
    //
    // Mapping Deactive to `inactive` put 133 closed accounts into telecallers'
    // call logs and made them look like win-back opportunities.
    const deactive = party.partyStatus?.trim().toLowerCase() === "deactive";
    if (deactive) report.deactivated++;

    if (options.dryRun) continue;

    updates.push({ id: customer.id, values: {
        ...(fillPhone ? { phone: party.mobileNo! } : {}),
        ...(fillWhatsapp ? { whatsappPhone: party.whatsappNo! } : {}),
        ...(salesId ? { salesAmId: salesId } : {}),
        // The NAME lands whether or not it matched an account, because the
        // name is what the screens say. Linking is a separate question and it
        // fails for most of these rows by design — see the header.
        ...(party.salesPersonName ? { salesPersonName: party.salesPersonName } : {}),
        ...(backId ? { backOfficeAmId: backId } : {}),
        // And the same for the back office, for the same reason. This line was
        // missing, so a back office name that matched no account was read,
        // counted as unlinked, and then thrown away — leaving every screen
        // saying "Unassigned" against a customer the sheet names somebody for.
        ...(party.backOfficeName ? { backOfficeName: party.backOfficeName } : {}),
        ...(party.gstNumber && !customer.gstin ? { gstin: party.gstNumber } : {}),
        ...(party.creditDays !== null
          ? { creditTermDays: party.creditDays, creditDays: party.creditDays }
          : {}),
        ...(party.area ? { city: party.area } : {}),
        ...(party.state ? { region: party.state } : {}),
        ...(party.counterType ? { leadSource: party.counterType } : {}),
        ...(deactive
          ? {
              status: "deactivated" as const,
              deactivatedAt: customer.deactivatedAt ?? new Date(),
              deactivationReason: DEACTIVATED_BY_MASTER,
            }
          : // Reactivate only what this import closed. A customer somebody
            // deactivated inside the CRM stays deactivated whatever the
            // spreadsheet says, and `inactive` is the inactivity engine's to
            // set and clear — not a sync's.
            customer.deactivationReason === DEACTIVATED_BY_MASTER
            ? {
                status: "active" as const,
                deactivatedAt: null,
                deactivationReason: null,
              }
            : {}),
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
          ? "deactivated"
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
