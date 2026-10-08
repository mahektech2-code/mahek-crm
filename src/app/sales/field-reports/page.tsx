import Link from "next/link";
import { money, shortDate } from "@/lib/format";
import {
  FIELD_REPORT_DAYS,
  FIELD_REPORT_LIMIT,
  fieldComplaints,
  fieldCompetitors,
  fieldNotes,
  fieldOrderChanges,
  fieldReportCounts,
  fieldTours,
  type FieldReportTab,
} from "@/lib/services/field-reports-service";
import {
  Cell,
  Empty,
  FilterChips,
  HeadCell,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "@/components/console/parts";
import { CustomerName } from "@/components/console/customer-name";

export const metadata = { title: "Field reports — Sales Dashboard — MahekOne" };

const TABS: { key: FieldReportTab; label: string }[] = [
  { key: "complaints", label: "Complaints" },
  { key: "competition", label: "Competition" },
  { key: "notes", label: "Internal notes" },
  { key: "tours", label: "Tours" },
  { key: "changes", label: "Order changes" },
];

/**
 * What the field has told us that is not a visit, an order or a payment.
 *
 * Every one of these five was being sent by the handset and read by no screen
 * on this dashboard — see `field-reports-service.ts`. One tab is read at a
 * time; the chips count all five, over the same windows, in one query.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const tab = (TABS.some((t) => t.key === params.tab) ? params.tab : "complaints") as FieldReportTab;
  const counts = await fieldReportCounts();
  const capped = counts[tab] > FIELD_REPORT_LIMIT;

  return (
    <div className="p-6">
      <ScreenHeader
        title="Field reports"
        subtitle={`What salesmen have filed from the shops in the last ${FIELD_REPORT_DAYS} days — complaints, what the competition is doing, notes for the office, tours they want to make and changes they asked for on orders already sent.`}
      />
      <FilterChips
        current={tab}
        options={TABS.map((t) => ({
          key: t.key,
          label: t.label,
          href: `/sales/field-reports?tab=${t.key}`,
          count: counts[t.key],
        }))}
      />
      {capped ? (
        <p className="mb-2 text-[13px] text-muted">
          The newest {FIELD_REPORT_LIMIT} of {counts[tab]}.
        </p>
      ) : null}
      {tab === "complaints" ? <Complaints /> : null}
      {tab === "competition" ? <Competition /> : null}
      {tab === "notes" ? <Notes /> : null}
      {tab === "tours" ? <Tours /> : null}
      {tab === "changes" ? <Changes /> : null}
    </div>
  );
}

function Salesman({ id, name }: { id: string | null; name: string | null }) {
  if (!id) return <span className="text-muted">—</span>;
  return (
    <Link href={`/sales/people/${id}`} className="no-underline">
      {name}
    </Link>
  );
}

const WRAP = "whitespace-normal leading-snug";

async function Complaints() {
  const rows = await fieldComplaints();
  if (!rows.length) {
    return (
      <Empty
        title="No complaints from the field"
        body="Nothing has been raised on a handset in this window. Complaints are worked on the CRM's complaint desk; this shows the ones salesmen raised."
      />
    );
  }
  return (
    <Table
      minWidth={1200}
      head={
        <>
          <HeadCell width={100}>Raised</HeadCell>
          <HeadCell width={160}>Salesman</HeadCell>
          <HeadCell width={200}>Customer</HeadCell>
          <HeadCell>What happened</HeadCell>
          <HeadCell width={150}>Photos</HeadCell>
          <HeadCell width={170}>State</HeadCell>
        </>
      }
    >
      {rows.map((k, i) => (
        <Row key={k.id} striped={i % 2 === 1}>
          <Cell>{shortDate(k.createdAt)}</Cell>
          <Cell truncate={160}>
            <Salesman id={k.salesmanId} name={k.salesmanName} />
          </Cell>
          <Cell truncate={200}>
            <CustomerName id={k.customerId} name={k.customerName} />
          </Cell>
          <Cell className={WRAP}>
            <span className="text-[12px] font-medium text-muted">
              {k.category.replace(/_/g, " ")} · {k.severity}
              {k.requestCn ? " · credit note asked for" : ""}
            </span>
            <span className="block">{k.description}</span>
            {k.resolutionNotes ? (
              <span className="mt-0.5 block text-[12px] text-muted">Resolved: {k.resolutionNotes}</span>
            ) : null}
          </Cell>
          <Cell>
            {k.photoIds.length ? (
              <span className="inline-flex gap-1">
                {k.photoIds.slice(0, 3).map((id) => (
                  <Photo key={id} id={id} alt={`${k.customerName}, complaint photograph`} />
                ))}
              </span>
            ) : (
              <span className="text-muted">—</span>
            )}
          </Cell>
          <Cell className={WRAP}>
            <Pill tone={k.status === "resolved" || k.status === "closed" ? "success" : "warn"}>
              {k.status.replace(/_/g, " ")}
            </Pill>
            {!k.resolvedAt ? (
              <span className="block text-[12px] text-muted">due {shortDate(k.slaDueAt)}</span>
            ) : null}
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

async function Competition() {
  const rows = await fieldCompetitors();
  if (!rows.length) {
    return (
      <Empty
        title="Nothing about the competition yet"
        body="When a salesman records a competitor at a shop — their product, their rate, their credit terms — it lands here."
      />
    );
  }
  return (
    <Table
      minWidth={1300}
      head={
        <>
          <HeadCell width={100}>When</HeadCell>
          <HeadCell width={150}>Salesman</HeadCell>
          <HeadCell width={190}>Customer</HeadCell>
          <HeadCell width={220}>Competitor</HeadCell>
          <HeadCell width={170}>Rate and credit</HeadCell>
          <HeadCell>What he found</HeadCell>
        </>
      }
    >
      {rows.map((r, i) => (
        <Row key={r.id} striped={i % 2 === 1}>
          <Cell>{shortDate(r.recordedOn ?? r.createdAt)}</Cell>
          <Cell truncate={150}>
            <Salesman id={r.salesmanId} name={r.salesmanName} />
          </Cell>
          <Cell truncate={190}>
            <CustomerName id={r.customerId} name={r.customerName} />
          </Cell>
          <Cell className={WRAP}>
            <span className="font-medium text-ink">{r.competitorName}</span>
            {r.productName ? <span className="block text-[12px] text-muted">{r.productName}</span> : null}
          </Cell>
          <Cell className={WRAP}>
            {r.pricePaise != null ? money(r.pricePaise) : <span className="text-muted">no rate</span>}
            {r.rateNote ? <span className="block text-[12px] text-muted">{r.rateNote}</span> : null}
            {r.creditDays != null ? (
              <span className="block text-[12px] text-muted">{r.creditDays} days credit</span>
            ) : r.creditTerms ? (
              <span className="block text-[12px] text-muted">{r.creditTerms}</span>
            ) : null}
          </Cell>
          <Cell className={WRAP}>
            {r.strengths ? <span className="block">Strong on: {r.strengths}</span> : null}
            {r.weaknesses ? <span className="block">Weak on: {r.weaknesses}</span> : null}
            {r.deliveryNote ? (
              <span className="block text-[12px] text-muted">Delivery: {r.deliveryNote}</span>
            ) : null}
            {!r.strengths && !r.weaknesses && !r.deliveryNote ? (
              <span className="text-muted">—</span>
            ) : null}
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

async function Notes() {
  const rows = await fieldNotes();
  if (!rows.length) {
    return (
      <Empty
        title="No internal notes"
        body="A note a salesman writes about a shop for the office — never shown to the customer — lands here."
      />
    );
  }
  return (
    <Table
      minWidth={1000}
      head={
        <>
          <HeadCell width={100}>Written</HeadCell>
          <HeadCell width={160}>By</HeadCell>
          <HeadCell width={210}>Customer</HeadCell>
          <HeadCell>Note</HeadCell>
        </>
      }
    >
      {rows.map((n, i) => (
        <Row key={n.id} striped={i % 2 === 1}>
          <Cell>{shortDate(n.createdAt)}</Cell>
          <Cell truncate={160}>
            <Salesman id={n.authorId} name={n.authorName} />
          </Cell>
          <Cell truncate={210}>
            <CustomerName id={n.customerId} name={n.customerName} />
          </Cell>
          <Cell className={WRAP}>
            {n.body != null ? (
              <span className="whitespace-pre-wrap">{n.body}</span>
            ) : (
              <span className="text-muted">
                Restricted to {n.restrictedTo.join(", ")} — you do not hold that level.
              </span>
            )}
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

async function Tours() {
  const rows = await fieldTours();
  if (!rows.length) {
    return (
      <Empty
        title="No tours asked for"
        body="When a salesman asks to work away from his base for some days, the request and its approval land here."
      />
    );
  }
  return (
    <Table
      minWidth={1100}
      head={
        <>
          <HeadCell width={160}>Salesman</HeadCell>
          <HeadCell width={170}>Dates</HeadCell>
          <HeadCell width={220}>Cities</HeadCell>
          <HeadCell>Why</HeadCell>
          <HeadCell width={130}>Estimate</HeadCell>
          <HeadCell width={170}>Approval</HeadCell>
        </>
      }
    >
      {rows.map((t, i) => (
        <Row key={t.id} striped={i % 2 === 1}>
          <Cell truncate={160}>
            <Salesman id={t.salesmanId} name={t.salesmanName} />
          </Cell>
          <Cell>
            {shortDate(t.startDate)}
            {t.endDate !== t.startDate ? ` – ${shortDate(t.endDate)}` : ""}
          </Cell>
          <Cell className={WRAP}>{t.cities.length ? t.cities.join(" → ") : <span className="text-muted">—</span>}</Cell>
          <Cell className={WRAP}>
            {t.purpose ?? <span className="text-muted">—</span>}
            {t.notes ? <span className="block text-[12px] text-muted">{t.notes}</span> : null}
          </Cell>
          <Cell>{t.estimatedCostPaise != null ? money(t.estimatedCostPaise) : <span className="text-muted">—</span>}</Cell>
          <Cell className={WRAP}>
            <Pill tone={approvalTone(t.approvalState)}>{approvalWord(t.approvalState)}</Pill>
            {t.decisionNote ? <span className="block text-[12px] text-muted">{t.decisionNote}</span> : null}
            {t.approvalState === "pending" ? (
              <Link href="/sales/approvals" className="block text-[12px]">
                Decide it
              </Link>
            ) : null}
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

async function Changes() {
  const rows = await fieldOrderChanges();
  if (!rows.length) {
    return (
      <Empty
        title="No order changes asked for"
        body="When a salesman asks to change an order already sent to accounts, the request and accounts' answer land here."
      />
    );
  }
  return (
    <Table
      minWidth={1300}
      head={
        <>
          <HeadCell width={100}>Asked</HeadCell>
          <HeadCell width={150}>Salesman</HeadCell>
          <HeadCell width={190}>Customer</HeadCell>
          <HeadCell width={130}>Order</HeadCell>
          <HeadCell>Change</HeadCell>
          <HeadCell width={180}>Accounts</HeadCell>
        </>
      }
    >
      {rows.map((r, i) => (
        <Row key={r.id} striped={i % 2 === 1}>
          <Cell>{shortDate(r.createdAt)}</Cell>
          <Cell truncate={150}>
            <Salesman id={r.salesmanId} name={r.salesmanName} />
          </Cell>
          <Cell truncate={190}>
            <CustomerName id={r.customerId} name={r.customerName} />
          </Cell>
          <Cell>{r.orderNo ?? "Not yet numbered"}</Cell>
          <Cell className={WRAP}>
            <span className="block">{r.note}</span>
            <span className="block text-[12px] text-muted">
              Now: {lines(r.lineItems)} ({money(r.totalAmountPaise)})
            </span>
            {r.previousLineItems ? (
              <span className="block text-[12px] text-muted">
                Was: {lines(r.previousLineItems)}
                {r.previousTotalPaise != null ? ` (${money(r.previousTotalPaise)})` : ""}
              </span>
            ) : null}
          </Cell>
          <Cell className={WRAP}>
            <Pill tone={r.status === "accepted" ? "success" : r.status === "declined" ? "danger" : "warn"}>
              {r.status === "pending" ? "Waiting" : r.status}
            </Pill>
            {r.decidedByName ? <span className="block text-[12px] text-muted">by {r.decidedByName}</span> : null}
            {r.decisionNote ? <span className="block text-[12px] text-muted">{r.decisionNote}</span> : null}
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

function lines(items: { product: string; quantity: number }[]): string {
  return items.length ? items.map((l) => `${l.product} × ${l.quantity}`).join(", ") : "no lines";
}

function approvalWord(state: string | null): string {
  if (!state) return "Not sent for approval";
  if (state === "pending") return "Waiting";
  return state.replace(/_/g, " ");
}

function approvalTone(state: string | null): "success" | "warn" | "danger" | "neutral" {
  if (state === "approved" || state === "partially_approved") return "success";
  if (state === "rejected") return "danger";
  if (state === "pending") return "warn";
  return "neutral";
}

/** A photograph, opening full size. `/api/attachments/[id]` checks access. */
function Photo({ id, alt }: { id: string; alt: string }) {
  return (
    <a href={`/api/attachments/${id}`} target="_blank" rel="noreferrer" title="Open the full photograph">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/attachments/${id}`}
        alt={alt}
        loading="lazy"
        className="h-10 w-10 rounded-[3px] border border-line object-cover hover:border-brand"
      />
    </a>
  );
}
