"use client";

import Link from "next/link";
import { addDays } from "@/lib/business-date";
import { money } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import type { TeamDay } from "@/lib/services/sales-service";
import { SalesIcon } from "./icons";
import { Cell, HeadCell, Pill, Row, Table } from "./parts";

/* ---------------------------------------------------------------------------
 * Today, from `MBOS Manager Console.dc.html`.
 *
 * The design's shape, and it is a good one: a greeting that carries the day's
 * numbers in its subtitle, a band of everything needing attention, then two
 * columns — where the team IS on the left, what is waiting on YOU on the right.
 *
 * Four things ported deliberately rather than approximated:
 *
 * **The attention band lists only what is non-zero.** A row of counters half
 * of them reading nought is a screen somebody stops scanning.
 *
 * **A salesman who has not started has a red left edge on his row.** The
 * design puts the loudest mark on the quietest fact — nothing is wrong with
 * that row, which is exactly why it is easy to miss.
 *
 * **The money says which kind of money it is.** An order taken in the field is
 * the customer saying yes and nothing more; a collection is money a salesman
 * says he has. Neither has reached the bank, and both are labelled.
 *
 * **"What the numbers say" is absent, not stubbed.** The design has an AI brief
 * panel there. Nothing in MahekOne writes one, and a panel of plausible
 * sentences nobody generated is the fixture problem that emptied half the Admin
 * Console. The column carries what can actually be answered.
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
  const notStarted = people.filter((p) => p.active && !p.checkInAt);
  const unverified = people.reduce((n, p) => n + Number(p.unverifiedVisits), 0);

  /* Only what is non-zero, in the design's order and its own words. */
  const attention = [
    { n: notStarted.length, label: "not checked in", tone: "danger", href: "/sales/attendance" },
    { n: waiting.find((w) => w.href === "/sales/orders")?.count ?? 0, label: "orders over the limit", tone: "danger", href: "/sales/orders" },
    { n: waiting.find((w) => w.href === "/sales/expenses")?.count ?? 0, label: "expense claims", tone: "amber", href: "/sales/expenses" },
    { n: waiting.find((w) => w.href === "/sales/samples")?.count ?? 0, label: "samples with no feedback", tone: "amber", href: "/sales/samples" },
    { n: waiting.find((w) => w.href === "/sales/leave")?.count ?? 0, label: "leave requests", tone: "neutral", href: "/sales/leave" },
    { n: unverified, label: "visits that could not be verified", tone: "amber", href: "/sales/visits" },
  ].filter((x) => x.n > 0);

  const totalWaiting = waiting.reduce((n, w) => n + w.count, 0);

  return (
    <div className="px-6 py-5">
      {/* ------------------------------------------------------------ heading */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[26px] leading-8 font-semibold text-ink">{greeting}</div>
          <div className="mt-1 text-[13px] text-muted">
            {dayLabel}
            {" · "}
            {totals.plannedStops
              ? `${totals.walkedStops} of ${totals.plannedStops} planned stops done`
              : "no routes planned"}
            {" · "}
            {money(totals.collectedPaise)} reported collected
          </div>
        </div>
        <div className="flex flex-none gap-2">
          <div className="flex items-center gap-1 text-[13px]">
            <Link
              href={`/sales?day=${addDays(day, -1)}`}
              className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            >
              ←
            </Link>
            {isToday ? null : (
              <Link
                href="/sales"
                className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
              >
                Today
              </Link>
            )}
            <Link
              href={`/sales?day=${addDays(day, 1)}`}
              className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            >
              →
            </Link>
          </div>
          {totalWaiting > 0 ? (
            <Link
              href="/sales/approvals"
              className="inline-flex h-8.5 items-center rounded-[4px] bg-brand px-3 text-sm font-medium text-white no-underline hover:opacity-90 hover:no-underline"
            >
              Review {totalWaiting} {totalWaiting === 1 ? "approval" : "approvals"}
            </Link>
          ) : null}
        </div>
      </div>

      {/* ----------------------------------------------------- attention band */}
      {attention.length ? (
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[6px] border border-line bg-surface px-5 py-3">
          <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Needs you today
          </span>
          {attention.map((a) => (
            <Link
              key={a.label}
              href={a.href}
              className="flex items-center gap-2 text-[13px] text-body no-underline hover:no-underline"
            >
              <span
                className={cx(
                  "block h-2 w-2 flex-none rounded-full",
                  a.tone === "danger"
                    ? "bg-danger"
                    : a.tone === "amber"
                      ? "bg-warn"
                      : "bg-line-strong",
                )}
              />
              <span className="text-[15px] font-semibold text-ink tabular-nums">{a.n}</span>
              <span>{a.label}</span>
            </Link>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-4">
        <div className="min-w-0 space-y-4">
          {/* ------------------------------------------- where the team is */}
          <section>
            {/*
              THE HEADING SITS ABOVE THE TABLE RATHER THAN IN A CARD WITH IT,
              which is the one structural change this conversion costs.

              `Table` IS the card — it draws the border, the rounding and the
              surface itself — so left inside the bordered `<section>` this used
              to be, it would draw a second border a pixel inside the first, and
              the console's front door would be the only screen in the app
              wearing a double rule. Every other screen here states its title in
              plain text above the table and lets the table be the box; this now
              does the same, so Today looks like the eight screens it links to
              rather than like a fork of them.
            */}
            <header className="mb-1.5 flex items-start justify-between gap-4">
              <div>
                <div className="text-[15px] font-semibold text-ink">
                  Where the team is right now
                </div>
                <div className="mt-0.5 text-[13px] text-muted">
                  {totals.checkedIn} of {totals.outOf} checked in
                  {notStarted.length
                    ? ` · ${notStarted.map((p) => p.name).join(", ")} ${notStarted.length === 1 ? "has" : "have"} not started`
                    : " · everybody is out"}
                </div>
              </div>
              <Link
                href="/sales/live"
                className="inline-flex h-8 flex-none items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] text-body no-underline hover:bg-canvas hover:no-underline"
              >
                Open the map
              </Link>
            </header>

            {people.length === 0 ? (
              /* The empty state keeps a box of its own: it stands where the
                 table would have stood, and a sentence floating on the canvas
                 reads as a section that failed to render rather than as one
                 with nothing in it. */
              <p className="rounded-[6px] border border-line bg-surface px-5 py-12 text-center text-[15px] text-muted">
                Nobody holds the Salesman App yet. The field team is whoever has been granted it —
                that is what MBOS sign-in checks, so this list and the handsets always agree.
              </p>
            ) : (
              /*
                The console's own table, not a second one.

                This screen hand-rolled its `<table>` and every `<th>`/`<td>`
                class, which is how it came to be the one table in the app at
                14px horizontal padding while the other twenty-odd sat at 16 —
                a drift nobody introduced deliberately and nobody could see
                without two screens open side by side. The widths below sum to
                the 940 this table has always asked for, and every column states
                one because `Table` is `table-fixed`: a column with no width is
                a column the browser guesses at, and a guessed-narrow one now
                CLIPS rather than overflowing, so the guess is silent.

                They are sized to the widest thing each column really holds
                rather than to its heading: 130 on the second is the `NOT
                STARTED` pill, which is half again the width of the `08:42` it
                replaces, and 190 on Where is `Finished 18:30` with the `off
                site` mark beside it. Visits, Orders and Route are each at their
                own heading's width, which is what bounds them.
              */
              <Table
                minWidth={940}
                head={
                  <>
                    <HeadCell width={230}>Salesman</HeadCell>
                    <HeadCell width={130}>Punched in</HeadCell>
                    <HeadCell width={190}>Where</HeadCell>
                    <HeadCell align="right" width={85}>
                      Visits
                    </HeadCell>
                    <HeadCell align="right" width={80}>
                      Orders
                    </HeadCell>
                    <HeadCell align="right" width={115}>
                      Collected
                    </HeadCell>
                    <HeadCell width={110}>Route</HeadCell>
                  </>
                }
              >
                {people.map((p, i) => {
                  const missing = p.active && !p.checkInAt;
                  return (
                    <Row key={p.id} striped={i % 2 === 1}>
                      {/*
                        THE RED EDGE ON A ROW THAT HAS NOT STARTED, which is the
                        one thing here the primitives cannot say for themselves.
                        `Row` colours its left border for `selected` and for
                        nothing else, and `selected` means brand — a different
                        statement altogether, and the wrong one about a salesman
                        who is not out. So the border is set on the FIRST CELL
                        instead, which lands in exactly the same place: the table
                        is `border-collapse`, so the row's own 3px transparent
                        left border and this one collapse into a single edge, and
                        the cell's colour wins that contest. Widening `Row` to
                        take a tone would have been the other answer, and it is
                        not this file's to make.

                        `h-13` is kept for the reason it was there before: the
                        two-line name makes the row that tall anyway, so it only
                        does anything on a row where the second line is short,
                        and a list of people whose rows change height is one that
                        reads as broken rather than as sparse.
                      */}
                      <Cell className={cx("h-13", missing ? "border-l-[3px] border-l-danger" : "")}>
                        <Link
                          href={`/sales/people/${p.id}`}
                          className="flex items-center gap-2.5 no-underline hover:no-underline"
                        >
                          <span
                            className={cx(
                              "flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-semibold",
                              p.checkInAt ? "bg-brand-soft text-[#5223E0]" : "bg-divider text-muted",
                            )}
                          >
                            {p.initials}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-ink">
                              {p.name}
                            </span>
                            <span className="block truncate text-[12px] text-muted">
                              {p.active ? "Field sales" : "Account closed"}
                            </span>
                          </span>
                        </Link>
                      </Cell>
                      <Cell>
                        {/* The hand-written span here was `Pill` spelled out by
                            hand, down to the 9px radius — the same copy the
                            shared control exists to stop being made a
                            thirteenth time. */}
                        <Pill tone={p.checkInAt ? "success" : "danger"}>
                          {p.checkInAt ? clock(p.checkInAt) : "Not started"}
                        </Pill>
                      </Cell>
                      <Cell>
                        {p.checkInAt ? (
                          p.checkOutAt ? (
                            `Finished ${clock(p.checkOutAt)}`
                          ) : (
                            "Out now"
                          )
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                        {p.withinGeofence === false ? (
                          <span
                            className="ml-1.5 text-[12px] text-warn-ink"
                            title="Punched in outside the permitted radius. Flagged, never blocked — a salesman who cannot mark attendance cannot work."
                          >
                            off site
                          </span>
                        ) : null}
                      </Cell>
                      <Cell align="right">
                        {p.visits}
                        {Number(p.unverifiedVisits) > 0 ? (
                          <span
                            className="ml-1 text-warn-ink"
                            title="Saved with the location checklist unsatisfied. The salesman gave a reason — a visit can always be saved."
                          >
                            ({p.unverifiedVisits})
                          </span>
                        ) : null}
                      </Cell>
                      <Cell align="right">{p.orders || <span className="text-muted">—</span>}</Cell>
                      <Cell align="right">
                        {Number(p.collectedPaise) ? (
                          money(p.collectedPaise)
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </Cell>
                      <Cell>
                        {p.plannedStops ? (
                          <span className="tabular-nums">
                            {p.walkedStops}/{p.plannedStops}
                          </span>
                        ) : (
                          <Link href={`/sales/journeys?salesman=${p.id}`} className="text-[13px]">
                            Plan a route
                          </Link>
                        )}
                      </Cell>
                    </Row>
                  );
                })}
              </Table>
            )}
          </section>

          <p className="text-[13px] text-pretty text-muted">
            Order value is what was captured in the field. An MBOS order sits at pending approval
            until accounts decide it, so nothing here has counted towards a target or an
            outstanding balance. Money reported is what a salesman says he collected — it becomes
            money the business has seen when accounts confirm it against the bank.
          </p>
        </div>

        {/* ------------------------------------------------- waiting on you */}
        <div className="space-y-4">
          <section className="overflow-hidden rounded-[6px] border border-line bg-surface">
            <div className="border-b border-line px-4 py-3 text-[15px] font-semibold text-ink">
              Waiting on you
            </div>
            {waiting.every((w) => w.count === 0) ? (
              <p className="px-4 py-8 text-center text-[13px] text-muted">
                Nothing is waiting on a decision.
              </p>
            ) : (
              waiting
                .filter((w) => w.count > 0)
                .map((w, i) => (
                  <Link
                    key={w.href}
                    href={w.href}
                    className={cx(
                      "flex w-full items-center gap-3 px-4 py-3 no-underline hover:bg-canvas hover:no-underline",
                      i ? "border-t border-canvas" : "",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">{w.label}</span>
                      <span className="block text-[12px] text-muted">{w.sub}</span>
                    </span>
                    <span
                      className={cx(
                        "flex-none text-lg font-semibold tabular-nums",
                        w.tone === "danger"
                          ? "text-danger"
                          : w.tone === "amber"
                            ? "text-warn-ink"
                            : "text-ink",
                      )}
                    >
                      {w.count}
                    </span>
                  </Link>
                ))
            )}
          </section>

          <section className="rounded-[6px] border border-line bg-surface px-4 py-3.5">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-muted">
                <SalesIcon name="spark" size={16} />
              </span>
              <span className="text-[15px] font-semibold text-ink">What the numbers say</span>
            </div>
            <p className="text-[13px] text-pretty text-muted">
              The design puts a written brief here — three sentences about who is behind and what
              to do about it. Nothing in MahekOne writes one yet, and a panel of plausible
              sentences nobody generated is worse than an empty one: it gets believed. It will fill
              when there is something honest to put in it.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

/** A day either side, without dragging a date library into a client component. */

/**
 * `09:32`, in Asia/Kolkata.
 *
 * Named rather than left to the browser: this renders on the server too, the
 * server is UTC, and a punch-in at half past nine would print as four in the
 * morning — which reads as a handset writing rows in the night.
 */
function clock(at: Date | string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}
