"use client";

import * as React from "react";
import Link from "next/link";
import { addDays } from "@/lib/business-date";
import { money } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import { SalesIcon, type SalesIconName } from "@/components/console/icons";
import type { SalesmanDay, TeamDay } from "@/lib/services/sales-service";
import { avatarTone } from "./avatar-tone";

/* ---------------------------------------------------------------------------
 * Today — the Sales Dashboard's front door.
 *
 * FOUR FIGURES, WHAT IS WAITING, AND THE TEAM AS ONE TABLE. A manager opening
 * this at nine wants to know who is out and what needs him; everything else is
 * one click away. The team was a card per salesman, which is a wall at a
 * hundred; it is a table now that scrolls down inside its own box and never
 * across — see `TeamTable`.
 *
 * **A row opens that salesman's whole day in a new tab** — his map and a
 * timeline of every punch, leg, stop, visit and act (`/sales/live/[id]`). A
 * new tab because this screen is the one a manager keeps open and comes back
 * to; replacing it to look at one man would cost him his place.
 *
 * **The money still says which kind it is** — on the figure's hover rather
 * than in a paragraph under the table. Orders are captured, not approved;
 * collections are reported, not confirmed against the bank.
 * ------------------------------------------------------------------------- */

const CARD = "rounded-[10px] border border-line bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.04)]";
const BUTTON =
  "inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-line bg-surface px-3 text-[13px] font-medium text-body no-underline shadow-[0_1px_2px_rgba(16,24,40,0.04)] hover:bg-canvas hover:no-underline";

export function TodayScreen({
  day,
  dayLabel,
  isToday,
  greeting,
  data,
  waiting,
}: {
  day: string;
  dayLabel: string;
  isToday: boolean;
  greeting: string;
  data: TeamDay;
  /** What is waiting on this manager, and where. */
  waiting: Array<{ href: string; label: string; sub: string; count: number; tone: string }>;
}) {
  const { totals, people } = data;
  const open = waiting.filter((w) => w.count > 0);
  const totalWaiting = waiting.reduce((n, w) => n + w.count, 0);
  const outShare = totals.outOf ? Math.round((totals.checkedIn / totals.outOf) * 100) : 0;

  return (
    <div className="space-y-6 px-6 py-6">
      {/* ------------------------------------------------------------ heading */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-medium tracking-[0.06em] text-muted uppercase">{dayLabel}</p>
          <h1 className="mt-0.5 text-[24px] leading-8 font-semibold tracking-[-0.01em] text-heading">{greeting}</h1>
        </div>
        <div className="flex flex-none items-center gap-2">
          <div className="inline-flex h-9 items-stretch overflow-hidden rounded-[8px] border border-line bg-surface text-[13px] shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
            <Link
              href={`/sales?day=${addDays(day, -1)}`}
              className="inline-flex w-9 items-center justify-center text-body no-underline hover:bg-canvas hover:no-underline"
              title="The day before"
              aria-label="The day before"
            >
              <SalesIcon name="chevron" size={16} className="rotate-180" />
            </Link>
            <Link
              href="/sales"
              className={cx(
                "inline-flex items-center border-x border-line px-3 font-medium no-underline hover:bg-canvas hover:no-underline",
                isToday ? "text-ink" : "text-brand",
              )}
            >
              {isToday ? "Today" : "Back to today"}
            </Link>
            <Link
              href={`/sales?day=${addDays(day, 1)}`}
              className="inline-flex w-9 items-center justify-center text-body no-underline hover:bg-canvas hover:no-underline"
              title="The day after"
              aria-label="The day after"
            >
              <SalesIcon name="chevron" size={16} />
            </Link>
          </div>
          <Link href="/sales/live" target="_blank" className={BUTTON}>
            <SalesIcon name="pin" size={16} />
            Team map
          </Link>
          {totalWaiting > 0 ? (
            <Link
              href="/sales/approvals"
              className="inline-flex h-9 items-center gap-2 rounded-[8px] bg-brand px-3.5 text-[13px] font-medium text-white no-underline shadow-[0_1px_2px_rgba(16,24,40,0.08)] hover:bg-brand-hover hover:no-underline"
            >
              Review
              <span className="rounded-full bg-white/20 px-1.5 text-[12px] tabular-nums">{totalWaiting}</span>
            </Link>
          ) : null}
        </div>
      </div>

      {/* ------------------------------------------------------------ figures */}
      <CardGrid min={200} gap="gap-4">
        <Stat
          icon="people"
          tint="brand"
          label={isToday ? "Out now" : "Punched in"}
          value={
            <>
              {totals.checkedIn}
              <span className="text-[16px] font-medium text-muted"> / {totals.outOf}</span>
            </>
          }
          foot={
            <span className="flex items-center gap-2">
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-divider">
                <span
                  className={cx("block h-full rounded-full", outShare ? "bg-brand" : "bg-danger")}
                  style={{ width: `${Math.max(outShare, 2)}%` }}
                />
              </span>
              <span className="tabular-nums">{outShare}%</span>
            </span>
          }
        />
        <Stat
          icon="visit"
          tint="success"
          label="Visits"
          value={String(totals.visits)}
          foot={totals.plannedStops ? `${totals.walkedStops} of ${totals.plannedStops} planned stops` : "No routes planned"}
        />
        <Stat
          icon="order"
          tint="info"
          label="Orders"
          value={String(totals.orders)}
          foot={totals.orderValuePaise ? `${money(totals.orderValuePaise)} captured` : "None yet"}
          title="Captured in the field. Sits at pending approval until accounts decide it."
        />
        <Stat
          icon="money"
          tint="warn"
          label="Collected"
          value={money(totals.collectedPaise)}
          foot="Reported, not yet confirmed"
          title="What salesmen report collecting. It is money the business has seen only once accounts confirm it against the bank."
        />
      </CardGrid>

      {/* ------------------------------------------------- waiting on you */}
      {open.length ? (
        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-heading">Waiting on you</h2>
          <CardGrid min={240} gap="gap-3">
            {open.map((w) => (
              <Link
                key={w.label}
                href={w.href}
                className={cx(
                  CARD,
                  "group flex items-center gap-3 px-4 py-3 no-underline transition-colors hover:border-brand/50 hover:no-underline",
                )}
              >
                <span
                  className={cx(
                    "flex size-9 flex-none items-center justify-center rounded-[8px] text-[14px] font-semibold tabular-nums",
                    w.tone === "danger"
                      ? "bg-danger-soft text-danger"
                      : w.tone === "amber" || w.tone === "warn"
                        ? "bg-warn-soft text-warn-ink"
                        : "bg-canvas text-body",
                  )}
                >
                  {w.count}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">{w.label}</span>
                  <span className="block truncate text-[12px] text-muted">{w.sub}</span>
                </span>
                <SalesIcon
                  name="chevron"
                  size={16}
                  className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-brand"
                />
              </Link>
            ))}
          </CardGrid>
        </section>
      ) : null}

      {/* ---------------------------------------------------------- team */}
      <TeamTable people={people} day={day} isToday={isToday} />
    </div>
  );
}

const TINT = {
  brand: "bg-brand-soft text-brand",
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  warn: "bg-warn-soft text-warn-ink",
} as const;

function Stat({
  icon,
  tint,
  label,
  value,
  foot,
  title,
}: {
  icon: SalesIconName;
  tint: keyof typeof TINT;
  label: string;
  value: React.ReactNode;
  foot?: React.ReactNode;
  title?: string;
}) {
  return (
    <div className={cx(CARD, "px-5 py-4")} title={title}>
      <div className="flex items-center gap-2.5">
        <span className={cx("flex size-8 flex-none items-center justify-center rounded-[8px]", TINT[tint])}>
          <SalesIcon name={icon} size={17} />
        </span>
        <span className="text-[13px] font-medium text-muted">{label}</span>
      </div>
      <div className="mt-3 text-[28px] leading-8 font-semibold tracking-[-0.02em] text-ink tabular-nums">{value}</div>
      {foot ? <div className="mt-1.5 text-[12px] text-muted">{foot}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------- the team */

type Status = "out" | "done" | "notIn" | "closed";
type Filter = "all" | Status;
type SortKey = "status" | "name" | "visits" | "orders" | "value" | "collected" | "route";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "out", label: "Out now" },
  { key: "done", label: "Finished" },
  { key: "notIn", label: "Not started" },
  { key: "closed", label: "Closed" },
];

function statusOf(p: SalesmanDay): Status {
  if (!p.active) return "closed";
  if (!p.checkInAt) return "notIn";
  return p.checkOutAt ? "done" : "out";
}

/** The page that opens for one man: his map and his whole day, in a new tab. */
function dayHref(p: SalesmanDay, day: string, isToday: boolean): string {
  return `/sales/live/${p.id}${isToday ? "" : `?day=${day}`}`;
}

/**
 * THE TEAM, AS A TABLE THAT SCROLLS DOWN AND NEVER ACROSS.
 *
 * It was a card per salesman, which reads well at seven and is a wall at seven
 * hundred: every card the same size whatever it has to say, three to a row,
 * and no way to find one man but to read them all. A table is the shape a
 * list of hundreds takes — one line each, searchable, filtered by status with
 * the count on every tab, sortable by any figure — and it lives in a box of
 * its own height so the page above it stays put while it scrolls. Narrow
 * columns, so it fits beside the sidebar at 1280 with no sideways scroll.
 *
 * A row opens that salesman's whole day in a NEW TAB, because this is the
 * screen a manager keeps open and comes back to.
 */
function TeamTable({ people, day, isToday }: { people: SalesmanDay[]; day: string; isToday: boolean }) {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [sort, setSort] = React.useState<{ key: SortKey; desc: boolean }>({ key: "status", desc: false });

  const counts: Record<Filter, number> = { all: people.length, out: 0, done: 0, notIn: 0, closed: 0 };
  for (const p of people) counts[statusOf(p)] += 1;

  const q = query.trim().toLowerCase();
  const shown = people
    .filter((p) => (filter === "all" || statusOf(p) === filter) && (!q || p.name.toLowerCase().includes(q)))
    .sort((a, b) => {
      const d = compare(a, b, sort.key);
      return (sort.desc ? -d : d) || byName(a, b);
    });

  const head = (key: SortKey, text: string, align: "left" | "right" = "left") => {
    const on = sort.key === key;
    return (
      <th
        className={cx(
          "sticky top-0 z-[1] border-b border-line bg-[#F9FAFB] px-4 py-2.5 text-[12px] font-medium whitespace-nowrap",
          align === "right" ? "text-right" : "text-left",
          on ? "text-ink" : "text-muted",
        )}
        aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}
      >
        <button
          type="button"
          onClick={() => setSort(on ? { key, desc: !sort.desc } : { key, desc: key !== "name" && key !== "status" })}
          className={cx(
            "group inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-medium hover:text-ink",
            align === "right" ? "flex-row-reverse" : "",
          )}
          title="Sort by this column"
        >
          {text}
          <SalesIcon
            name="chevron"
            size={12}
            className={cx(
              "transition-transform",
              on ? (sort.desc ? "rotate-90 text-brand" : "-rotate-90 text-brand") : "rotate-90 opacity-0 group-hover:opacity-60",
            )}
          />
        </button>
      </th>
    );
  };

  return (
    <section className={cx(CARD, "min-w-0 overflow-hidden")}>
      {/* The toolbar is part of the card, so the list reads as one thing. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold text-heading">Team</h2>
          <span className="rounded-full bg-canvas px-2 py-0.5 text-[12px] font-medium text-muted tabular-nums">
            {people.length}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="inline-flex rounded-[8px] bg-canvas p-0.5">
            {FILTERS.filter((f) => f.key === "all" || counts[f.key] > 0 || filter === f.key).map((f) => {
              const on = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={cx(
                    "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[6px] border-0 px-2.5 text-[12px] font-medium whitespace-nowrap transition-colors",
                    on ? "bg-surface text-ink shadow-[0_1px_2px_rgba(16,24,40,0.1)]" : "bg-transparent text-muted hover:text-ink",
                  )}
                >
                  {f.label}
                  <span className={cx("tabular-nums", on ? "text-brand" : "text-faint")}>{counts[f.key]}</span>
                </button>
              );
            })}
          </div>
          <label className="relative block">
            <SalesIcon
              name="search"
              size={15}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search salesmen"
              aria-label="Search salesmen"
              className="h-8 w-[220px] rounded-[8px] border border-line bg-surface pr-2.5 pl-8 text-[13px] text-ink placeholder:text-faint focus:border-brand focus:shadow-[0_0_0_3px_var(--color-brand-soft)] focus:outline-none"
            />
          </label>
        </div>
      </div>

      {people.length === 0 ? (
        <p className="px-5 py-14 text-center text-[13px] text-muted">Nobody holds the Salesman App yet.</p>
      ) : (
        <div className="max-h-[calc(100vh-300px)] min-h-[320px] overflow-y-auto">
          <table className="w-full table-fixed border-collapse text-[13px]">
            <colgroup>
              <col />
              <col className="w-[170px]" />
              <col className="w-[76px]" />
              <col className="w-[76px]" />
              <col className="w-[112px]" />
              <col className="w-[112px]" />
              <col className="w-[150px]" />
              <col className="w-[40px]" />
            </colgroup>
            <thead>
              <tr>
                {head("name", "Salesman")}
                {head("status", "Status")}
                {head("visits", "Visits", "right")}
                {head("orders", "Orders", "right")}
                {head("value", "Order value", "right")}
                {head("collected", "Collected", "right")}
                {head("route", "Planned route")}
                <th className="sticky top-0 z-[1] border-b border-line bg-[#F9FAFB]" />
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-muted">
                    Nobody matches that.
                  </td>
                </tr>
              ) : (
                shown.map((p) => <PersonRow key={p.id} p={p} href={dayHref(p, day, isToday)} />)
              )}
            </tbody>
          </table>
        </div>
      )}
      {people.length ? (
        <div className="border-t border-line bg-[#F9FAFB] px-4 py-2 text-[12px] text-muted">
          Showing {shown.length} of {people.length} · click a row to open that salesman&rsquo;s day in a new tab
        </div>
      ) : null}
    </section>
  );
}

function compare(a: SalesmanDay, b: SalesmanDay, key: SortKey): number {
  switch (key) {
    case "status":
      return rank(a) - rank(b);
    case "name":
      return byName(a, b);
    case "visits":
      return Number(a.visits) - Number(b.visits);
    case "orders":
      return Number(a.orders) - Number(b.orders);
    case "value":
      return Number(a.orderValuePaise) - Number(b.orderValuePaise);
    case "collected":
      return Number(a.collectedPaise) - Number(b.collectedPaise);
    case "route":
      return ratio(a) - ratio(b);
  }
}

/** "Person 2" before "Person 10" — names carry numbers often enough to matter. */
const byName = (a: SalesmanDay, b: SalesmanDay) =>
  a.name.localeCompare(b.name, "en-IN", { numeric: true, sensitivity: "base" });
const ratio = (p: SalesmanDay) => (p.plannedStops ? p.walkedStops / p.plannedStops : -1);

/** Out, then finished, then not started, then closed accounts. */
function rank(p: SalesmanDay): number {
  if (!p.active) return 3;
  if (p.checkInAt && !p.checkOutAt) return 0;
  if (p.checkInAt) return 1;
  return 2;
}

function PersonRow({ p, href }: { p: SalesmanDay; href: string }) {
  const status = !p.active
    ? { word: "Account closed", pill: "bg-canvas text-muted", dot: "bg-faint" }
    : !p.checkInAt
      ? { word: "Not started", pill: "bg-danger-soft text-danger", dot: "bg-danger" }
      : p.checkOutAt
        ? { word: `Finished ${clock(p.checkOutAt)}`, pill: "bg-canvas text-body", dot: "bg-faint" }
        : { word: `Out since ${clock(p.checkInAt)}`, pill: "bg-success-soft text-success", dot: "bg-success" };
  const unverified = Number(p.unverifiedVisits);
  const pct = p.plannedStops ? Math.min(100, Math.round((p.walkedStops / p.plannedStops) * 100)) : 0;

  return (
    <tr
      onClick={(e) => {
        /* The name is a real link (middle-click, copy address); the rest of
           the row is a convenience that does the same. */
        if ((e.target as HTMLElement).closest("a")) return;
        window.open(href, "_blank", "noopener");
      }}
      className="group cursor-pointer border-b border-divider transition-colors last:border-b-0 hover:bg-[#F7F5FF]"
      title={`Open ${p.name}'s day in a new tab`}
    >
      <td className="px-4 py-2.5">
        <span className="flex min-w-0 items-center gap-3">
          <span
            className={cx(
              "flex size-8 flex-none items-center justify-center rounded-full text-[11px] font-semibold",
              p.active ? avatarTone(p.name) : "bg-canvas text-faint",
            )}
          >
            {p.initials}
          </span>
          <a
            href={href}
            target="_blank"
            rel="noopener"
            className="min-w-0 truncate font-medium text-ink no-underline group-hover:text-brand hover:underline"
          >
            {p.name}
          </a>
        </span>
      </td>
      <td className="px-4 py-2.5">
        <span
          className={cx(
            "inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium",
            status.pill,
          )}
        >
          <span className={cx("block size-1.5 flex-none rounded-full", status.dot)} />
          <span className="truncate">{status.word}</span>
        </span>
        {p.withinGeofence === false ? (
          <span className="mt-0.5 block text-[11px] text-warn-ink" title="Punched in outside the permitted radius">
            Punched in off site
          </span>
        ) : null}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums">
        <span className={p.visits ? "font-medium text-ink" : "text-faint"}>{p.visits}</span>
        {unverified ? (
          <span className="block text-[11px] text-warn-ink" title="Visits saved without the checks passing">
            {unverified} unverified
          </span>
        ) : null}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums">
        <span className={p.orders ? "font-medium text-ink" : "text-faint"}>{p.orders || "—"}</span>
      </td>
      <td className="truncate px-4 py-2.5 text-right tabular-nums" title="Captured in the field, before accounts approve it">
        <span className={Number(p.orderValuePaise) ? "text-ink" : "text-faint"}>
          {Number(p.orderValuePaise) ? money(p.orderValuePaise) : "—"}
        </span>
      </td>
      <td
        className="truncate px-4 py-2.5 text-right tabular-nums"
        title="Reported by the salesman; confirmed only once accounts find it in the bank"
      >
        <span className={Number(p.collectedPaise) ? "text-ink" : "text-faint"}>
          {Number(p.collectedPaise) ? money(p.collectedPaise) : "—"}
        </span>
      </td>
      <td className="px-4 py-2.5">
        {p.plannedStops ? (
          <span className="flex items-center gap-2" title={`${p.walkedStops} of ${p.plannedStops} planned stops`}>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-divider">
              <span
                className={cx("block h-full rounded-full", pct >= 100 ? "bg-success" : "bg-brand")}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="flex-none text-[12px] text-muted tabular-nums">
              {p.walkedStops}/{p.plannedStops}
            </span>
          </span>
        ) : (
          <span className="text-[12px] text-faint">No route</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <span className="flex justify-end">
          <SalesIcon
            name="chevron"
            size={16}
            className="text-line-strong transition-transform group-hover:translate-x-0.5 group-hover:text-brand"
          />
        </span>
      </td>
    </tr>
  );
}

/**
 * `09:32`, in Asia/Kolkata — named rather than left to the browser, because
 * this renders on the server too and the server is UTC.
 */
function clock(at: Date | string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}
