"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, Input, PageHeader, Select, Td, Th, Tr } from "@/components/ui/primitives";
import { LeadStatusBadges } from "./badges";
import { personName } from "@/lib/sales-lead-pipeline/reference";
import type { ListData } from "@/lib/sales-lead-pipeline/types";

const BASE = "/sales-lead-pipeline";

const money = (paise?: number) => (paise ? "₹" + Math.round(paise / 100).toLocaleString("en-IN") : "—");

/**
 * A stage filter is a comma list, because the tiles above the table count
 * several rungs at once (a legacy `new` and a real `suspect` are one tile).
 * The options carry the SAME lists, so a tile's URL selects its own option and
 * the number on the tile is the number of rows this filter returns.
 */
const STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "suspect,new", label: "Suspect" },
  { value: "prospect,contacted", label: "Prospect" },
  { value: "qualification,qualified", label: "Qualification" },
  { value: "sample_trial,sample_received,sample_review", label: "In sample (all three rungs)" },
  { value: "sample_trial", label: "Sample / Trial" },
  { value: "sample_received", label: "Sample Received" },
  { value: "sample_review", label: "Sample Review" },
  { value: "negotiation", label: "Negotiation" },
  { value: "first_order", label: "1st Order" },
  { value: "delivery", label: "Delivery" },
  { value: "payment", label: "Payment" },
  { value: "second_order", label: "2nd Order" },
  { value: "customer,won", label: "Customer" },
  { value: "management_review", label: "Management Review" },
  { value: "commercial_discussion", label: "Commercial Discussion" },
  { value: "distributor_approval", label: "Distributor Approval" },
  { value: "distributor_agreement", label: "Distributor Agreement" },
  { value: "initial_stock_order", label: "Initial Stock Order" },
  { value: "active_distributor", label: "Active Distributor" },
  { value: "on_hold", label: "On hold" },
  { value: "lost", label: "Lost" },
];

const VIEW_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Whole book" },
  { value: "mine", label: "My leads" },
  { value: "today", label: "Due today" },
  { value: "overdue", label: "Overdue" },
  { value: "expected", label: "Expected orders" },
  { value: "lost30", label: "Lost (30 days)" },
];

function hrefFor(p: { q?: string; stage?: string; view?: string; page?: number }) {
  const sp = new URLSearchParams();
  if (p.q) sp.set("q", p.q);
  if (p.stage) sp.set("stage", p.stage);
  if (p.view) sp.set("view", p.view);
  if (p.page && p.page > 1) sp.set("page", String(p.page));
  const qs = sp.toString();
  return qs ? `${BASE}/list?${qs}` : `${BASE}/list`;
}

export function ListScreen({
  data,
  params,
}: {
  data: ListData;
  params: { q: string; stage: string; view: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [q, setQ] = React.useState(params.q);
  const { book } = data;
  const filtered = Boolean(params.q || params.stage || params.view);

  const go = (next: { q?: string; stage?: string; view?: string; page?: number }) =>
    startTransition(() => router.push(hrefFor({ q: params.q, stage: params.stage, view: params.view, ...next })));

  /* A stage in the URL that is not one of the options (a hand-typed list) is
     still offered, so the select never claims a filter it is not applying. */
  const stageKnown = !params.stage || STAGE_OPTIONS.some((o) => o.value === params.stage);

  return (
    <div className="p-6">
      <PageHeader title="All Leads" subtitle="Every opportunity in one book — direct, distributor and third-party alike." />

      <Card className="mb-4 flex flex-wrap items-start gap-x-8 gap-y-3.5 px-5 py-3.5">
        {[
          { label: "My leads", value: book.mine, sub: "carrying your seat" },
          { label: "Today's actions", value: book.today, sub: "due today" },
          { label: "Overdue", value: book.overdue },
          { label: "New suspects", value: book.suspects },
          { label: "Prospects", value: book.prospects },
          { label: "In sample", value: book.sample },
          { label: "Negotiations", value: book.negotiation },
          { label: "Expected orders", value: book.expected },
          { label: "Lost (30d)", value: book.lost30 },
        ].map((m) => (
          <div key={m.label}>
            <div className="text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">{m.label}</div>
            <div className="mt-0.5 text-[22px] leading-7 font-semibold text-ink">{m.value}</div>
            {m.sub ? <div className="text-xs text-muted">{m.sub}</div> : null}
          </div>
        ))}
      </Card>

      <form
        className="mb-3 flex flex-wrap items-center gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: q.trim(), page: 1 });
        }}
      >
        <Input placeholder="Search name, city, phone…" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" aria-label="Search leads" />
        <Button type="submit" variant="secondary" size="sm">Search</Button>
        <Select value={params.stage} onChange={(e) => go({ stage: e.target.value, page: 1 })} aria-label="Stage">
          <option value="">All stages</option>
          {stageKnown ? null : <option value={params.stage}>Custom stage filter</option>}
          {STAGE_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </Select>
        <Select value={params.view} onChange={(e) => go({ view: e.target.value, page: 1 })} aria-label="View">
          {VIEW_OPTIONS.map((v) => (
            <option key={v.value} value={v.value}>{v.label}</option>
          ))}
        </Select>
        {filtered ? (
          <button
            type="button"
            onClick={() => {
              setQ("");
              startTransition(() => router.push(`${BASE}/list`));
            }}
            className="text-[13px] font-medium text-brand hover:text-brand-hover"
          >
            × Clear filter
          </button>
        ) : null}
        {pending ? <span className="text-[13px] text-muted">Loading…</span> : null}
      </form>

      <Card className={"overflow-hidden" + (pending ? " opacity-60" : "")}>
        <div className="overflow-x-auto">
          <table>
            <thead>
              <Tr>
                <Th>Customer</Th>
                <Th>Sales type</Th>
                <Th>Stage</Th>
                <Th>Owner</Th>
                <Th>Product</Th>
                <Th align="right">Monthly req.</Th>
                <Th align="right">Expected sales</Th>
                <Th>Next action</Th>
                <Th>Due</Th>
              </Tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-10 text-center text-sm text-muted">
                    {data.listTotal === 0
                      ? "There are no leads in your book yet."
                      : "No leads match this filter."}
                  </td>
                </tr>
              ) : (
                data.rows.map((l) => (
                  <Tr key={l.id} className="cursor-pointer hover:bg-canvas">
                    <Td>
                      <Link href={`${BASE}/${l.id}`} className="block">
                        <span className="font-medium text-ink">{l.name}</span>
                        <span className="block text-[12px] text-muted">
                          {l.city ?? "—"} · {l.contact ?? "—"}
                        </span>
                      </Link>
                    </Td>
                    <Td>{l.salesType === "direct" ? "Direct" : l.salesType === "third_party" ? "Third-party" : l.salesType === "distributor" ? "Distributor" : "Not set"}</Td>
                    <Td>
                      <LeadStatusBadges lead={l} />
                    </Td>
                    <Td>{personName(l.owner)}</Td>
                    <Td>{l.product ?? "—"}</Td>
                    <Td align="right">{l.monthlyLitres ? `${l.monthlyLitres.toLocaleString("en-IN")} L` : "—"}</Td>
                    <Td align="right">{money(l.potentialPaise)}</Td>
                    <Td className="whitespace-normal">{l.nextAction ?? "—"}</Td>
                    <Td>{l.nextActionDate ?? "—"}</Td>
                  </Tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-3 flex items-center justify-between text-[13px] text-muted">
        <span>
          {data.total === 0
            ? "0 leads"
            : `${(data.page - 1) * data.perPage + 1}–${Math.min(data.page * data.perPage, data.total)} of ${data.total.toLocaleString("en-IN")}`}
          {filtered ? ` (of ${data.listTotal.toLocaleString("en-IN")} in the book)` : ""}
        </span>
        <span className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={data.page <= 1 || pending} onClick={() => go({ page: data.page - 1 })}>
            Previous
          </Button>
          <span>Page {data.page} of {data.pageCount}</span>
          <Button variant="secondary" size="sm" disabled={data.page >= data.pageCount || pending} onClick={() => go({ page: data.page + 1 })}>
            Next
          </Button>
        </span>
      </div>
    </div>
  );
}
