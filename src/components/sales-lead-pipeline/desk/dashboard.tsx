"use client";

import * as React from "react";
import Link from "next/link";

import { Icon } from "@/components/shell/icons";
import { cx } from "@/components/ui/primitives";
import {
  DESK_VIEWS,
  NO_SALESMAN,
  QUEUE_HELP,
  QUEUE_LABEL,
  groupBySalesman,
  queueCounts,
  salesmenIn,
  type DeskView,
  type SalesmanGroup,
} from "@/lib/sales-lead-pipeline/desk";
import {
  PBadge,
  PCard,
  PEmpty,
  PPage,
  PPageHead,
  PPriorityBadge,
  PSalesTypeBadge,
  PSectionLabel,
  PStageBadge,
  fmtDay,
  pbtn,
} from "../proto/ui";
import { personName } from "@/lib/sales-lead-pipeline/reference";
import type { DeskData, DeskQueue, DeskRow } from "@/lib/sales-lead-pipeline/types";

/* ---------------------------------------------------------------------------
 * The Sales Manager desk — the Telecaller desk's shape, over this manager's book.
 *
 * A greeting, a strip of the five queues, then the leads GROUPED BY THE
 * SALESMAN WHO OWNS THEM, each section headed by that salesman's own queue
 * counts. A lead row names its salesman as well, because a search or a queue
 * filter reads as a flat list and the section header is then far away.
 *
 * PRESSING A QUEUE FILTERS THIS SCREEN and goes nowhere: the page holds every
 * live lead in the book (lean) and `desk.ts` — the same pure functions for the
 * tiles, the headers and the rows — does the narrowing, so a tile that says 14
 * opens a list of 14. The view is written to the address bar with
 * `replaceState` so it is still a link someone can send.
 *
 * It decides no rule and performs no write. Which queue a lead is in was
 * decided on the server from the real queue readers.
 * ------------------------------------------------------------------------- */

const QUEUE_TONE: Record<DeskQueue, "warn" | "danger" | "brand" | "success"> = {
  verify: "warn",
  review: "brand",
  sample: "warn",
  order: "success",
  overdue: "danger",
};

function dueLine(row: DeskRow, day: string): { text: string; tone: "danger" | "warn" | "body" | "muted" } {
  if (!row.nextActionDate) return { text: "No date", tone: "muted" };
  if (row.nextActionDate < day) return { text: `Overdue · ${fmtDay(row.nextActionDate)}`, tone: "danger" };
  if (row.nextActionDate === day) return { text: "Due today", tone: "warn" };
  return { text: fmtDay(row.nextActionDate), tone: "body" };
}

function LeadRow({ row, base, day }: { row: DeskRow; base: string; day: string }) {
  const due = dueLine(row, day);
  return (
    <Link
      href={`${base}/${row.id}`}
      className="flex items-center gap-3 border-b border-divider px-4 py-3 text-body no-underline last:border-0 hover:bg-canvas hover:no-underline"
    >
      <span
        className={cx(
          "w-1 flex-none self-stretch rounded",
          due.tone === "danger" ? "bg-danger" : due.tone === "warn" ? "bg-warn" : row.queues.length ? "bg-brand" : "bg-line",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{row.name}</span>
          <PSalesTypeBadge salesType={row.salesType} />
          <PStageBadge stage={row.stage} />
          <PPriorityBadge priority={row.priority} />
          {row.isRecent ? <PBadge tone="success">Recently</PBadge> : null}
          {row.queues.map((q) => (
            <PBadge key={q} tone={QUEUE_TONE[q]}>
              {QUEUE_LABEL[q]}
            </PBadge>
          ))}
        </span>
        <span className="block truncate text-[13px] text-muted">
          {row.city ? `${row.city} · ` : ""}
          {row.nextAction || row.gateLabel || "No next action"} · {personName(row.nextActionResp) || "—"}
        </span>
      </span>
      <span className="hidden w-[150px] flex-none text-[12px] text-muted md:block">
        <span className="block text-[10.5px] tracking-[0.05em] uppercase">Salesman</span>
        <span className="block truncate font-medium text-ink">{row.ownerId ? personName(row.owner) : "No salesman yet"}</span>
      </span>
      <span className="w-[104px] flex-none text-right">
        <span
          className={cx(
            "block text-[13px] leading-tight font-semibold",
            due.tone === "danger" && "text-danger",
            due.tone === "warn" && "text-warn-ink",
            due.tone === "muted" && "text-muted",
          )}
        >
          {due.text}
        </span>
      </span>
    </Link>
  );
}

function Section({ group, base, day, open, onToggle }: { group: SalesmanGroup; base: string; day: string; open: boolean; onToggle: () => void }) {
  const unowned = group.id === NO_SALESMAN;
  return (
    <PCard className="mb-3 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-3 border-b border-divider bg-canvas px-4 py-3 text-left"
      >
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-brand-soft text-[12px] font-semibold text-[#5223e0]">
          {unowned ? "—" : group.name.slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-[650] text-ink">{group.name}</span>
          <span className="block text-[12px] text-muted">
            {group.counts.all} lead{group.counts.all === 1 ? "" : "s"}
            {unowned ? " · nobody owns these, so no salesman is working them" : ""}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          {(Object.keys(QUEUE_LABEL) as DeskQueue[])
            .filter((q) => group.counts[q] > 0)
            .map((q) => (
              <PBadge key={q} tone={QUEUE_TONE[q]} className="">
                {QUEUE_LABEL[q]} {group.counts[q]}
              </PBadge>
            ))}
        </span>
        <span className="text-muted" aria-hidden>
          {open ? "−" : "+"}
        </span>
      </button>
      {open ? group.rows.map((r) => <LeadRow key={r.id} row={r} base={base} day={day} />) : null}
    </PCard>
  );
}

export function Dashboard({
  data,
  initialView,
  initialQuery,
  base,
  intakeHref,
}: {
  data: DeskData;
  initialView: DeskView;
  initialQuery: string;
  base: string;
  intakeHref: string;
}) {
  const [view, setView] = React.useState<DeskView>(initialView);
  const [q, setQ] = React.useState(initialQuery);
  const [salesmanId, setSalesmanId] = React.useState("");
  const [closed, setClosed] = React.useState<Record<string, boolean>>({});

  const counts = React.useMemo(() => queueCounts(data.rows), [data.rows]);
  const salesmen = React.useMemo(() => salesmenIn(data.rows), [data.rows]);
  const groups = React.useMemo(() => groupBySalesman(data.rows, { view, q, salesmanId }), [data.rows, view, q, salesmanId]);
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);

  function pick(next: DeskView) {
    setView(next);
    try {
      const url = new URL(window.location.href);
      if (next === "all") url.searchParams.delete("view");
      else url.searchParams.set("view", next);
      window.history.replaceState(null, "", url);
    } catch {
      /* The address bar is a convenience; the filter works without it. */
    }
  }

  const tiles: { key: DeskView; label: string; value: number; sub: string }[] = [
    { key: "all", label: "All leads", value: counts.all, sub: "in your book" },
    ...(DESK_VIEWS.filter((v): v is DeskQueue => v !== "all").map((k) => ({
      key: k as DeskView,
      label: QUEUE_LABEL[k],
      value: counts[k],
      sub: k === "overdue" ? "next action passed" : "waiting on you",
    }))),
  ];

  return (
    <PPage>
      <PPageHead
        eyebrow="Sales Manager desk"
        title={data.greeting}
        sub="Your salesmen's leads, grouped by salesman. Open a lead to read what the salesman has done and to verify, review or confirm."
        actions={
          <Link href={intakeHref} className={pbtn("primary")}>
            <Icon name="plus" size={15} /> New lead
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap overflow-hidden rounded-lg border border-line bg-surface shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
        {tiles.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => pick(t.key)}
            aria-pressed={view === t.key}
            title={t.key === "all" ? undefined : QUEUE_HELP[t.key as DeskQueue]}
            className={cx(
              "min-w-[132px] flex-1 border-r border-divider px-[18px] py-3.5 text-left last:border-r-0 hover:bg-canvas",
              view === t.key && "bg-brand-soft",
            )}
          >
            <div className="text-[10.5px] font-[650] tracking-[0.05em] whitespace-nowrap text-muted uppercase">{t.label}</div>
            <div
              className={cx(
                "mt-[3px] font-mono text-[23px] leading-7 font-[650]",
                t.key === "overdue" && t.value ? "text-danger" : t.key !== "all" && t.value ? "text-warn-ink" : "text-ink",
              )}
            >
              {t.value}
            </div>
            <div className="mt-px text-[11.5px] whitespace-nowrap text-muted">{t.sub}</div>
          </button>
        ))}
      </div>

      {view !== "all" ? <p className="mb-3 text-[12.5px] text-muted">{QUEUE_HELP[view]}</p> : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <PSectionLabel className="mb-0 mr-auto">
          {view === "all" ? "Leads by salesman" : QUEUE_LABEL[view]} · {shown}
        </PSectionLabel>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, city, salesman, next action…"
          aria-label="Search leads"
          className="h-8 w-[280px] max-w-full rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-brand"
        />
        <select
          value={salesmanId}
          onChange={(e) => setSalesmanId(e.target.value)}
          aria-label="Filter by salesman"
          className="h-8 rounded-[4px] border border-line bg-surface px-2 text-[13px] text-ink"
        >
          <option value="">All salesmen</option>
          {salesmen.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {groups.length === 0 ? (
        <PCard>
          <PEmpty
            title={data.rows.length === 0 ? "No lead carries your seat yet" : "Nothing matches"}
            body={
              data.rows.length === 0
                ? "Leads appear here once an administrator names you as their Sales Manager."
                : "Try another queue, or clear the search and the salesman filter."
            }
          />
        </PCard>
      ) : (
        groups.map((g) => (
          <Section
            key={g.id}
            group={g}
            base={base}
            day={data.today}
            open={!closed[g.id]}
            onToggle={() => setClosed((c) => ({ ...c, [g.id]: !c[g.id] }))}
          />
        ))
      )}

      {data.truncated ? (
        <p className="mt-2 text-[12px] text-warn-ink">
          Your book is larger than the desk loads at once, so the tail is not shown. Narrow it by salesman on the full lead list.
        </p>
      ) : null}
      {data.lostHidden > 0 ? (
        <p className="mt-2 text-[12px] text-muted">
          {data.lostHidden} lost lead{data.lostHidden === 1 ? "" : "s"} in your book {data.lostHidden === 1 ? "is" : "are"} not listed here — the desk shows live work only.
        </p>
      ) : null}
    </PPage>
  );
}
