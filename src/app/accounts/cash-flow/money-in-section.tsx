"use client";

import * as React from "react";
import Link from "next/link";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { Button, cx } from "@/components/ui/primitives";
import type { ExpectedIn, PayingHabit } from "@/lib/engines/cash-flow";
import { addDays, dateRange, WEEKDAY_SHORT, weekdayOf } from "@/lib/engines/vendor-payouts";
import { longDate, money, moneyShort, shortDate } from "@/lib/format";
import { Cell, Empty, HeadCell, MetricRow, Row, Table, plural } from "../parts";
import { InfoTip } from "./info-tip";
import { Segmented } from "./payouts-section";

/* ---------------------------------------------------------------------------
 * MONEY IN — when each open bill is expected, from how its customer pays.
 *
 * Not the credit term: a shop on 30 days that always pays at 52 is drawn at
 * 52. Customers down the side, dates along the top, every day a column
 * because customers pay on any day. Nothing here is dragged — a prediction is
 * not a plan anybody can move — and money a customer is already late with
 * against their own habit sits in the first column rather than on today,
 * because counting it into today's total is how a plan learns to lie.
 * ------------------------------------------------------------------------- */

const WEEKS = 4;
const DAY_COL = 104;
const NAME_COL = 230;
const LATE_COL = 140;

export type CashInProps = {
  items: ExpectedIn[];
  companyHabit: PayingHabit | null;
  minSamples: number;
  lookbackMonths: number;
  borrowed: number;
  unpredicted: { count: number; amountPaise: number };
};

const BASIS_WORD: Record<ExpectedIn["basis"], string> = {
  own: "payment pattern",
  company: "company average",
  reported: "unconfirmed receipt",
};

export function MoneyInSection({ data, today }: { data: CashInProps; today: string }) {
  const [view, setView] = React.useState<"calendar" | "list">("calendar");
  const [query, setQuery] = React.useState("");
  const [from, setFrom] = React.useState(today);
  const [openCustomer, setOpenCustomer] = React.useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const items = q
    ? data.items.filter((i) => `${i.customerName} ${i.label}`.toLowerCase().includes(q))
    : data.items;

  const sum = (list: ExpectedIn[]) => list.reduce((a, i) => a + i.amountPaise, 0);
  const within = (n: number) => data.items.filter((i) => i.expectedOn >= today && i.expectedOn <= addDays(today, n - 1));
  const late = data.items.filter((i) => i.expectedOn < today);
  const claims = data.items.filter((i) => i.kind === "reported");
  const week = within(7);
  const fortnight = within(14);

  const customerItems = openCustomer ? data.items.filter((i) => i.customerId === openCustomer) : [];

  return (
    <div>

      <MetricRow
        metrics={[
          { label: "Projected · 7 days", value: money(sum(week)), sub: plural(week.length, "receipt"), tone: "success" },
          { label: "Projected · 14 days", value: money(sum(fortnight)), sub: plural(fortnight.length, "receipt") },
          {
            label: "Overdue",
            value: money(sum(late)),
            sub: late.length ? plural(late.length, "invoice") : undefined,
            tone: late.length ? "warn" : undefined,
          },
          {
            label: "Unconfirmed receipts",
            value: money(sum(claims)),
            sub: claims.length ? plural(claims.length, "receipt") : undefined,
          },
          {
            label: "Avg. days to pay",
            value: data.companyHabit ? `${data.companyHabit.avgDays} days` : "—",
            sub: data.companyHabit ? `±${data.companyHabit.spreadDays} days` : undefined,
          },
        ]}
      />

      {data.unpredicted.count ? (
        <div className="mb-3 rounded-[4px] border border-l-[3px] border-warn-line border-l-warn bg-warn-soft px-4 py-2.5 text-[13px] text-warn-ink">
          {money(data.unpredicted.amountPaise)} across {plural(data.unpredicted.count, "invoice")} cannot be projected yet — no
          payment history.
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Segmented
          value={view}
          options={[
            { value: "calendar", label: "Calendar" },
            { value: "list", label: "List" },
          ]}
          onChange={setView}
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search customer or invoice no."
          className="h-8.5 w-[280px] rounded-[4px] border border-line bg-surface px-2.5 text-sm outline-none focus:border-brand"
        />
        <InfoTip>
          Each open invoice is projected from the customer&apos;s average days to pay over the last {data.lookbackMonths}{" "}
          months, not from credit terms.
          {data.companyHabit
            ? ` Customers with fewer than ${data.minSamples} payments use the company average (${data.companyHabit.avgDays} days)${data.borrowed ? ` — ${plural(data.borrowed, "customer")} at present` : ""}.`
            : ""}{" "}
          Unconfirmed receipts are expected on their cheque or reported date.
        </InfoTip>
        {view === "calendar" ? (
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" onClick={() => setFrom(addDays(from, -7))} title="A week earlier">
              ←
            </Button>
            <Button size="sm" onClick={() => setFrom(today)}>
              Today
            </Button>
            <Button size="sm" onClick={() => setFrom(addDays(from, 7))} title="A week later">
              →
            </Button>
            <span className="ml-1 text-[13px] whitespace-nowrap text-muted">
              {shortDate(from)} – {shortDate(addDays(from, WEEKS * 7 - 1))}
            </span>
          </div>
        ) : null}
      </div>

      {items.length === 0 ? (
        <Empty
          title={q ? "No matches" : "No receivables projected"}
          body={q ? "Try a customer name or invoice number." : "All invoices are settled."}
        />
      ) : view === "calendar" ? (
        <InCalendar items={items} from={from} today={today} onOpen={setOpenCustomer} />
      ) : (
        <InList items={items} today={today} onOpen={setOpenCustomer} />
      )}

      <Drawer open={!!openCustomer} onClose={() => setOpenCustomer(null)} width={560} label="Customer receivables">
        {openCustomer ? (
          <CustomerBody key={openCustomer} items={customerItems} today={today} onClose={() => setOpenCustomer(null)} />
        ) : null}
      </Drawer>
    </div>
  );
}

/* --------------------------------------------------------------- calendar */

function InCalendar({
  items,
  from,
  today,
  onOpen,
}: {
  items: ExpectedIn[];
  from: string;
  today: string;
  onOpen: (customerId: string) => void;
}) {
  const dates = dateRange(from, WEEKS * 7);
  const to = dates[dates.length - 1];
  const inWindow = items.filter((i) => (i.expectedOn >= from && i.expectedOn <= to) || i.expectedOn < from);
  const later = items.filter((i) => i.expectedOn > to);

  type R = { id: string; name: string; list: ExpectedIn[]; total: number };
  const byId = new Map<string, R>();
  for (const i of inWindow) {
    let r = byId.get(i.customerId);
    if (!r) {
      r = { id: i.customerId, name: i.customerName, list: [], total: 0 };
      byId.set(i.customerId, r);
    }
    r.list.push(i);
    r.total += i.amountPaise;
  }
  // Biggest first: the cash a plan turns on is the few customers who owe most.
  const rows = [...byId.values()].sort((a, b) => b.total - a.total);

  if (!rows.length) {
    return (
      <Empty
        title="No receipts projected in this period"
        body={
          later.length
            ? `${money(later.reduce((a, i) => a + i.amountPaise, 0))} projected after ${shortDate(to)}.`
            : "Try a later period."
        }
      />
    );
  }

  const columns = `${NAME_COL}px ${LATE_COL}px ${dates.map(() => `${DAY_COL}px`).join(" ")}`;
  const onDay = (d: string) => inWindow.filter((i) => i.expectedOn === d);
  const earlier = inWindow.filter((i) => i.expectedOn < from);
  const total = (list: ExpectedIn[]) => list.reduce((a, i) => a + i.amountPaise, 0);

  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <div className="max-h-[calc(100vh-380px)] min-h-[320px] overflow-auto">
        <div className="grid w-max" style={{ gridTemplateColumns: columns }}>
          <div className="sticky top-0 left-0 z-30 flex h-14 items-end border-r border-b border-line bg-canvas px-3 pb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Customer · {rows.length}
          </div>
          <Head label="Overdue" sub={earlier.length ? `${earlier.length} · ${moneyShort(total(earlier))}` : "—"} warn={earlier.length > 0} />
          {dates.map((d) => {
            const list = onDay(d);
            const wd = weekdayOf(d);
            return (
              <Head
                key={d}
                label={`${WEEKDAY_SHORT[wd - 1]} ${shortDate(d)}`}
                sub={list.length ? `${list.length} · ${moneyShort(total(list))}` : "—"}
                isToday={d === today}
                monday={wd === 1}
                weekend={wd >= 6}
              />
            );
          })}

          {rows.map((r, i) => {
            const stripe = i % 2 === 1;
            return (
              <React.Fragment key={r.id}>
                <button
                  type="button"
                  onClick={() => onOpen(r.id)}
                  className={cx(
                    "sticky left-0 z-10 flex min-h-[58px] cursor-pointer flex-col justify-center border-r border-b border-divider px-3 py-1.5 text-left hover:bg-brand-soft",
                    stripe ? "bg-canvas" : "bg-surface",
                  )}
                >
                  <span className="truncate text-sm font-medium text-ink" title={r.name}>
                    {r.name}
                  </span>
                  <span className="text-[12px] text-muted tabular-nums">{money(r.total)}</span>
                </button>
                <Cell2 stripe={stripe} list={r.list.filter((x) => x.expectedOn < from)} onOpen={onOpen} late />
                {dates.map((d) => (
                  <Cell2
                    key={d}
                    stripe={stripe}
                    list={r.list.filter((x) => x.expectedOn === d)}
                    onOpen={onOpen}
                    isToday={d === today}
                    monday={weekdayOf(d) === 1}
                    weekend={weekdayOf(d) >= 6}
                  />
                ))}
              </React.Fragment>
            );
          })}

          <div className="sticky bottom-0 left-0 z-30 flex h-10 items-center border-t border-r border-line bg-canvas px-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Total
          </div>
          <Foot amount={total(earlier)} warn />
          {dates.map((d) => (
            <Foot key={d} amount={total(onDay(d))} monday={weekdayOf(d) === 1} />
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-[12px] text-muted">
        <Key className="bg-success" label="Payment pattern" />
        <Key className="bg-brand" label="Company average" />
        <Key className="bg-ink" label="Unconfirmed receipt" />
        <Key className="bg-warn" label="Overdue" />
        {later.length ? (
          <span className="ml-auto">
            After {shortDate(to)}: {money(total(later))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Head({
  label,
  sub,
  isToday,
  monday,
  weekend,
  warn,
}: {
  label: string;
  sub: string;
  isToday?: boolean;
  monday?: boolean;
  weekend?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      className={cx(
        "sticky top-0 z-20 flex h-14 flex-col justify-end border-b border-line px-2 pb-1.5",
        isToday ? "bg-brand-soft" : weekend ? "bg-divider" : "bg-canvas",
        monday && "border-l border-l-line-strong",
        warn !== undefined && "border-r border-r-line",
      )}
    >
      <span className={cx("text-[12px] font-semibold", isToday ? "text-[#5223E0]" : "text-ink")}>
        {isToday ? "Today" : label}
      </span>
      <span className={cx("text-[11px] tabular-nums", warn ? "text-warn-ink" : "text-muted")}>{sub}</span>
    </div>
  );
}

function Foot({ amount, monday, warn }: { amount: number; monday?: boolean; warn?: boolean }) {
  return (
    <div
      className={cx(
        "sticky bottom-0 z-20 flex h-10 items-center border-t border-line bg-canvas px-2 text-[13px] font-semibold tabular-nums",
        warn ? "text-warn-ink" : "text-success",
        monday && "border-l border-l-line-strong",
      )}
    >
      {amount ? moneyShort(amount) : <span className="font-normal text-muted">—</span>}
    </div>
  );
}

const DOT: Record<ExpectedIn["basis"], string> = { own: "bg-success", company: "bg-brand", reported: "bg-ink" };

function Cell2({
  list,
  stripe,
  onOpen,
  isToday,
  monday,
  weekend,
  late,
}: {
  list: ExpectedIn[];
  stripe: boolean;
  onOpen: (id: string) => void;
  isToday?: boolean;
  monday?: boolean;
  weekend?: boolean;
  late?: boolean;
}) {
  const total = list.reduce((a, i) => a + i.amountPaise, 0);
  return (
    <div
      className={cx(
        "border-b border-divider p-1",
        late && "border-r border-r-line",
        monday && "border-l border-l-line-strong",
        isToday ? "bg-brand-soft/40" : weekend ? "bg-canvas" : stripe ? "bg-canvas" : "bg-surface",
      )}
    >
      {list.length ? (
        <button
          type="button"
          onClick={() => onOpen(list[0].customerId)}
          title={list
            .map((i) => `${i.label} · ${money(i.amountPaise)} · ${BASIS_WORD[i.basis]}${i.lateDays ? ` · ${i.lateDays}d overdue` : ""}`)
            .join("\n")}
          className={cx(
            "block w-full cursor-pointer rounded-[4px] border border-l-[3px] px-1.5 py-1 text-left hover:shadow-[0_1px_4px_rgba(22,22,22,0.12)]",
            late ? "border-warn-line border-l-warn bg-warn-soft" : "border-line border-l-success bg-success-soft/60",
          )}
        >
          <span className="block text-[12px] font-semibold text-ink tabular-nums">{moneyShort(total)}</span>
          <span className="flex items-center gap-1 text-[10px] text-muted">
            {[...new Set(list.map((i) => i.basis))].map((b) => (
              <span key={b} className={cx("block h-1.5 w-1.5 rounded-full", DOT[b])} />
            ))}
            {late ? `${Math.max(...list.map((i) => i.lateDays))}d overdue` : plural(list.length, "invoice")}
          </span>
        </button>
      ) : null}
    </div>
  );
}

function Key({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx("block h-2 w-2 rounded-full", className)} />
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------- list */

function InList({ items, today, onOpen }: { items: ExpectedIn[]; today: string; onOpen: (id: string) => void }) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <Table
        minWidth={1100}
        head={
          <>
            <HeadCell width={120}>Expected date</HeadCell>
            <HeadCell width={240}>Customer</HeadCell>
            <HeadCell width={200}>Invoice / receipt</HeadCell>
            <HeadCell width={100}>Invoice date</HeadCell>
            <HeadCell width={180}>Basis</HeadCell>
            <HeadCell width={130} align="right">
              Amount
            </HeadCell>
            <HeadCell width={130}>Status</HeadCell>
          </>
        }
      >
        {items.map((i, n) => (
          <Row key={i.key} striped={n % 2 === 1} onClick={() => onOpen(i.customerId)}>
            <Cell className={cx(i.expectedOn < today && "font-medium text-warn-ink")}>
              {WEEKDAY_SHORT[weekdayOf(i.expectedOn) - 1]} {shortDate(i.expectedOn)}
            </Cell>
            <Cell truncate={240} className="font-medium text-ink">
              {i.customerName}
            </Cell>
            <Cell truncate={200}>{i.label}</Cell>
            <Cell>{i.billDate ? shortDate(i.billDate) : "—"}</Cell>
            <Cell>
              <span className="flex items-center gap-1.5">
                <span className={cx("block h-2 w-2 rounded-full", DOT[i.basis])} />
                {BASIS_WORD[i.basis]}
                {i.habit ? <span className="text-muted">· {i.habit.avgDays} days</span> : null}
              </span>
            </Cell>
            <Cell align="right" className="font-semibold text-ink">
              {money(i.amountPaise)}
            </Cell>
            <Cell>{whenWords(i, today)}</Cell>
          </Row>
        ))}
      </Table>
    </div>
  );
}

function whenWords(i: ExpectedIn, today: string): React.ReactNode {
  if (i.expectedOn < today) return <span className="text-warn-ink">{i.lateDays}d overdue</span>;
  if (i.expectedOn === today) return <span className="font-medium text-success">Due today</span>;
  const d = Math.round((Date.parse(`${i.expectedOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return <span className="text-muted">In {plural(d, "day")}</span>;
}

/* ----------------------------------------------------------------- drawer */

function CustomerBody({ items, today, onClose }: { items: ExpectedIn[]; today: string; onClose: () => void }) {
  const first = items[0];
  if (!first) return null;
  const habit = items.find((i) => i.basis === "own")?.habit ?? null;
  const borrowed = items.find((i) => i.basis === "company")?.habit ?? null;
  const total = items.reduce((a, i) => a + i.amountPaise, 0);
  const late = items.filter((i) => i.expectedOn < today);
  return (
    <>
      <DrawerHeader onClose={onClose}>
        <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Receivables</div>
        <div className="mt-0.5 truncate text-lg font-semibold text-ink">{first.customerName}</div>
        <div className="mt-1 text-[22px] leading-7 font-semibold text-ink tabular-nums">{money(total)}</div>
      </DrawerHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mb-4 rounded-[6px] border border-line bg-canvas px-4 py-3 text-[13px]">
          {habit ? (
            <>
              <b className="text-ink">Avg. {habit.avgDays} days to pay</b>
              <span className="text-muted">
                {" "}
                · ±{habit.spreadDays} days · {plural(habit.samples, "payment")}
              </span>
            </>
          ) : borrowed ? (
            <>
              <b className="text-ink">Company average applied</b>
              <span className="text-muted"> · {borrowed.avgDays} days to pay</span>
            </>
          ) : (
            <span className="text-muted">Unconfirmed receipts</span>
          )}
          {late.length ? (
            <div className="mt-1 text-warn-ink">
              {money(late.reduce((a, i) => a + i.amountPaise, 0))} overdue
            </div>
          ) : null}
        </div>
        <ul className="space-y-1.5">
          {items.map((i) => (
            <li key={i.key} className="flex items-center gap-3 rounded-[4px] border border-line bg-surface px-3 py-2">
              <span className={cx("block h-2 w-2 flex-none rounded-full", DOT[i.basis])} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-ink">{i.label}</div>
                <div className="text-[12px] text-muted">
                  {i.billDate ? `Invoiced ${shortDate(i.billDate)} · ` : ""}expected {longDate(i.expectedOn)}
                </div>
              </div>
              <span className="text-right">
                <span className="block text-[13px] font-semibold text-ink tabular-nums">{money(i.amountPaise)}</span>
                <span className="block text-[12px]">{whenWords(i, today)}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-none justify-end border-t border-line px-5 py-3">
        <Link href={`/accounts/ledger?customer=${first.customerId}`} className="text-[13px] font-medium text-brand hover:underline">
          Customer ledger →
        </Link>
      </div>
    </>
  );
}
