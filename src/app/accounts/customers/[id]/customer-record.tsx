"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { CustomerForm, saveCustomerEdit, type Row } from "@/components/customers/customers-screen";
import { CustomerContactsPanel } from "@/components/customers/customer-contacts-panel";
import { DeliveryRelations, type Relation } from "@/components/crm/delivery-relations";
import { longDate, money, stamp } from "@/lib/format";
import type { CustomerContact } from "@/lib/services/customer-contact-service";
import { seatLabel } from "@/lib/seat-labels";
import { ScreenHeader } from "../../parts";

type Record_ = {
  statusLabel: string;
  externalCode: string | null;
  sheetName: string | null;
  dealerCode: string | null;
  companyName: string | null;
  customerType: string | null;
  customerSince: string | null;
  email: string | null;
  potential: string | null;
  potentialMonthlyPaise: number | null;
  rating: string | null;
  segmentation: string | null;
  taggedEmployeeName: string | null;
  specialInstructions: string | null;
  doNotContact: boolean;
  whatsappDest: string;
  whatsappGroupName: string | null;
  whatsappDnd: boolean;
  whatsappDndReason: string | null;
  address: string | null;
  region: string | null;
  area: string | null;
  beat: string | null;
  territoryRegion: string | null;
  visitFrequencyDays: number | null;
  gpsPinned: boolean;
  gstVerified: boolean;
  creditLimitPaise: number | null;
  creditBlocked: boolean;
  creditBlockReason: string | null;
  priceTag: string | null;
  freightTerm: string | null;
  deliveryType: string | null;
  relationshipOwnerName: string | null;
  deactivationReason: string | null;
  lastOrderValue: number | null;
  avgOrderValue: number | null;
  cycleIsDefault: boolean;
  lastContactDate: string | null;
  healthScore: number | null;
  createdAt: string;
};

type Profile = {
  transporter: string | null;
  weightType: string | null;
  segment: string | null;
  grade: string | null;
  counterTypes: string[];
  standingInstructions: string | null;
  allocateEmail: string | null;
  pendingActivation: boolean;
};

type AmChange = {
  id: string;
  role: string;
  fromName: string | null;
  toName: string | null;
  reasonCode: string | null;
  note: string | null;
  changedBy: string | null;
  changedAt: string;
};

const FREIGHT_WORD: Record<string, string> = { paid: "Paid — built into the price", to_pay: "To pay — the shop pays on delivery" };
const WA_WORD: Record<string, string> = { personal: "Their own number", group: "A group", both: "Their number and a group" };

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-[6px] border border-line bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
        {action}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/** A label and its value; a blank value says so in words rather than leaving a hole. */
function Facts({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-[12px] text-muted">{label}</dt>
          <dd className="text-[13px] break-words whitespace-pre-line text-ink">
            {value === null || value === undefined || value === "" ? <span className="text-muted">Not stated</span> : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function CustomerRecord({
  row,
  record: r,
  profile,
  sheet,
  contacts,
  distributors,
  deliveryAddresses,
  amChanges,
  businessDay,
  birthdayHeadsUpDays,
  people,
  salesManagerSuggestions,
  amReasons,
  canClassify,
  canReassign,
  canAssignSalesManager,
}: {
  row: Row;
  record: Record_;
  profile: Profile | null;
  sheet: [string, string][] | null;
  contacts: CustomerContact[];
  distributors: Relation[];
  deliveryAddresses: Relation[];
  amChanges: AmChange[];
  businessDay: string;
  birthdayHeadsUpDays: number;
  people: Array<{ id: string; name: string; role?: string }>;
  salesManagerSuggestions: Record<string, string>;
  amReasons: string[];
  canClassify: boolean;
  canReassign: boolean;
  canAssignSalesManager: boolean;
}) {
  const router = useRouter();
  const { run } = useToast();
  const [editing, setEditing] = React.useState(false);
  const edit = (
    <Button variant="secondary" onClick={() => setEditing(true)}>
      Edit
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <ScreenHeader
        title={row.name}
        subtitle={[r.statusLabel, row.kind === "lead" ? "Lead" : row.thirdParty ? "Third-party customer" : "Direct customer", row.city].filter(Boolean).join(" · ")}
        actions={
          <>
            <Link href={`/accounts/ledger?customer=${row.id}`} className="inline-flex h-8 items-center rounded-[4px] border border-line px-3 text-[13px] text-ink hover:bg-canvas">
              Open account
            </Link>
            <Button variant="primary" onClick={() => setEditing(true)}>
              Edit details
            </Button>
          </>
        }
      />

      {r.creditBlocked ? (
        <div className="rounded-[4px] border border-danger-soft bg-danger-soft px-3 py-2 text-[13px] text-danger">Supply is stopped{r.creditBlockReason ? ` — ${r.creditBlockReason}` : ""}.</div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Details" action={edit}>
          <Facts
            items={[
              ["Customer code", r.externalCode],
              ["Dealer code", r.dealerCode],
              ["Company name", r.companyName],
              ["Name on the sheets", r.sheetName && r.sheetName !== row.name ? r.sheetName : null],
              ["Type of business", r.customerType],
              ["Customer since", r.customerSince ? longDate(r.customerSince) : null],
              ["Email", r.email],
              ["Potential", r.potential],
              ["Could buy a month", r.potentialMonthlyPaise === null ? null : money(r.potentialMonthlyPaise)],
              ["Rating", r.rating],
              ["Segment", r.segmentation],
              ["Tagged employee", r.taggedEmployeeName],
              ["Do not contact", r.doNotContact ? "Yes" : "No"],
              ["What to remember", r.specialInstructions],
              ["In MahekOne since", stamp(r.createdAt)],
            ]}
          />
        </Section>

        <Section title="Commercial" action={edit}>
          <Facts
            items={[
              ["GSTIN", row.gstin ? `${row.gstin}${r.gstVerified ? " · validated" : " · not validated"}` : null],
              ["Credit terms", `${row.creditTermDays} days`],
              ["Credit limit", r.creditLimitPaise === null ? "No limit" : money(r.creditLimitPaise)],
              ["Supply", r.creditBlocked ? "Stopped" : "Open"],
              ["Price list tag", r.priceTag],
              ["Freight", r.freightTerm ? (FREIGHT_WORD[r.freightTerm] ?? r.freightTerm) : null],
              ["Delivery", r.deliveryType],
            ]}
          />
        </Section>

        <Section title="Dispatch & ERP" action={edit}>
          <Facts
            items={[
              ["Transporter", profile?.transporter],
              ["Weight type", profile?.weightType],
              ["Party segment", profile?.segment],
              ["Grade", profile?.grade],
              ["Counter types", profile?.counterTypes.length ? profile.counterTypes.join(", ") : null],
              ["Allocate email", profile?.allocateEmail],
              ["Standing instructions", profile?.standingInstructions],
              ["ERP approval", profile?.pendingActivation ? "Waiting for approval" : "Approved"],
            ]}
          />
        </Section>

        <Section title="Address & area" action={edit}>
          <Facts
            items={[
              ["Address", r.address],
              ["City", row.city],
              ["State", r.region],
              ["Area", r.area],
              ["Beat", r.beat],
              ["Territory region", r.territoryRegion],
              ["Route", row.route],
              ["Visit every", r.visitFrequencyDays ? `${r.visitFrequencyDays} days` : null],
              ["Map pin", r.gpsPinned ? "Pinned from a visit" : "Not pinned"],
            ]}
          />
        </Section>

        <Section title="Account managers" action={canReassign || canAssignSalesManager ? edit : undefined}>
          <Facts
            items={[
              ["Salesperson", row.salesAmName],
              ["Sales manager", row.salesManagerName],
              ["Back office", row.backOfficeAmName],
              ["Relationship owner", r.relationshipOwnerName],
            ]}
          />
          {amChanges.length ? (
            <div className="mt-3 border-t border-line pt-3">
              <h3 className="mb-1.5 text-[12px] text-muted">History</h3>
              <ul className="flex max-h-48 flex-col gap-1 overflow-auto text-[12px] text-ink">
                {amChanges.map((c) => (
                  <li key={c.id}>
                    {seatLabel(c.role)}: {c.fromName ?? "nobody"} → {c.toName ?? "nobody"}
                    <span className="text-muted">
                      {" "}
                      · {stamp(c.changedAt)}
                      {c.changedBy ? ` · ${c.changedBy}` : ""}
                      {c.reasonCode ? ` · ${c.reasonCode}` : ""}
                      {c.note ? ` — ${c.note}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>

        <Section title="Buying and money">
          <Facts
            items={[
              ["Outstanding", money(row.outstanding)],
              ["Slow payer", row.slowPayer ? "Yes" : "No"],
              ["Last order", row.lastOrderDate ? `${longDate(row.lastOrderDate)}${r.lastOrderValue ? ` · ${money(r.lastOrderValue)}` : ""}` : null],
              ["Average order", r.avgOrderValue ? money(r.avgOrderValue) : null],
              ["Buys every", r.cycleIsDefault ? "Not measured yet" : `${row.cycleDays} days`],
              ["Last contact", r.lastContactDate ? longDate(r.lastContactDate) : null],
              ["Health score", r.healthScore === null ? null : String(r.healthScore)],
              ["Status", r.deactivationReason && r.statusLabel.toLowerCase().includes("deactiv") ? `${r.statusLabel} — ${r.deactivationReason}` : r.statusLabel],
            ]}
          />
          <p className="mt-3 text-[12px] text-muted">
            Worked out from the ledger and orders, so not edited here. Deactivating or reactivating is on the row menu of the customers list.
          </p>
        </Section>
      </div>

      <Section title="Contacts & WhatsApp">
        <CustomerContactsPanel customerId={row.id} initial={contacts} today={businessDay} birthdayHeadsUpDays={birthdayHeadsUpDays} onChange={() => router.refresh()} />
        <div className="mt-4 border-t border-line pt-3">
          <Facts
            items={[
              ["Messages go to", WA_WORD[r.whatsappDest] ?? r.whatsappDest],
              ["WhatsApp group", r.whatsappGroupName],
              ["WhatsApp blocked", r.whatsappDnd ? `Yes${r.whatsappDndReason ? ` — ${r.whatsappDndReason}` : ""}` : "No"],
            ]}
          />
        </div>
      </Section>

      <Section title="Delivery">
        {distributors.length || row.thirdParty || deliveryAddresses.length ? (
          <div className="flex flex-col gap-4">
            {distributors.length || row.thirdParty ? (
              <DeliveryRelations anchorId={row.id} anchorName={row.name} relations={distributors} canEdit={canClassify} direction="distributors" isThirdParty={row.thirdParty} />
            ) : null}
            {deliveryAddresses.length ? (
              <DeliveryRelations anchorId={row.id} anchorName={row.name} relations={deliveryAddresses} canEdit={canClassify} direction="addresses" isThirdParty={row.thirdParty} />
            ) : null}
          </div>
        ) : (
          <p className="text-[13px] text-muted">Billed and delivered here directly: no distributor and no other delivery address on record.</p>
        )}
        {!canClassify && (distributors.length || deliveryAddresses.length) ? (
          <p className="mt-2 text-[12px] text-muted">Distributors and delivery addresses are changed by an Accounts manager.</p>
        ) : null}
      </Section>

      {sheet ? (
        <Section title="What the Sales Party sheet says">
          <Facts items={sheet} />
          <p className="mt-3 text-[12px] text-muted">The row as the sheet holds it today. Blank fields above are filled from it; anything typed here wins.</p>
        </Section>
      ) : null}

      <CustomerForm
        open={editing}
        title={`Edit ${row.name}`}
        people={people}
        salesManagerPeople={people}
        salesManagerSuggestions={salesManagerSuggestions}
        kind={row.kind}
        canReassign={canReassign}
        canAssignSalesManager={canAssignSalesManager}
        amReasons={amReasons}
        initial={row}
        onClose={() => setEditing(false)}
        onSubmit={async (values) => {
          const ok = await saveCustomerEdit(row, values, { people, salesManagerPeople: people, run });
          if (ok) {
            setEditing(false);
            router.refresh();
          }
          return ok;
        }}
      />
    </div>
  );
}
