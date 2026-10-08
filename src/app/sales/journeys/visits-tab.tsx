"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { money } from "@/lib/format";
import { addDays } from "@/lib/business-date";
import type { Salesman, VisitRow } from "@/lib/services/sales-service";
import { Thumb, VisitDetail, VisitState, clock, useVisitActions } from "./visit-parts";
import {
  Cell,
  Empty,
  FilterChips,
  HeadCell,
  MetricRow,
  Row,
  RowMenu,
  SortHead,
  Table,
} from "@/components/console/parts";
import { CustomerName } from "@/components/console/customer-name";
import { readSort, sortHref, sortRows, type SortColumns } from "@/components/console/sort";
import { VISIT_OUTCOME_LABEL, label } from "@/components/console/words";

/**
 * The Visit log tab — what used to be the Visits screen, now a tab of Journeys
 * & visits. Every visit logged on a day, for the team or one salesman: how long
 * he stayed, whether the phone agreed he was at the shop, and the row menu to
 * stand behind a visit, ask about it, or answer a pin he questioned. The row
 * opens the notes, photographs and voice note. Each visit links to his whole
 * day, where it is read against the route it belonged to.
 */
export function VisitsTab({
  day,
  longDay,
  all: everyone,
  show,
  mismatchThresholdM,
  team,
  salesmanId,
  stay = "",
}: {
  day: string;
  longDay: string;
  all: VisitRow[];
  show: string;
  mismatchThresholdM: number;
  team: Salesman[];
  /** Narrowed to one salesman, or "" for the whole team. */
  salesmanId: string;
  /** Set when this is one salesman's log inside his modal: links keep it there and nobody else can be picked. */
  stay?: string;
}) {
  const router = useRouter();
  const actions = useVisitActions();
  /* Narrowed in the browser: the day's list for the team is already here,
     and the counts on the chips should follow whoever is picked. */
  const all = salesmanId ? everyone.filter((v) => v.salesmanId === salesmanId) : everyone;
  const base = `/sales/journeys?tab=visits${salesmanId ? `&salesman=${salesmanId}` : ""}${stay}`;
  /* Which visits are opened out. A set, so a manager comparing two visits to
     one shop can have both open at once. */
  const [open, setOpen] = React.useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const unverified = all.filter((v) => !v.verified);
  const offPlan = all.filter((v) => !v.wasPlanned);
  const rows = show === "unverified" ? unverified : show === "offplan" ? offPlan : all;

  const minutes = all.reduce((n, v) => n + (v.durationSeconds ?? 0), 0) / 60;

  /*
   * THE SORT IS A URL HERE, THOUGH THIS IS A CLIENT COMPONENT.
   *
   * `sort.ts` argues for a link rather than component state so a manager who
   * has sorted to what is worst can send that to somebody, and the argument
   * does not stop applying because the screen also holds a modal. The day and
   * the filter chips on this screen are ALREADY search params — the chips are
   * plain links and the page re-reads `day` on the server — so holding the
   * sort in React state instead would give one table two kinds of memory: two
   * of its three controls survive a reload and the third does not.
   *
   * It is read with `useSearchParams` rather than taken as a prop because the
   * page component hands this screen `day` and `show` and nothing else, and a
   * sort that is display-only has no business making the server re-run
   * `visitsList` to answer for it.
   *
   * Sorting is display-only, which is the half worth stating: the four figures
   * above — the count, the unverified, the off-plan and the time in shops —
   * are all counted over `all` and never over the sorted copy, so none of them
   * moves when a column is clicked.
   */
  const search = useSearchParams();
  const sort = readSort(
    { sort: search.get("sort") ?? undefined, dir: search.get("dir") ?? undefined },
    COLUMNS,
  );
  const sorted = sortRows(rows, sort, COLUMNS);
  /* `text` rather than `label`, which is the name of the outcome resolver this
     file already imports — one shadowing the other would compile and read as a
     mistake to whoever came next. */
  const head = (key: string, text: string, width?: number, align?: "left" | "right") => (
    <SortHead
      width={width}
      align={align}
      href={sortHref("/sales/journeys", sort, key, `tab=visits&day=${day}&show=${show}${salesmanId ? `&salesman=${salesmanId}` : ""}${stay}`)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {text}
    </SortHead>
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-[6px] border border-line bg-surface px-4 py-3">
        <div className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Day
          </span>
          <div className="flex items-center gap-1 text-[13px]">
            <Link
              href={`${base}&day=${addDays(day, -1)}&show=${show}`}
              className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
              aria-label="The day before"
            >
              ←
            </Link>
            <input
              type="date"
              value={day}
              onChange={(e) => e.target.value && router.push(`${base}&day=${e.target.value}&show=${show}`)}
              aria-label={`Visits on ${longDay}`}
              className="h-[30px] rounded-[4px] border border-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-brand"
            />
            <Link
              href={`${base}&day=${addDays(day, 1)}&show=${show}`}
              className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
              aria-label="The day after"
            >
              →
            </Link>
          </div>
        </div>
        {stay ? null : (
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
            Salesman
          </span>
          <select
            value={salesmanId}
            onChange={(e) =>
              router.push(
                `/sales/journeys?tab=visits&day=${day}&show=${show}${e.target.value ? `&salesman=${e.target.value}` : ""}`,
              )
            }
            className="h-[30px] min-w-[190px] rounded-[4px] border border-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-brand"
          >
            <option value="">The whole team</option>
            {team.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        )}
        <div className="flex-1" />
        {salesmanId ? (
          <Link
            href={`/sales/journeys?tab=salesman&salesman=${salesmanId}&month=${day.slice(0, 7)}&open=${day}${stay}`}
            className="text-[13px] text-brand no-underline hover:underline"
          >
            His plan for this day →
          </Link>
        ) : null}
      </div>

      <MetricRow
        metrics={[
          { label: "Visits", value: String(all.length) },
          {
            label: "Unverified",
            value: String(unverified.length),
            sub: unverified.length ? "each has a reason" : "all check out",
            tone: unverified.length ? "warn" : "success",
          },
          {
            label: "Off plan",
            value: String(offPlan.length),
            sub: offPlan.length ? "ordinary, but worth reading" : undefined,
          },
          {
            label: "Time in shops",
            value: minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes)}m`,
            sub: all.length ? `about ${Math.round(minutes / all.length)} min a visit` : undefined,
          },
        ]}
      />

      <FilterChips
        current={show}
        options={[
          { key: "all", href: `${base}&day=${day}&show=all`, label: "Every visit", count: all.length },
          { key: "unverified", href: `${base}&day=${day}&show=unverified`, label: "Could not be verified", count: unverified.length },
          { key: "offplan", href: `${base}&day=${day}&show=offplan`, label: "Off the plan", count: offPlan.length },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title={
            show === "unverified"
              ? "Every visit checks out"
              : show === "offplan"
                ? "Everybody stayed on plan"
                : "No visits logged"
          }
          body={
            show === "all"
              ? "Nothing has come off a handset for this day. A visit reaches the office on the next sync, so a salesman with no signal will appear later rather than not at all."
              : "Nothing here is waiting on a word from you."
          }
        />
      ) : (
        <Table
          minWidth={1360}
          head={
            <>
              {head("salesman", "Salesman", 170)}
              {head("customer", "Customer", 200)}
              {head("in", "At", 80)}
              {head("duration", "Inside", 80, "right")}
              {head("distance", "From shop", 110, "right")}
              {head("outcome", "Outcome", 150)}
              <HeadCell align="right" width={80}>Photos</HeadCell>
              {head("value", "Value", 130, "right")}
              <HeadCell>State</HeadCell>
              <HeadCell width={44} />
            </>
          }
        >
          {sorted.map((v, i) => (
            <React.Fragment key={v.id}>
            <Row striped={i % 2 === 1} selected={open.has(v.id)} onClick={() => toggle(v.id)}>
              <Cell truncate={170} onClick={(e) => e.stopPropagation()}>
                <Link
                  href={`/sales/journeys?tab=salesman&salesman=${v.salesmanId}&month=${day.slice(0, 7)}&open=${day}${stay}`}
                  className="no-underline"
                >
                  {v.salesmanName}
                </Link>
              </Cell>
              <Cell truncate={200} onClick={(e) => e.stopPropagation()}>
                <CustomerName id={v.customerId} name={v.customerName} />
              </Cell>
              <Cell>{v.checkInAt ? clock(v.checkInAt) : <span className="text-muted">—</span>}</Cell>
              <Cell align="right">
                {v.durationSeconds != null ? (
                  `${Math.round(v.durationSeconds / 60)}m`
                ) : (
                  <span
                    className="text-muted"
                    title="The visit never closed — the salesman walked out of signal or did not check out."
                  >
                    open
                  </span>
                )}
              </Cell>
              <Cell
                align="right"
                className={
                  v.distanceFromShopM != null && v.distanceFromShopM > mismatchThresholdM
                    ? "font-medium text-danger"
                    : undefined
                }
              >
                {v.distanceFromShopM != null ? `${v.distanceFromShopM} m` : <span className="text-muted">—</span>}
              </Cell>
              <Cell>{label(VISIT_OUTCOME_LABEL, v.outcome)}</Cell>
              <Cell align="right" onClick={(e) => e.stopPropagation()}>
                {v.shopPhotoId || v.custPhotoId ? (
                  <span className="inline-flex gap-1">
                    {[v.shopPhotoId, v.custPhotoId].filter(Boolean).map((id) => (
                      <Thumb key={id} id={id!} alt={`${v.customerName}, visit photograph`} size={28} />
                    ))}
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </Cell>
              <Cell align="right">
                {Number(v.orderValuePaise) ? (
                  money(v.orderValuePaise)
                ) : (
                  <span className="text-muted">—</span>
                )}
              </Cell>
              <Cell truncate={340}>
                <VisitState v={v} />
              </Cell>
              <Cell align="right" onClick={(e) => e.stopPropagation()}>
                <RowMenu
                  items={[
                    ...actions.items(v),
                    {
                      label: "His whole day",
                      href: `/sales/journeys?tab=salesman&salesman=${v.salesmanId}&month=${day.slice(0, 7)}&open=${day}${stay}`,
                    },
                  ]}
                />
              </Cell>
            </Row>
            {open.has(v.id) ? (
              <tr className="border-b border-divider bg-canvas">
                <td colSpan={10} className="px-4 py-3">
                  <VisitDetail v={v} />
                </td>
              </tr>
            ) : null}
            </React.Fragment>
          ))}
        </Table>
      )}

      {actions.modal}
    </div>
  );
}

const COLUMNS: SortColumns<VisitRow> = {
  salesman: (v) => v.salesmanName,
  customer: (v) => v.customerName,
  /* `visitsList` runs raw SQL through `db.execute`, which hands back a STRING
     where the type says Date — the same reading the pin-correction pill makes
     two hundred lines up. `new Date` takes either, and a full ISO instant
     carries its own zone, so nothing here has to name one. */
  in: (v) => (v.checkInAt ? new Date(v.checkInAt).getTime() : null),
  /* A visit that never closed has no duration, and it sorts LAST under both
     directions rather than reading as the longest one. He walked out of signal
     or forgot to check out; neither is a long visit, and floating those rows to
     the top of "longest first" would answer the question with the only rows
     that cannot answer it. The open ones are worth finding, and the Unverified
     chip is where that is asked. */
  duration: (v) => v.durationSeconds,
  /* Null is a visit there was nothing to measure against — a shop with no pin,
     or a check-in with no fix — and it is not a distance of zero. Zero would
     read as having stood exactly on the doorway, which is the most reassuring
     answer on the column and the one row nobody established. */
  distance: (v) => v.distanceFromShopM,
  /* The words on the screen rather than the stored code, so an alphabetical
     sort puts the rows in the order somebody reading the column sees. */
  outcome: (v) => label(VISIT_OUTCOME_LABEL, v.outcome),
  /* Zero is a real answer here, unlike a missing duration: a visit with no
     order is a visit where nothing was bought, which is a fact and not an
     absence. It is drawn as a dash and it sorts as the nothing it is. */
  value: (v) => Number(v.orderValuePaise),
};
