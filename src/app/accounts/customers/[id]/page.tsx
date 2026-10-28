import { notFound } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { erpCustomerProfiles, sheetPartyRows } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { assertCustomerInScope, canFor, NotPermittedError } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { getCustomer, listAmChanges, listBackOfficeCandidates, salesManagerSuggestions, today } from "@/lib/queries";
import { customerStatusLabel } from "@/lib/format";
import { sheetKeys } from "@/lib/customer-rename";
import { deliveryAddressesFor, distributorsFor } from "@/lib/services/distributor-service";
import { listCustomerContacts } from "@/lib/services/customer-contact-service";
import type { Row } from "@/components/customers/customers-screen";
import { CustomerRecord } from "./customer-record";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await getCustomer(id);
  return { title: `${c?.name ?? "Customer"} — Accounts — MahekOne` };
}

/**
 * ONE CUSTOMER, WHOLE, on the Accounts side — the desk that keeps the record.
 *
 * Accounts users are redirected out of the CRM, so the CRM's record page was
 * never theirs, and the ledger shows money and nothing else. This page shows
 * everything MahekOne holds about the party — identity, contacts, address,
 * commercial terms, the ERP's dispatch profile, the seats and their history,
 * the delivery chain and what the Sales Party sheet says — and every edit runs
 * through the same form, actions and checks as the customers list.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const customer = await getCustomer(id);
  if (!customer) notFound();
  try {
    await assertCustomerInScope(customer);
  } catch (e) {
    if (e instanceof NotPermittedError) notFound();
    throw e;
  }

  const keys = sheetKeys(customer);
  const [config, day, contacts, distributors, deliveryAddresses, amChanges, people, suggestions, profileRows, sheetRows] = await Promise.all([
    getConfig(),
    today(),
    listCustomerContacts(id),
    distributorsFor(id),
    deliveryAddressesFor(id),
    listAmChanges(id),
    listBackOfficeCandidates(),
    salesManagerSuggestions(),
    db.select().from(erpCustomerProfiles).where(eq(erpCustomerProfiles.customerId, id)),
    keys.length ? db.select({ raw: sheetPartyRows.raw, status: sheetPartyRows.status }).from(sheetPartyRows).where(inArray(sheetPartyRows.partyKey, keys)) : Promise.resolve([]),
  ]);
  const profile = profileRows[0] ?? null;
  const sheet = sheetRows.find((r) => r.status === "present") ?? sheetRows[0] ?? null;

  /* The list row the edit form opens with — the seats and the few fields the form keeps on the row. */
  const row = {
    id: customer.id,
    name: customer.name,
    contactPerson: customer.contactPerson,
    phone: customer.phone,
    city: customer.city,
    place: customer.place ?? null,
    ownerId: customer.ownerId,
    salesAmId: customer.salesAmId,
    amDecidedAt: customer.amDecidedAt,
    ownerName: customer.ownerName,
    kind: customer.kind,
    leadSource: customer.leadSource,
    salesAmName: customer.salesAmName,
    salesManagerName: customer.salesManagerName,
    salesManagerId: customer.salesManagerId,
    backOfficeAmId: customer.backOfficeAmId,
    backOfficeAmName: customer.backOfficeAmName,
    status: customer.status,
    lastOrderDate: customer.lastOrderDate,
    lastContactAt: null,
    outstanding: Number(customer.outstanding),
    slowPayer: customer.slowPayer,
    openComplaints: 0,
    gstin: customer.gstin,
    creditTermDays: customer.creditTermDays,
    cycleDays: customer.cycleDays,
    route: customer.route,
    deactivationRequested: customer.deactivationRequested,
    thirdParty: customer.thirdParty,
    deliveredOrders: 0,
    servedShops: 0,
    reactivationRequested: customer.reactivationRequested,
    reactivationReason: customer.reactivationReason,
    nextStep: customer.nextStep,
  } satisfies Row;

  return (
    <CustomerRecord
      row={row}
      record={{
        statusLabel: customerStatusLabel(customer),
        externalCode: customer.externalCode,
        sheetName: customer.sheetName,
        dealerCode: customer.dealerCode,
        companyName: customer.companyName,
        customerType: customer.customerType,
        customerSince: customer.customerSince,
        email: customer.email,
        potential: customer.potential,
        potentialMonthlyPaise: customer.potentialMonthlyPaise === null ? null : Number(customer.potentialMonthlyPaise),
        rating: customer.rating,
        segmentation: customer.segmentation,
        taggedEmployeeName: customer.taggedEmployeeName,
        specialInstructions: customer.specialInstructions,
        doNotContact: customer.doNotContact,
        whatsappDest: customer.whatsappDest,
        whatsappGroupName: customer.whatsappGroupName,
        whatsappDnd: customer.whatsappDnd,
        whatsappDndReason: customer.whatsappDndReason,
        address: customer.address,
        region: customer.region,
        area: customer.area,
        beat: customer.beat,
        territoryRegion: customer.territoryRegion,
        visitFrequencyDays: customer.visitFrequencyDays,
        gpsPinned: customer.gpsLat !== null,
        gstVerified: customer.gstVerified,
        creditLimitPaise: customer.creditLimitPaise === null ? null : Number(customer.creditLimitPaise),
        creditBlocked: customer.creditBlocked,
        creditBlockReason: customer.creditBlockReason,
        priceTag: customer.priceTag,
        freightTerm: customer.freightTerm,
        deliveryType: customer.deliveryType,
        relationshipOwnerName: customer.relationshipOwnerName,
        deactivationReason: customer.deactivationReason,
        lastOrderValue: customer.lastOrderValue === null ? null : Number(customer.lastOrderValue),
        avgOrderValue: customer.avgOrderValue === null ? null : Number(customer.avgOrderValue),
        cycleIsDefault: customer.cycleIsDefault,
        lastContactDate: customer.lastContactDate,
        healthScore: customer.healthScore,
        createdAt: customer.createdAt.toISOString(),
      }}
      profile={
        profile
          ? {
              transporter: profile.transporter,
              weightType: profile.weightType,
              segment: profile.segment,
              grade: profile.grade,
              counterTypes: profile.counterTypes,
              standingInstructions: profile.standingInstructions,
              allocateEmail: profile.allocateEmail,
              pendingActivation: profile.pendingActivation,
            }
          : null
      }
      sheet={sheet ? Object.entries((sheet.raw ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "").trim()] as [string, string]).filter(([, v]) => v) : null}
      contacts={contacts}
      distributors={distributors}
      deliveryAddresses={deliveryAddresses}
      amChanges={amChanges.map((c) => ({ id: c.id, role: c.role, fromName: c.fromName, toName: c.toName, reasonCode: c.reasonCode, note: c.note, changedBy: c.changedBy, changedAt: c.changedAt instanceof Date ? c.changedAt.toISOString() : String(c.changedAt) }))}
      businessDay={day}
      birthdayHeadsUpDays={config["customers.birthdayHeadsUpDays"]}
      people={people}
      salesManagerSuggestions={suggestions}
      amReasons={config["people.amChangeReasons"]}
      canClassify={await canFor(user, "customer.classify")}
      canReassign={await canFor(user, "customer.reassign")}
      canAssignSalesManager={await canFor(user, "customer.assignSalesManager")}
    />
  );
}
