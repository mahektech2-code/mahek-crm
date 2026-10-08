"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { reschedulePayoutAction } from "@/lib/actions/vendor-payouts";
import {
  addDays,
  dateRange,
  isPaymentDay,
  moveRefusal,
  paymentWeekdays,
  WEEKDAY_NAMES,
  WEEKDAY_SHORT,
  weekdayOf,
  weekStart,
} from "@/lib/engines/vendor-payouts";
import { money, moneyShort, shortDate } from "@/lib/format";
import type { PayoutPo, PayoutSupplier, PayoutView } from "@/lib/services/vendor-payout-service";
import { Cell, Empty, HeadCell, MetricRow, Row, Table, plural } from "../parts";
import { AddPayoutModal } from "./add-payout-modal";
import { InfoTip } from "./info-tip";
import { PayoutDrawer } from "./payout-drawer";
import { StatusPill, TONE_SKIN, sourceWords, toneOf } from "./payout-parts";

/* ---------------------------------------------------------------------------
 * PAYABLES — the vendor payouts side of Cash flow.
 *
 * What Mahek owes its suppliers and the day each will be paid. Two views of
 * one list:
 *
 *  - the CALENDAR — vendors down the side, dates along the top, one card per
 *    payout in the cell for the day it is planned. Dragging a card sideways
 *    plans it for another day; only a payment day (Tuesday to Friday by
 *    default) that has not gone accepts it, and the narrow grey columns are
 *    the days nothing goes out. Anything still unpaid from before the window
 *    sits in the first column, so scrolling forward never hides a debt.
 *  - the LIST — every payout as a row, with its PO, bill and invoices.
 *
 * Every date is an IST calendar date; `today` comes from the server.
 * ------------------------------------------------------------------------- */

type View = "calendar" | "list";
type Filter = "due" | "paid" | "all";

const WEEKS = 5;
const PAY_COL = 168;
const OFF_COL = 34;
const VENDOR_COL = 220;
const EARLIER_COL = 150;

export function PayoutsSection({
  payouts,
  suppliers,
  pos,
  today,
  paymentDays,
  defaultCreditDays,
  modes,
  canEdit,
  canSettle,
}: {
  payouts: PayoutView[];
  suppliers: PayoutSupplier[];
  pos: PayoutPo[];
  today: string;
  paymentDays: string[];
  defaultCreditDays: number;
  modes: string[];
  canEdit: boolean;
  canSettle: boolean;
}) {
  const router = useRouter();
  const { run, push } = useToast();
  const days = React.useMemo(() => paymentWeekdays(paymentDays), [paymentDays]);
  const [view, setView] = React.useState<View>("calendar");
  const [filter, setFilter] = React.useState<Filter>("due");
  const [query, setQuery] = React.useState("");
  const [from, setFrom] = React.useState(today);
  const [moved, setMoved] = React.useState<Record<string, string>>({});
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  // A card dragged moves at once; the server's answer confirms or puts it back.
  const all = React.useMemo(
    () => payouts.map((p) => (moved[p.id] && moved[p.id] !== p.payOn ? { ...p, payOn: moved[p.id] } : p)),
    [payouts, moved],
  );

  const q = query.trim().toLowerCase();
  const shown = all.filter((p) => {
    if (filter === "due" && !(p.status === "open" || p.status === "on_hold")) return false;
    if (filter === "paid" && p.status !== "paid") return false;
    if (filter === "all" && p.status === "cancelled" && view === "calendar") return false;
    if (!q) return true;
    const hay = [
      p.payeeName,
      p.reference,
      p.description,
      p.prNumber != null ? `pr ${p.prNumber}` : null,
      p.poNumber != null ? `po ${p.poNumber}` : null,
      ...p.invoices.map((i) => `${i.kind} ${i.invoiceNo ?? ""}`),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  /* ------------------------------------------------------------ metrics */
  const unpaid = all.filter((p) => p.status === "open");
  const sum = (list: PayoutView[]) => list.reduce((a, p) => a + p.amountPaise, 0);
  const overdue = unpaid.filter((p) => p.payOn < today);
  const thisWeekEnd = addDays(weekStart(today), 6);
  const thisWeek = unpaid.filter((p) => p.payOn >= today && p.payOn <= thisWeekEnd);
  const next30 = unpaid.filter((p) => p.payOn >= today && p.payOn <= addDays(today, 30));
  const held = all.filter((p) => p.status === "on_hold");
  const paidMonth = all.filter((p) => p.status === "paid" && (p.paidOn ?? "").slice(0, 7) === today.slice(0, 7));

  async function move(p: PayoutView, date: string) {
    const why = moveRefusal(date, today, days, p.status);
    if (why) {
      push(why, "error");
      return;
    }
    if (date === p.payOn) return;
    setMoved((m) => ({ ...m, [p.id]: date }));
    const res = await run(reschedulePayoutAction(p.id, date));
    if (res.ok) router.refresh();
    else
      setMoved((m) => {
        const next = { ...m };
        delete next[p.id];
        return next;
      });
  }

  const opened = openId ? (all.find((p) => p.id === openId) ?? null) : null;
  const dayNames = [...days].sort().map((d) => WEEKDAY_NAMES[d - 1]);

  return (
    <div>

      <MetricRow
        metrics={[
          {
            label: "Overdue",
            value: money(sum(overdue)),
            sub: overdue.length ? plural(overdue.length, "payable") : undefined,
            tone: overdue.length ? "danger" : undefined,
          },
          { label: "Due this week", value: money(sum(thisWeek)), sub: plural(thisWeek.length, "payable") },
          { label: "Due in 30 days", value: money(sum(next30)), sub: plural(next30.length, "payable") },
          {
            label: "On hold",
            value: money(sum(held)),
            sub: held.length ? plural(held.length, "payable") : undefined,
            tone: held.length ? "warn" : undefined,
          },
          { label: "Paid this month", value: money(paidMonth.reduce((a, p) => a + (p.paidAmountPaise ?? 0), 0)), sub: paidMonth.length ? plural(paidMonth.length, "payment") : undefined, tone: paidMonth.length ? "success" : undefined },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Segmented
          value={view}
          options={[
            { value: "calendar", label: "Calendar" },
            { value: "list", label: "List" },
          ]}
          onChange={setView}
        />
        <Segmented
          value={filter}
          options={[
            { value: "due", label: "Outstanding" },
            { value: "paid", label: "Paid" },
            { value: "all", label: "All" },
          ]}
          onChange={setFilter}
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search vendor, PO, PR or invoice no."
          className="h-8.5 w-[300px] rounded-[4px] border border-line bg-surface px-2.5 text-sm outline-none focus:border-brand"
        />
        <InfoTip>
          Accounts payable by scheduled payment date. Payment runs are {listWords(dayNames)} (IST). Purchases post
          automatically from the ERP purchase register; other payables can be added manually. Drag a payable to another
          payment run to reschedule it.
        </InfoTip>
        <div className="ml-auto flex items-center gap-1.5">
        {view === "calendar" ? (
          <>
            <Button size="sm" onClick={() => setFrom(addDays(from, -7))} title="A week earlier">
              ←
            </Button>
            <Button size="sm" onClick={() => setFrom(today)}>
              Today
            </Button>
            <Button size="sm" onClick={() => setFrom(addDays(from, 7))} title="A week later">
              →
            </Button>
            <span className="mr-2 ml-1 text-[13px] whitespace-nowrap text-muted">
              {shortDate(from)} – {shortDate(addDays(from, WEEKS * 7 - 1))}
            </span>
          </>
        ) : null}
        {canEdit ? (
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            + Add payable
          </Button>
        ) : null}
        </div>
      </div>

      {shown.length === 0 && view === "list" ? (
        <Empty
          title={filter === "paid" ? "No payments yet" : q ? "No matches" : "No outstanding payables"}
          body={
            filter === "due" && !q
              ? "Purchases post here once rated in the register."
              : filter === "paid"
                ? "Payments from the last six months appear here."
                : "Try a vendor, PO, PR or invoice number."
          }
        />
      ) : view === "calendar" ? (
        <Calendar
          payouts={shown}
          from={from}
          today={today}
          days={days}
          canEdit={canEdit}
          onOpen={setOpenId}
          onMove={move}
        />
      ) : (
        <PayoutList payouts={shown} today={today} onOpen={setOpenId} />
      )}

      <PayoutDrawer
        payout={opened}
        today={today}
        days={days}
        modes={modes}
        canEdit={canEdit}
        canSettle={canSettle}
        onClose={() => setOpenId(null)}
        onMoved={(id, date) => setMoved((m) => ({ ...m, [id]: date }))}
        onChanged={() => router.refresh()}
      />

      {adding ? (
        <AddPayoutModal
          suppliers={suppliers}
          pos={pos}
          today={today}
          days={days}
          defaultCreditDays={defaultCreditDays}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex h-8.5 overflow-hidden rounded-[4px] border border-line bg-surface">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            "cursor-pointer px-3 text-[13px] font-medium",
            value === o.value ? "bg-brand-soft text-[#5223E0]" : "text-body hover:bg-canvas",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- calendar */

type VendorRow = { key: string; name: string; payouts: PayoutView[] };

function Calendar({
  payouts,
  from,
  today,
  days,
  canEdit,
  onOpen,
  onMove,
}: {
  payouts: PayoutView[];
  from: string;
  today: string;
  days: Set<number>;
  canEdit: boolean;
  onOpen: (id: string) => void;
  onMove: (p: PayoutView, date: string) => void;
}) {
  const dates = dateRange(from, WEEKS * 7);
  const to = dates[dates.length - 1];
  // The card being dragged. State draws the drop zones; the ref answers the
  // browser's dragover, which can fire before React has drawn the state.
  const [drag, setDragState] = React.useState<PayoutView | null>(null);
  const dragRef = React.useRef<PayoutView | null>(null);
  const setDrag = React.useCallback((p: PayoutView | null) => {
    dragRef.current = p;
    setDragState(p);
  }, []);
  const [over, setOver] = React.useState<string | null>(null);

  // What the window holds: everything planned inside it, and anything still
  // unpaid from before it — that goes in the Earlier column.
  const inWindow = payouts.filter(
    (p) => (p.payOn >= from && p.payOn <= to) || (p.payOn < from && (p.status === "open" || p.status === "on_hold")),
  );
  const rows: VendorRow[] = [];
  const byKey = new Map<string, VendorRow>();
  for (const p of inWindow) {
    const key = p.supplierId ?? `name:${p.payeeName.toLowerCase()}`;
    let r = byKey.get(key);
    if (!r) {
      r = { key, name: p.payeeName, payouts: [] };
      byKey.set(key, r);
      rows.push(r);
    }
    r.payouts.push(p);
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const columns = `${VENDOR_COL}px ${EARLIER_COL}px ${dates.map((d) => (isPaymentDay(d, days) ? `${PAY_COL}px` : `${OFF_COL}px`)).join(" ")}`;
  const toPay = (list: PayoutView[]) => list.filter((p) => p.status === "open" || p.status === "on_hold");
  const earlierAll = inWindow.filter((p) => p.payOn < from);
  const later = payouts.filter((p) => p.payOn > to && (p.status === "open" || p.status === "on_hold"));

  if (rows.length === 0) {
    return (
        <Empty
          title="Nothing planned in these weeks"
          body={
            later.length
              ? `${plural(later.length, "payout")} worth ${money(later.reduce((a, p) => a + p.amountPaise, 0))} ${later.length === 1 ? "is" : "are"} planned after ${shortDate(to)} — move the calendar on to see ${later.length === 1 ? "it" : "them"}.`
              : "Purchases appear as soon as the register has a rate for them."
          }
        />
    );
  }

  const droppable = (p: PayoutView | null, rowKey: string, date: string) =>
    !!p && (p.supplierId ?? `name:${p.payeeName.toLowerCase()}`) === rowKey && !moveRefusal(date, today, days, p.status);

  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <div className="max-h-[calc(100vh-330px)] min-h-[320px] overflow-auto">
        <div className="grid w-max" style={{ gridTemplateColumns: columns }}>
          {/* ---------------------------------------------------- header */}
          <div className="sticky top-0 left-0 z-30 flex h-14 items-end border-r border-b border-line bg-canvas px-3 pb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Vendor · {rows.length}
          </div>
          <HeaderDay label="Overdue" sub="—" list={toPay(earlierAll)} tone="danger" />
          {dates.map((d) => {
            const pay = isPaymentDay(d, days);
            const wd = weekdayOf(d);
            if (!pay)
              return (
                <div
                  key={d}
                  title={`${WEEKDAY_NAMES[wd - 1]} ${shortDate(d)} — no payments go out`}
                  className={cx(
                    "sticky top-0 z-20 flex h-14 flex-col items-center justify-end border-b border-line bg-[repeating-linear-gradient(135deg,var(--color-canvas),var(--color-canvas)_4px,var(--color-divider)_4px,var(--color-divider)_5px)] pb-2 text-[10px] text-muted",
                    wd === 1 && "border-l border-l-line-strong",
                  )}
                >
                  <span>{WEEKDAY_SHORT[wd - 1].slice(0, 2)}</span>
                  <span>{Number(d.slice(8))}</span>
                </div>
              );
            const list = payouts.filter((p) => p.payOn === d);
            return (
              <HeaderDay
                key={d}
                label={`${WEEKDAY_SHORT[wd - 1]} ${shortDate(d)}`}
                list={toPay(list)}
                paid={list.filter((p) => p.status === "paid")}
                isToday={d === today}
                past={d < today}
                weekStart={wd === 1}
              />
            );
          })}

          {/* ------------------------------------------------------ rows */}
          {rows.map((r, i) => {
            const owed = toPay(r.payouts).reduce((a, p) => a + p.amountPaise, 0);
            const stripe = i % 2 === 1;
            return (
              <React.Fragment key={r.key}>
                <div
                  className={cx(
                    "sticky left-0 z-10 flex min-h-[76px] flex-col justify-center border-r border-b border-divider px-3 py-2",
                    stripe ? "bg-canvas" : "bg-surface",
                  )}
                >
                  <span className="truncate text-sm font-medium text-ink" title={r.name}>
                    {r.name}
                  </span>
                  <span className="text-[12px] text-muted tabular-nums">
                    {owed ? money(owed) : "Settled"}
                  </span>
                </div>
                <div className={cx("border-r border-b border-divider p-1.5", stripe ? "bg-canvas" : "bg-surface")}>
                  {r.payouts
                    .filter((p) => p.payOn < from)
                    .map((p) => (
                      <PayoutCard key={p.id} p={p} today={today} canEdit={canEdit} onOpen={onOpen} onDrag={setDrag} showDate />
                    ))}
                </div>
                {dates.map((d) => {
                  const pay = isPaymentDay(d, days);
                  const cellKey = `${r.key}|${d}`;
                  const can = droppable(drag, r.key, d);
                  return (
                    <div
                      key={d}
                      data-day={d}
                      onDragOver={(e) => {
                        if (!droppable(dragRef.current, r.key, d)) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (over !== cellKey) setOver(cellKey);
                      }}
                      onDragLeave={() => over === cellKey && setOver(null)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setOver(null);
                        const p = dragRef.current;
                        setDrag(null);
                        if (p) onMove(p, d);
                      }}
                      className={cx(
                        "border-b border-divider",
                        weekdayOf(d) === 1 && "border-l border-l-line-strong",
                        pay ? "p-1.5" : "bg-[repeating-linear-gradient(135deg,transparent,transparent_4px,var(--color-divider)_4px,var(--color-divider)_5px)]",
                        pay && (stripe ? "bg-canvas" : "bg-surface"),
                        pay && d < today && "bg-canvas/80",
                        d === today && "bg-brand-soft/40",
                        drag && can && "outline-1 -outline-offset-4 outline-brand/40 outline-dashed",
                        over === cellKey && "bg-brand-soft outline-2 outline-brand outline-solid",
                      )}
                    >
                      {pay
                        ? r.payouts
                            .filter((p) => p.payOn === d)
                            .map((p) => <PayoutCard key={p.id} p={p} today={today} canEdit={canEdit} onOpen={onOpen} onDrag={setDrag} />)
                        : null}
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}

          {/* ---------------------------------------------------- totals */}
          <div className="sticky bottom-0 left-0 z-30 flex h-10 items-center border-t border-r border-line bg-canvas px-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Total
          </div>
          <FootCell list={toPay(earlierAll)} />
          {dates.map((d) =>
            isPaymentDay(d, days) ? (
              <FootCell key={d} list={toPay(payouts.filter((p) => p.payOn === d))} weekStart={weekdayOf(d) === 1} />
            ) : (
              <div key={d} className={cx("sticky bottom-0 z-20 border-t border-line bg-canvas", weekdayOf(d) === 1 && "border-l border-l-line-strong")} />
            ),
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-[12px] text-muted">
        <Legend tone="overdue" label="Overdue" />
        <Legend tone="today" label="Due today" />
        <Legend tone="late" label="After due date" />
        <Legend tone="upcoming" label="Scheduled" />
        <Legend tone="held" label="On hold" />
        <Legend tone="paid" label="Paid" />
        {later.length ? (
          <span className="ml-auto">
            After {shortDate(to)}: {money(later.reduce((a, p) => a + p.amountPaise, 0))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function HeaderDay({
  label,
  sub,
  list,
  paid = [],
  isToday,
  past,
  weekStart: monday,
  tone,
}: {
  label: string;
  sub?: string;
  list: PayoutView[];
  paid?: PayoutView[];
  isToday?: boolean;
  past?: boolean;
  weekStart?: boolean;
  tone?: "danger";
}) {
  const total = list.reduce((a, p) => a + p.amountPaise, 0);
  return (
    <div
      className={cx(
        "sticky top-0 z-20 flex h-14 flex-col justify-end border-b border-line px-2.5 pb-1.5",
        isToday ? "bg-brand-soft" : "bg-canvas",
        monday && "border-l border-l-line-strong",
        tone === "danger" && "border-r border-r-line",
      )}
    >
      <span className={cx("text-[12px] font-semibold", isToday ? "text-[#5223E0]" : past ? "text-muted" : "text-ink")}>
        {isToday ? `Today · ${label.split(" ").slice(1).join(" ")}` : label}
      </span>
      <span className={cx("text-[11px] tabular-nums", tone === "danger" && list.length ? "text-danger" : "text-muted")}>
        {list.length ? `${list.length} · ${moneyShort(total)}` : (sub ?? "—")}
        {paid.length ? <span className="text-success"> · ✓ {paid.length}</span> : null}
      </span>
    </div>
  );
}

function FootCell({ list, weekStart: monday }: { list: PayoutView[]; weekStart?: boolean }) {
  const total = list.reduce((a, p) => a + p.amountPaise, 0);
  return (
    <div
      className={cx(
        "sticky bottom-0 z-20 flex h-10 items-center border-t border-line bg-canvas px-2.5 text-[13px] font-semibold text-ink tabular-nums",
        monday && "border-l border-l-line-strong",
      )}
    >
      {list.length ? money(total) : <span className="font-normal text-muted">—</span>}
    </div>
  );
}

function Legend({ tone, label }: { tone: keyof typeof TONE_SKIN; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx("block h-2 w-2 rounded-full", TONE_SKIN[tone].dot)} />
      {label}
    </span>
  );
}

function PayoutCard({
  p,
  today,
  canEdit,
  onOpen,
  onDrag,
  showDate,
}: {
  p: PayoutView;
  today: string;
  canEdit: boolean;
  onOpen: (id: string) => void;
  onDrag: (p: PayoutView | null) => void;
  showDate?: boolean;
}) {
  const tone = toneOf(p, today);
  const movable = canEdit && (p.status === "open" || p.status === "on_hold");
  const tags = [
    p.source === "purchase" ? `PR ${p.prNumber}` : "Manual",
    p.poNumber != null ? `PO ${p.poNumber}` : null,
  ].filter(Boolean);
  return (
    <button
      type="button"
      draggable={movable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", p.id);
        onDrag(p);
      }}
      onDragEnd={() => onDrag(null)}
      onClick={() => onOpen(p.id)}
      title={`${p.payeeName} — ${money(p.amountPaise)}\n${sourceWords(p)}${p.reference ? `\nBill ${p.reference}` : ""}\nDue ${shortDate(p.dueDate)}`}
      className={cx(
        "mb-1 block w-full rounded-[4px] border border-l-[3px] border-line px-2 py-1.5 text-left last:mb-0 hover:shadow-[0_1px_4px_rgba(22,22,22,0.12)]",
        TONE_SKIN[tone].card,
        movable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
      )}
    >
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-[13px] font-semibold text-ink tabular-nums">{money(p.amountPaise)}</span>
        {p.invoices.length ? (
          <span className="text-[10px] font-medium text-muted" title={p.invoices.map((i) => i.kind).join(", ")}>
            📎{p.invoices.length}
          </span>
        ) : null}
      </div>
      <div className="truncate text-[11px] text-muted">
        {showDate ? `${shortDate(p.payOn)} · ` : ""}
        {tags.join(" · ")}
      </div>
      {p.status === "on_hold" ? <div className="text-[10px] font-medium text-muted uppercase">On hold</div> : null}
    </button>
  );
}

/* -------------------------------------------------------------------- list */

function PayoutList({ payouts, today, onOpen }: { payouts: PayoutView[]; today: string; onOpen: (id: string) => void }) {
  const rows = [...payouts].sort((a, b) => a.payOn.localeCompare(b.payOn) || a.payeeName.localeCompare(b.payeeName));
  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <Table
        minWidth={1280}
        head={
          <>
            <HeadCell width={110}>Payment date</HeadCell>
            <HeadCell width={220}>Vendor</HeadCell>
            <HeadCell width={200}>Description</HeadCell>
            <HeadCell width={90}>PO</HeadCell>
            <HeadCell width={130}>Invoice / ref.</HeadCell>
            <HeadCell width={200}>Invoices</HeadCell>
            <HeadCell width={90}>Due date</HeadCell>
            <HeadCell width={120} align="right">
              Amount
            </HeadCell>
            <HeadCell width={120}>Status</HeadCell>
          </>
        }
      >
        {rows.map((p, i) => {
          const tone = toneOf(p, today);
          return (
            <Row key={p.id} striped={i % 2 === 1} onClick={() => onOpen(p.id)}>
              <Cell className={cx(tone === "overdue" && "font-medium text-danger")}>
                {WEEKDAY_SHORT[weekdayOf(p.payOn) - 1]} {shortDate(p.payOn)}
              </Cell>
              <Cell truncate={220} className="font-medium text-ink">
                {p.payeeName}
              </Cell>
              <Cell truncate={200}>{sourceWords(p)}</Cell>
              <Cell>{p.poNumber != null ? `PO ${p.poNumber}` : <span className="text-muted">—</span>}</Cell>
              <Cell truncate={130}>{p.reference ?? "—"}</Cell>
              <Cell>
                {p.invoices.length ? (
                  <span className="flex max-w-[200px] flex-wrap gap-1 whitespace-normal">
                    {p.invoices.map((inv) => (
                      <span key={inv.id} className="rounded-[3px] bg-brand-soft px-1.5 text-[11px] font-medium text-[#5223E0]">
                        {inv.kind}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="text-muted">none</span>
                )}
              </Cell>
              <Cell>{shortDate(p.dueDate)}</Cell>
              <Cell align="right" className="font-semibold text-ink">
                {money(p.status === "paid" ? (p.paidAmountPaise ?? p.amountPaise) : p.amountPaise)}
              </Cell>
              <Cell>
                <StatusPill tone={tone} />
              </Cell>
            </Row>
          );
        })}
      </Table>
    </div>
  );
}
