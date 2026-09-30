"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { daysUntil } from "@/lib/sales-lead-pipeline/engine";
import { personName } from "@/lib/sales-lead-pipeline/reference";
import type { ListData } from "@/lib/sales-lead-pipeline/types";
import { pipelineLinks } from "@/lib/sales-lead-pipeline/workspace";
import { STAGE_OPTIONS } from "../list-screen";
import { PCard, PEmpty, PMetricStrip, PPage, PPageHead, PPriorityBadge, PSalesTypeBadge, PStageBadge, pbtn, fmtDay } from "./ui";

/* ---------------------------------------------------------------------------
 * `renderListPage`, for the five views the prototype's sidebar opens.
 *
 * WHICH VIEW is a route (`/list`, `/mine`, `/today`, `/overdue`,
 * `/distributors`), and the filters are the URL's — the server does all of the
 * narrowing and counts the page in SQL, so the browser is handed one page of a
 * book and never the whole of it. The search is live: typing waits a beat and
 * then asks the server, which is what the prototype's `oninput` does over a
 * five-lead mock.
 * ------------------------------------------------------------------------- */

export type ProtoViewKey = "all" | "mine" | "today" | "overdue" | "distributors";

const VIEW_TEXT: Record<ProtoViewKey, { title: string; sub: string; path: string }> = {
  all: { title: "All Leads", sub: "Every opportunity in one book — direct, distributor and third-party alike.", path: "list" },
  mine: { title: "My Leads", sub: "Leads where you (Sales Manager) have work to do.", path: "mine" },
  today: { title: "Today's Actions", sub: "Next actions due today, across your book.", path: "today" },
  overdue: { title: "Overdue", sub: "No active lead should sit here for long — every one needs a next action.", path: "overdue" },
  distributors: {
    title: "Distributors & Third-Party",
    sub: "Appointed and prospective distributors, and the shops they serve on Mahek's behalf.",
    path: "distributors",
  },
};

export type ProtoListParams = { q: string; salesType: string; stage: string; owner: string; priority: string; view: string };

const money = (paise?: number) => (paise ? "₹" + Math.round(paise / 100).toLocaleString("en-IN") : "—");

const SALES_TYPES = [
  { value: "", label: "All sales types" },
  { value: "direct", label: "Direct" },
  { value: "distributor", label: "Distributor" },
  { value: "third_party", label: "Third-Party" },
];
const PRIORITIES = [
  { value: "", label: "All priority" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

const CTL =
  "h-8 rounded-[4px] border border-line bg-surface px-[9px] text-[13px] text-ink outline-none focus:border-brand";
const TH =
  "sticky top-0 z-[2] whitespace-nowrap border-b border-line bg-canvas px-3 py-2 text-left text-[10.5px] font-[650] tracking-[0.05em] text-muted uppercase";
const TD = "border-b border-divider px-3 py-[11px] align-top text-[13px] text-body";

export function ProtoList({
  data,
  params,
  viewKey,
  day,
  owners,
}: {
  data: ListData;
  params: ProtoListParams;
  viewKey: ProtoViewKey;
  day: string;
  owners: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [q, setQ] = React.useState(params.q);
  const today = new Date(`${day}T00:00:00`);
  const base = pipelineLinks("crm").base;
  const text = VIEW_TEXT[viewKey];
  const here = `${base}/${text.path}`;
  const { book } = data;
  const filtered = Boolean(params.q || params.salesType || params.stage || params.owner || params.priority || params.view);

  const hrefFor = React.useCallback(
    (next: Partial<ProtoListParams> & { page?: number }) => {
      const merged = { ...params, ...next };
      const sp = new URLSearchParams();
      for (const k of ["q", "salesType", "stage", "owner", "priority", "view"] as const) {
        if (merged[k]) sp.set(k, merged[k]);
      }
      if (next.page && next.page > 1) sp.set("page", String(next.page));
      const qs = sp.toString();
      return qs ? `${here}?${qs}` : here;
    },
    [params, here],
  );

  const go = (next: Partial<ProtoListParams> & { page?: number }) => startTransition(() => router.push(hrefFor({ ...next, page: next.page ?? 1 })));

  /* Live search: ask the server a beat after the last keystroke. */
  React.useEffect(() => {
    if (q.trim() === params.q) return;
    const t = setTimeout(() => startTransition(() => router.replace(hrefFor({ q: q.trim(), page: 1 }))), 350);
    return () => clearTimeout(t);
  }, [q, params.q, hrefFor, router]);

  const stageKnown = !params.stage || STAGE_OPTIONS.some((o) => o.value === params.stage);

  return (
    <PPage>
      <PPageHead
        title={text.title}
        sub={text.sub}
        actions={
          <button
            type="button"
            className={pbtn("secondary")}
            onClick={() => {
              setQ("");
              startTransition(() => router.push(here));
            }}
          >
            × Clear filters
          </button>
        }
      />

      {viewKey === "all" ? (
        <PMetricStrip
          metrics={[
            { label: "My leads", value: String(book.mine), sub: "active", href: `${base}/mine` },
            { label: "Today's actions", value: String(book.today), sub: "due today", href: `${base}/today` },
            { label: "Overdue", value: String(book.overdue), sub: "need a next action", tone: book.overdue ? "danger" : undefined, href: `${base}/overdue` },
            { label: "New suspects", value: String(book.suspects), href: `${here}?stage=suspect,new` },
            { label: "Prospects", value: String(book.prospects), href: `${here}?stage=prospect,contacted` },
            { label: "In sample", value: String(book.sample), tone: "warn", href: `${here}?stage=sample_trial,sample_received,sample_review` },
            { label: "Negotiations", value: String(book.negotiation), href: `${here}?stage=negotiation` },
            { label: "Expected orders", value: String(book.expected), tone: "success", href: `${here}?view=expected` },
            { label: "Lost (30d)", value: String(book.lost30), href: `${here}?view=lost30` },
          ]}
        />
      ) : null}

      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        <input
          className={CTL + " w-[220px]"}
          placeholder="Search customer…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search leads"
        />
        <select className={CTL} value={params.salesType} onChange={(e) => go({ salesType: e.target.value })} aria-label="Sales type">
          {SALES_TYPES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select className={CTL} value={params.stage} onChange={(e) => go({ stage: e.target.value })} aria-label="Stage">
          <option value="">All stages</option>
          {stageKnown ? null : <option value={params.stage}>Custom stage filter</option>}
          {STAGE_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select className={CTL} value={params.owner} onChange={(e) => go({ owner: e.target.value })} aria-label="Owner">
          <option value="">All owners</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <select className={CTL} value={params.priority} onChange={(e) => go({ priority: e.target.value })} aria-label="Priority">
          {PRIORITIES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {pending ? <span className="text-[13px] text-muted">Loading…</span> : null}
      </div>

      {data.rows.length === 0 ? (
        <PCard>
          <PEmpty
            title={data.listTotal === 0 && !filtered ? "No leads here yet" : "No leads match these filters"}
            body={data.listTotal === 0 && !filtered ? "Nothing in this part of your book yet." : "Try widening the stage, owner or priority filter above."}
          />
        </PCard>
      ) : (
        <div
          className={
            "overflow-x-auto rounded-lg border border-line bg-surface shadow-[0_1px_2px_rgba(22,22,22,0.06)]" + (pending ? " opacity-60" : "")
          }
        >
          <table className="w-full min-w-[1180px] border-collapse">
            <thead>
              <tr>
                {["Customer", "Sales type", "Stage", "Owner", "Product", "Monthly req.", "Expected sales", "Next action", "Due", "Priority"].map((h) => (
                  <th key={h} className={TH}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((l) => {
                const d = daysUntil(l.nextActionDate, today);
                return (
                  <tr key={l.id} className="cursor-pointer hover:[&>td]:bg-canvas" onClick={() => router.push(`${base}/${l.id}`)}>
                    <td className={TD}>
                      <Link href={`${base}/${l.id}`} className="block font-semibold text-ink" onClick={(e) => e.stopPropagation()}>
                        {l.name}
                      </Link>
                      <div className="mt-px text-[12px] text-muted">
                        {l.city ?? ""}
                        {l.contact ? ` · ${l.contact}` : ""}
                      </div>
                    </td>
                    <td className={TD}>
                      <PSalesTypeBadge salesType={l.salesType} />
                    </td>
                    <td className={TD}>
                      {l.lost ? <span className="inline-flex h-5 items-center rounded-[4px] bg-danger-soft px-[7px] text-[11px] font-semibold text-danger">Lost</span> : <PStageBadge stage={l.stage} />}
                    </td>
                    <td className={TD}>{personName(l.owner)}</td>
                    <td className={TD}>{l.product ?? "—"}</td>
                    <td className={TD}>{l.monthlyLitres ? `${l.monthlyLitres.toLocaleString("en-IN")} L` : "—"}</td>
                    <td className={TD}>{l.potentialPaise ? money(l.potentialPaise) : "—"}</td>
                    <td className={TD}>{l.nextAction ?? "—"}</td>
                    <td className={TD}>
                      {l.lost || !l.nextActionDate ? (
                        "—"
                      ) : d !== null && d < 0 ? (
                        <span className="font-[650] text-danger">{fmtDay(l.nextActionDate)}</span>
                      ) : d === 0 ? (
                        <span className="font-[650] text-warn-ink">Today</span>
                      ) : (
                        fmtDay(l.nextActionDate)
                      )}
                    </td>
                    <td className={TD}>
                      <PPriorityBadge priority={l.priority} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-[12.5px] text-muted">
        <span>
          {data.total === 0
            ? "0 leads"
            : `${(data.page - 1) * data.perPage + 1}–${Math.min(data.page * data.perPage, data.total)} of ${data.total.toLocaleString("en-IN")}`}
          {filtered ? ` (of ${data.listTotal.toLocaleString("en-IN")} in the book)` : ""}
        </span>
        <span className="flex items-center gap-2">
          <button type="button" className={pbtn("ghost", true)} disabled={data.page <= 1 || pending} onClick={() => go({ page: data.page - 1 })}>
            Previous
          </button>
          <span>
            Page {data.page} of {data.pageCount}
          </span>
          <button type="button" className={pbtn("ghost", true)} disabled={data.page >= data.pageCount || pending} onClick={() => go({ page: data.page + 1 })}>
            Next
          </button>
        </span>
      </div>
    </PPage>
  );
}
