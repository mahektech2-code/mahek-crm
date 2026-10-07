"use client";

import Link from "next/link";
import { addDays } from "@/lib/business-date";
import { money } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import { CardGrid } from "@/components/ui/card-grid";
import type { SalesmanDay, TeamDay } from "@/lib/services/sales-service";

/* ---------------------------------------------------------------------------
 * Today — the Sales Dashboard's front door.
 *
 * FOUR FIGURES, A CARD PER SALESMAN, AND WHAT IS WAITING. It used to be a
 * sentence-heavy subtitle, an attention band repeating the right-hand column,
 * a nine-column table, a footnote about which money is which, and a panel
 * explaining why it was empty. A manager opening this at nine wants to know
 * who is out and what needs him; everything else is one click away.
 *
 * **A card opens that salesman's day in a new tab** — the Live map focused on
 * him, with every visit he made that day beneath it (`/sales/live?salesman=`).
 * A new tab because this screen is the one a manager keeps open and comes back
 * to; replacing it to look at one man would cost him his place.
 *
 * **Not started is the loud state**, for the reason the old red row edge gave:
 * nothing is wrong on that card, which is exactly why it is easy to miss.
 *
 * **The money still says which kind it is** — on the figure's hover rather
 * than in a paragraph under the table. Orders are captured, not approved;
 * collections are reported, not confirmed against the bank.
 * ------------------------------------------------------------------------- */

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
  /** The right-hand column: what is waiting on this manager, and where. */
  waiting: Array<{ href: string; label: string; sub: string; count: number; tone: string }>;
}) {
  const { totals, people } = data;
  const open = waiting.filter((w) => w.count > 0);
  const totalWaiting = waiting.reduce((n, w) => n + w.count, 0);

  /* Who is out first, then who finished, then who never started — the order a
     manager reads a day in. */
  const ordered = [...people].sort((a, b) => rank(a) - rank(b));

  return (
    <div className="space-y-5 px-6 py-5">
      {/* ------------------------------------------------------------ heading */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] leading-7 font-semibold text-ink">{greeting}</h1>
          <p className="text-[13px] text-muted">{dayLabel}</p>
        </div>
        <div className="flex flex-none items-center gap-2">
          <div className="inline-flex h-8 items-stretch overflow-hidden rounded-[4px] border border-line bg-surface text-[13px]">
            <Link
              href={`/sales?day=${addDays(day, -1)}`}
              className="inline-flex w-8 items-center justify-center text-body no-underline hover:bg-canvas hover:no-underline"
              title="The day before"
            >
              ←
            </Link>
            {isToday ? null : (
              <Link
                href="/sales"
                className="inline-flex items-center border-x border-line px-2.5 text-body no-underline hover:bg-canvas hover:no-underline"
              >
                Today
              </Link>
            )}
            <Link
              href={`/sales?day=${addDays(day, 1)}`}
              className={cx(
                "inline-flex w-8 items-center justify-center text-body no-underline hover:bg-canvas hover:no-underline",
                isToday ? "border-l border-line" : "",
              )}
              title="The day after"
            >
              →
            </Link>
          </div>
          <Link
            href="/sales/live"
            target="_blank"
            className="inline-flex h-8 items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Team map
          </Link>
          {totalWaiting > 0 ? (
            <Link
              href="/sales/approvals"
              className="inline-flex h-8 items-center rounded-[4px] bg-brand px-3 text-[13px] font-medium text-white no-underline hover:opacity-90 hover:no-underline"
            >
              Review {totalWaiting}
            </Link>
          ) : null}
        </div>
      </div>

      {/* ------------------------------------------------------------ figures */}
      <CardGrid min={170} gap="gap-3">
        <Stat
          label={isToday ? "Out now" : "Punched in"}
          value={`${totals.checkedIn}/${totals.outOf}`}
          tone={totals.outOf && totals.checkedIn === 0 ? "danger" : undefined}
        />
        <Stat
          label="Visits"
          value={String(totals.visits)}
          foot={totals.plannedStops ? `${totals.walkedStops}/${totals.plannedStops} planned stops` : undefined}
        />
        <Stat
          label="Orders"
          value={String(totals.orders)}
          foot={totals.orderValuePaise ? money(totals.orderValuePaise) : undefined}
          title="Captured in the field. Sits at pending approval until accounts decide it."
        />
        <Stat
          label="Collected"
          value={money(totals.collectedPaise)}
          title="What salesmen report collecting. It is money the business has seen only once accounts confirm it against the bank."
        />
      </CardGrid>

      <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-5">
        {/* ---------------------------------------------------------- team */}
        <section className="min-w-0">
          <h2 className="mb-2 text-[15px] font-semibold text-ink">Team</h2>
          {people.length === 0 ? (
            <p className="rounded-[6px] border border-line bg-surface px-5 py-10 text-center text-[13px] text-muted">
              Nobody holds the Salesman App yet.
            </p>
          ) : (
            <CardGrid min={230} gap="gap-3">
              {ordered.map((p) => (
                <PersonCard key={p.id} p={p} day={day} isToday={isToday} />
              ))}
            </CardGrid>
          )}
        </section>

        {/* ------------------------------------------------- waiting on you */}
        <section>
          <h2 className="mb-2 text-[15px] font-semibold text-ink">Waiting on you</h2>
          <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
            {open.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-muted">All clear.</p>
            ) : (
              open.map((w, i) => (
                <Link
                  key={w.label}
                  href={w.href}
                  title={w.sub}
                  className={cx(
                    "flex items-center gap-3 px-4 py-2.5 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline",
                    i ? "border-t border-divider" : "",
                  )}
                >
                  <span
                    className={cx(
                      "block size-2 flex-none rounded-full",
                      w.tone === "danger"
                        ? "bg-danger"
                        : w.tone === "amber" || w.tone === "warn"
                          ? "bg-warn"
                          : "bg-line-strong",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{w.label}</span>
                  <span className="flex-none font-semibold text-ink tabular-nums">{w.count}</span>
                </Link>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** Out, then finished, then not started, then closed accounts. */
function rank(p: SalesmanDay): number {
  if (!p.active) return 3;
  if (p.checkInAt && !p.checkOutAt) return 0;
  if (p.checkInAt) return 1;
  return 2;
}

function Stat({
  label,
  value,
  foot,
  tone,
  title,
}: {
  label: string;
  value: string;
  foot?: string;
  tone?: "danger";
  title?: string;
}) {
  return (
    <div className="rounded-[6px] border border-line bg-surface px-4 py-3" title={title}>
      <div className="text-[12px] text-muted">{label}</div>
      <div
        className={cx(
          "mt-0.5 text-[22px] leading-7 font-semibold tabular-nums",
          tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {value}
      </div>
      {foot ? <div className="text-[12px] text-muted tabular-nums">{foot}</div> : null}
    </div>
  );
}

/**
 * One salesman's day, on a card that opens it.
 *
 * The status reads in one word — out, finished, not started — and the three
 * figures beneath it are the day's work. Everything else about him is on the
 * page the card opens.
 */
function PersonCard({ p, day, isToday }: { p: SalesmanDay; day: string; isToday: boolean }) {
  const status = !p.active
    ? { word: "Account closed", dot: "bg-line-strong", text: "text-muted" }
    : !p.checkInAt
      ? { word: "Not started", dot: "bg-danger", text: "text-danger" }
      : p.checkOutAt
        ? { word: `Finished ${clock(p.checkOutAt)}`, dot: "bg-line-strong", text: "text-muted" }
        : { word: `Out since ${clock(p.checkInAt)}`, dot: "bg-success", text: "text-success" };

  const unverified = Number(p.unverifiedVisits);
  const href = `/sales/live?salesman=${p.id}&view=today${isToday ? "" : `&day=${day}`}`;

  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener"
      title={`Open ${p.name}'s map and visits in a new tab`}
      className={cx(
        "group block rounded-[6px] border bg-surface px-4 py-3 no-underline transition-colors hover:border-brand hover:no-underline",
        p.active && !p.checkInAt ? "border-danger/40" : "border-line",
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cx(
            "flex size-9 flex-none items-center justify-center rounded-full text-[12px] font-semibold",
            p.checkInAt ? "bg-brand-soft text-[#5223E0]" : "bg-divider text-muted",
          )}
        >
          {p.initials}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink">{p.name}</span>
          <span className={cx("flex items-center gap-1.5 text-[12px]", status.text)}>
            <span className={cx("block size-1.5 flex-none rounded-full", status.dot)} />
            <span className="truncate">{status.word}</span>
            {p.withinGeofence === false ? (
              <span className="text-warn-ink" title="Punched in outside the permitted radius">
                · off site
              </span>
            ) : null}
          </span>
        </span>
        <span className="flex-none text-muted opacity-0 transition-opacity group-hover:opacity-100" aria-hidden>
          ↗
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-divider pt-2.5">
        <Figure
          label="Visits"
          value={String(p.visits)}
          extra={unverified ? `${unverified} unverified` : undefined}
        />
        <Figure label="Orders" value={p.orders ? String(p.orders) : "—"} />
        <Figure
          label="Collected"
          value={Number(p.collectedPaise) ? money(p.collectedPaise) : "—"}
        />
      </div>

      {p.plannedStops ? (
        <div className="mt-2.5">
          <div className="h-1 overflow-hidden rounded-full bg-divider">
            <div
              className="h-full rounded-full bg-brand"
              style={{ width: `${Math.min(100, (p.walkedStops / p.plannedStops) * 100)}%` }}
            />
          </div>
          <div className="mt-1 text-[11px] text-muted tabular-nums">
            {p.walkedStops} of {p.plannedStops} planned stops
          </div>
        </div>
      ) : (
        <div className="mt-2.5 text-[11px] text-muted">No route planned</div>
      )}
    </Link>
  );
}

function Figure({ label, value, extra }: { label: string; value: string; extra?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="truncate text-sm font-semibold text-ink tabular-nums" title={extra}>
        {value}
        {extra ? <span className="ml-1 text-[11px] font-normal text-warn-ink">!</span> : null}
      </div>
    </div>
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
